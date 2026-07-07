import { getDB, getEmbeddingDB } from "../../db/src/database";
import { prepareRawMessageEventDeletion } from "../../db/src/memory-events";
import { normalizeLocalDate } from "../../domain/src/local-date";
import { normalizeOwnerId } from "../../domain/src/owner";
import type { AliasContext } from "../../domain/src/family";
import { processMessage, type PipelineResult } from "../../pipeline/src/pipeline";
import { runDailyArchive, type RunDailyArchiveResult } from "../../archive/src/daily";
import { maybeCreateEchoCare } from "../../care/src/echo";
import { chatWithMemory, getConversationTurns, recordConversationTurn, type ChatResult, type ConversationTurn } from "./conversation";
import { logWithContextualReply, type ContextualLogResult } from "./contextual-response";
import { routeMessage, type ConversationMode } from "./intent-router";
import { hashId, logError, logInfo, logWarn, safeErrorMessage, textLogFields } from "../../observability/src/logging";

export type ProductCommandIntent = ConversationMode;

export interface HandleProductMessageInput {
  text: string;
  owner_id?: string;
  user_id?: string;
  /** 家庭共享记忆：召回扇出的家庭成员 owner 池集合。缺省=仅说话人自己。 */
  scope_owner_ids?: string[];
  date?: string;
  limit?: number;
  speaker_id?: string;
  speaker_label?: string;
  aliasContext?: AliasContext;
  /** true = text 是图片的自动转写（不是用户打的字）：对话层打标、回复 LLM 按「发来一张照片」理解 */
  image_transcript?: boolean;
}

export interface CorrectionResult {
  corrected: boolean;
  old_text: string;
  new_text: string;
  target_turn_ids: string[];
  deleted_event_count: number;
  pipeline: PipelineResult;
}

export interface UndoResult {
  undone: boolean;
  target_turn_ids: string[];
  deleted_event_count: number;
  deleted_archive_count: number;
}

export type ProductMessageResult =
  | { intent: "log"; reply: string; result: ContextualLogResult }
  | { intent: "recall"; reply: string; events: ChatResult["recalled"]; result: ChatResult }
  | { intent: "recap"; reply: string; events: ChatResult["recalled"]; result: ChatResult }
  | { intent: "reflect"; reply: string; events: ChatResult["recalled"]; result: ChatResult }
  | { intent: "chat"; reply: string; events: ChatResult["recalled"]; result: ChatResult }
  | { intent: "archive"; reply: string; result: RunDailyArchiveResult }
  | { intent: "undo"; reply: string; result: UndoResult }
  | { intent: "correct"; reply: string; result: CorrectionResult };

export async function handleProductMessage(input: HandleProductMessageInput): Promise<ProductMessageResult> {
  const text = input.text?.trim();
  if (!text) throw new Error("text is required");
  const ownerId = normalizeOwnerId(input.owner_id ?? input.user_id);
  if (!ownerId) throw new Error("owner_id is required");
  const date = normalizeLocalDate(input.date);
  const startedAt = Date.now();
  const baseLog = {
    owner_hash: hashId(ownerId),
    speaker_hash: hashId(input.speaker_id),
    speaker_label: input.speaker_label,
    date,
    ...textLogFields("text", text),
  };
  logInfo("product_loop_start", baseLog);

  try {
    const baseRoute = routeMessage(text);

    // 显式命令（记/查/改/总结/撤销）走确定性快路，绕过所有 LLM 意图判断。
    if (baseRoute.matchedBy === "command") {
      const parsed = { intent: baseRoute.mode, text: baseRoute.text };
      logInfo("product_loop_route", {
        ...baseLog,
        intent: parsed.intent,
        routed_text_len: parsed.text.length,
        matched_by: baseRoute.matchedBy,
        confidence: baseRoute.confidence,
        recall_depth: baseRoute.recallDepth,
      });

      if (parsed.intent === "archive") {
        const result = await runDailyArchive({ owner_id: ownerId, date, force: true });
        const archive = result.archives[0];
        const reply = archive?.skipped
          ? `今天还没有可归档内容：${archive.reason || "无内容"}`
          : `今天已归档：${archive?.turns ?? 0} 条对话，沉淀 ${archive?.events_stored ?? 0} 条记忆事件。`;
        return finishProductLoop({ intent: "archive", reply, result }, startedAt, baseLog);
      }

      if (parsed.intent === "undo") {
        const result = undoLatestProductMemory({ owner_id: ownerId, date });
        const reply = result.undone
          ? `已撤销最近一次记录，并删除相关 ${result.deleted_event_count} 条长期记忆事件。`
          : "没有找到可撤销的最近记录。";
        return finishProductLoop({ intent: "undo", reply, result }, startedAt, baseLog);
      }

      if (parsed.intent === "correct") {
        const result = await correctLatestProductMemory({
          owner_id: ownerId,
          date,
          newText: parsed.text,
          speaker_id: input.speaker_id,
          speaker_label: input.speaker_label,
          aliasContext: input.aliasContext,
        });
        const reply = result.corrected
          ? `已按新内容重记：${result.new_text}（删除旧事件 ${result.deleted_event_count} 条，新生成 ${result.pipeline.stored} 条）`
          : "没有找到可修正的最近记录。";
        return finishProductLoop({ intent: "correct", reply, result }, startedAt, baseLog);
      }

      if (parsed.intent === "recall") {
        const result = await chatWithMemory({ text: parsed.text, owner_id: ownerId, scope_owner_ids: input.scope_owner_ids, date, limit: input.limit, mode: "recall", recallDepth: baseRoute.recallDepth });
        return finishProductLoop({ intent: "recall", reply: result.reply, events: result.recalled, result }, startedAt, baseLog);
      }

      if (parsed.intent === "log") {
        const result = await logWithContextualReply({
          text: parsed.text,
          owner_id: ownerId,
          scope_owner_ids: input.scope_owner_ids,
          date,
          force: true,
          limit: input.limit,
          speaker_id: input.speaker_id,
          speaker_label: input.speaker_label,
          aliasContext: input.aliasContext,
        });
        scheduleEchoCare(result.pipeline, ownerId, input.scope_owner_ids, date, baseLog);
        return finishProductLoop({ intent: "log", reply: result.reply, result }, startedAt, baseLog);
      }

      const result = await chatWithMemory({ text: parsed.text, owner_id: ownerId, scope_owner_ids: input.scope_owner_ids, date, limit: input.limit, mode: "chat", recallDepth: baseRoute.recallDepth });
      return finishProductLoop({ intent: "chat", reply: result.reply, events: result.recalled, result }, startedAt, baseLog);
    }

    // 自然语言统一路径：不再串行跑 intent LLM。
    // (1) 提取/分类/写库异步执行，不挡用户回复；classify 自己判断是否值得入库（"记"才写，"查/闲聊"自动跳过）。
    // (2) 一次 reply LLM（带 recall 工具 + L1/L2/L3 背景）自己判断"记/查/聊"并回复。
    logInfo("product_loop_route", {
      ...baseLog,
      intent: "auto",
      routed_text_len: text.length,
      matched_by: "unified",
      confidence: 1,
      recall_depth: "auto",
    });

    // 把今天已发生的对话喂给分类器：让它能判断「这条是不是对助手追问的简短延续回应」，
    // 而不是孤立地把闲聊碎片（"崩溃。。。"/"溜到地上"）当成独立日记抽取。
    const recentDialogue = buildRecentDialogueForClassify(ownerId, date);
    const storePromise = processMessage(text, {
      ownerId,
      userId: ownerId,
      speakerId: input.speaker_id,
      speakerLabel: input.speaker_label,
      aliasContext: input.aliasContext,
      eventDate: date,
      embedNewEvents: false,
      combinedExtract: true,
      recentDialogue,
    });
    storePromise
      .then(p => {
        logInfo("product_loop_async_store", {
          ...baseLog,
          stored: p.stored,
          events_count: p.events.length,
          meaningful: p.meaningful,
          skipped: p.skipped,
        });
        scheduleEchoCare(p, ownerId, input.scope_owner_ids, date, baseLog);
      })
      .catch(error => logWarn("product_loop_async_store_error", {
        ...baseLog,
        error: safeErrorMessage(error),
      }));

    const result = await chatWithMemory({ text, owner_id: ownerId, scope_owner_ids: input.scope_owner_ids, date, limit: input.limit, mode: "auto", image_transcript: input.image_transcript });

    // 回填：若异步写库判定这条是“记”（meaningful 且确实存了事件），把这条 user turn 的 source/metadata
    // 对齐到与显式“记:”一致的 log 语义，让“我上条日志记好了吗”能查到。后台完成，不阻塞回复返回。
    const userTurnId = result.user_turn.id;
    void storePromise
      .then(p => {
        // 只有真正记成日记（diary）才把这条 user turn 升格为 log；
        // 对话延续/命令/噪声即使侥幸抽到事件也不升格，避免「我上条日志记好了吗」翻出闲聊。
        if (!p.meaningful || p.skipped || p.stored === 0 || p.category !== "diary") return;
        getDB().prepare("UPDATE conversation_turns SET source = 'log', metadata = ? WHERE id = ?").run(
          JSON.stringify({
            mode: "log_with_contextual_reply",
            pipeline_message_id: p.message_id,
            current_event_ids: p.events.map(event => event.id).filter(Boolean),
            // 保留图片转写标记：回填 metadata 是整体覆盖，不带上会导致前端把转写又当成用户原话
            ...(input.image_transcript ? { image_transcript: true } : {}),
          }),
          userTurnId,
        );
      })
      .catch(error => logWarn("product_loop_turn_backfill_error", {
        ...baseLog,
        error: safeErrorMessage(error),
      }));

    return finishProductLoop({ intent: "chat", reply: result.reply, events: result.recalled, result }, startedAt, baseLog);
  } catch (error) {
    logError("product_loop_error", {
      ...baseLog,
      duration_ms: Date.now() - startedAt,
      error: safeErrorMessage(error),
    });
    throw error;
  }
}

/**
 * 回声关怀（后台，不挡回复）：这条真记成了日记才值得联想旧事。
 * 显式"记："路径 force 存储不过分类闸门，只看 stored；统一路径的 category 闸门在 pipeline 里已判过。
 */
function scheduleEchoCare(
  pipeline: PipelineResult,
  ownerId: string,
  scopeOwnerIds: string[] | undefined,
  date: string,
  baseLog: Record<string, unknown>,
): void {
  if (pipeline.skipped || pipeline.stored === 0 || pipeline.events.length === 0) return;
  if (pipeline.classified && pipeline.category !== "diary") return;
  void maybeCreateEchoCare({ owner_id: ownerId, scope_owner_ids: scopeOwnerIds, events: pipeline.events, date })
    .catch(error => logWarn("product_loop_echo_error", { ...baseLog, error: safeErrorMessage(error) }));
}

function finishProductLoop<T extends ProductMessageResult>(
  result: T,
  startedAt: number,
  baseLog: Record<string, unknown>,
): T {
  logInfo("product_loop_done", {
    ...baseLog,
    intent: result.intent,
    duration_ms: Date.now() - startedAt,
    ...summarizeProductResult(result),
    ...textLogFields("reply", result.reply),
  });
  return result;
}

function summarizeProductResult(result: ProductMessageResult): Record<string, unknown> {
  const pipeline = productPipeline(result);
  const directEvents = "events" in result ? result.events.length : undefined;
  const recalled = result.intent === "log"
    ? result.result.context.recalled.length
    : directEvents;
  const archiveEventsStored = result.intent === "archive"
    ? result.result.archives.reduce((sum, archive) => sum + archive.events_stored, 0)
    : undefined;

  return {
    stored: pipeline?.stored,
    events_count: pipeline ? pipeline.events.length : directEvents,
    recalled_count: recalled,
    archive_count: result.intent === "archive" ? result.result.archives.length : undefined,
    archive_events_stored: archiveEventsStored,
    deleted_event_count: result.intent === "undo" || result.intent === "correct" ? result.result.deleted_event_count : undefined,
    corrected: result.intent === "correct" ? result.result.corrected : undefined,
  };
}

function productPipeline(result: ProductMessageResult): PipelineResult | undefined {
  if (result.intent === "log") return result.result.pipeline;
  if (result.intent === "correct") return result.result.pipeline;
  return undefined;
}

/**
 * 取当天最近几轮对话，拼成喂给分类器的上下文。
 * 当前这条 user 消息此刻尚未落库（chatWithMemory 才记录），所以这里取到的是「之前的」对话，
 * 正好用于判断这条消息是不是对助手上一句追问的简短延续回应。
 */
function buildRecentDialogueForClassify(ownerId: string, date: string): string {
  const turns = getConversationTurns({ owner_id: ownerId, date, limit: 12 });
  return turns
    .slice(-6)
    .map(turn => {
      const who = turn.role === "user" ? "用户" : turn.role === "assistant" ? "助手" : "系统";
      const content = String(turn.content ?? "").replace(/\s+/g, " ").trim();
      if (!content) return "";
      return `${who}: ${content.length > 120 ? `${content.slice(0, 119)}…` : content}`;
    })
    .filter(Boolean)
    .join("\n");
}

/** 同步规则解析：显式命令入口与测试使用；自然语言意图识别走 routeMessageSmart。 */
export function parseProductCommand(raw: string): { intent: ProductCommandIntent; text: string } {
  const route = routeMessage(raw);
  return { intent: route.mode, text: route.text };
}

export function undoLatestProductMemory(input: { owner_id?: string; user_id?: string; date?: string }): UndoResult {
  const ownerId = normalizeOwnerId(input.owner_id ?? input.user_id);
  if (!ownerId) throw new Error("owner_id is required");
  const date = normalizeLocalDate(input.date);
  const turn = findLatestUserLogTurn(ownerId, date);
  if (!turn) return { undone: false, target_turn_ids: [], deleted_event_count: 0, deleted_archive_count: 0 };

  const db = getDB();
  const metadata = turn.metadata || {};
  const messageId = typeof metadata.pipeline_message_id === "string" ? metadata.pipeline_message_id : turn.id;
  const eventIds = Array.isArray(metadata.current_event_ids) ? metadata.current_event_ids.filter((id): id is string => typeof id === "string") : [];
  const assistantTurnIds = getAssistantTurnIdsForPipeline(messageId, ownerId);
  const targetTurnIds = [turn.id, ...assistantTurnIds];

  const deletedEventCount = countEventsForMessage(messageId, ownerId, eventIds);
  let deletedArchiveCount = 0;
  const tx = db.transaction(() => {
    unarchiveTurnsForDate(ownerId, date);
    deletedArchiveCount = deleteDailyArchiveAndEvents(ownerId, date);
    prepareRawMessageEventDeletion(db)(messageId, ownerId);
    deleteEmbeddingsForEvents(eventIds);
    deletePipelineStatus(messageId);
    deleteTurns(targetTurnIds);
  });
  tx();

  return { undone: true, target_turn_ids: targetTurnIds, deleted_event_count: deletedEventCount, deleted_archive_count: deletedArchiveCount };
}

export async function correctLatestProductMemory(input: {
  owner_id?: string;
  user_id?: string;
  date?: string;
  newText: string;
  speaker_id?: string;
  speaker_label?: string;
  aliasContext?: AliasContext;
}): Promise<CorrectionResult> {
  const ownerId = normalizeOwnerId(input.owner_id ?? input.user_id);
  if (!ownerId) throw new Error("owner_id is required");
  const newText = input.newText?.trim();
  if (!newText) throw new Error("newText is required");
  const date = normalizeLocalDate(input.date);
  const turn = findLatestUserLogTurn(ownerId, date);
  if (!turn) {
    return {
      corrected: false,
      old_text: "",
      new_text: newText,
      target_turn_ids: [],
      deleted_event_count: 0,
      pipeline: await processMessage(newText, {
        ownerId,
        force: true,
        eventDate: date,
        embedNewEvents: false,
        speakerId: input.speaker_id,
        speakerLabel: input.speaker_label,
        aliasContext: input.aliasContext,
      }),
    };
  }

  const db = getDB();
  const metadata = turn.metadata || {};
  const messageId = typeof metadata.pipeline_message_id === "string" ? metadata.pipeline_message_id : turn.id;
  const oldEventIds = Array.isArray(metadata.current_event_ids) ? metadata.current_event_ids.filter((id): id is string => typeof id === "string") : [];
  const assistantTurnIds = getAssistantTurnIdsForPipeline(messageId, ownerId);
  const deletedEventCount = countEventsForMessage(messageId, ownerId, oldEventIds);

  const cleanup = db.transaction(() => {
    unarchiveTurnsForDate(ownerId, date);
    deleteDailyArchiveAndEvents(ownerId, date);
    prepareRawMessageEventDeletion(db)(messageId, ownerId);
    deleteEmbeddingsForEvents(oldEventIds);
    deletePipelineStatus(messageId);
    deleteTurns(assistantTurnIds);
  });
  cleanup();

  const pipeline = await processMessage(newText, {
    ownerId,
    userId: ownerId,
    messageId,
    force: true,
    eventDate: date,
    speakerId: input.speaker_id,
    speakerLabel: input.speaker_label,
    aliasContext: input.aliasContext,
    embedNewEvents: false,
  });
  const updatedMetadata = {
    ...metadata,
    mode: "product_correction",
    corrected_at: new Date().toISOString(),
    previous_content: turn.content,
    pipeline_message_id: pipeline.message_id,
    current_event_ids: pipeline.events.map(event => event.id).filter(Boolean),
  };
  db.prepare("UPDATE conversation_turns SET content = ?, source = ?, metadata = ?, archive_id = NULL WHERE id = ?")
    .run(newText, "log", JSON.stringify(updatedMetadata), turn.id);

  recordConversationTurn({
    content: `已修正并重记：${newText}`,
    owner_id: ownerId,
    role: "assistant",
    turn_date: date,
    source: "correction_reply",
    metadata: { pipeline_message_id: pipeline.message_id, corrected_turn_id: turn.id },
  });

  return {
    corrected: true,
    old_text: turn.content,
    new_text: newText,
    target_turn_ids: [turn.id, ...assistantTurnIds],
    deleted_event_count: deletedEventCount,
    pipeline,
  };
}

function findLatestUserLogTurn(ownerId: string, date: string): ConversationTurn | null {
  return getConversationTurns({ owner_id: ownerId, date, limit: 200, include_archived: true })
    .filter(turn => turn.role === "user" && (turn.source === "log" || turn.metadata?.mode === "log_with_contextual_reply" || turn.metadata?.mode === "product_correction"))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;
}

function getAssistantTurnIdsForPipeline(messageId: string, ownerId: string): string[] {
  const db = getDB();
  const rows = db.prepare(`
    SELECT id FROM conversation_turns
    WHERE owner_id = ?
      AND role = 'assistant'
      AND json_extract(metadata, '$.pipeline_message_id') = ?
  `).all(ownerId, messageId) as Array<{ id: string }>;
  return rows.map(row => row.id);
}

function countEventsForMessage(messageId: string, ownerId: string, eventIds: string[]): number {
  const db = getDB();
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM memory_events
    WHERE raw_message_id = ? AND COALESCE(user_id, '') = COALESCE(?, '')
  `).get(messageId, ownerId) as { c: number };
  return row.c || eventIds.length;
}

function unarchiveTurnsForDate(ownerId: string, date: string) {
  getDB().prepare("UPDATE conversation_turns SET archive_id = NULL WHERE owner_id = ? AND turn_date = ?").run(ownerId, date);
}

function deleteDailyArchiveAndEvents(ownerId: string, date: string): number {
  const db = getDB();
  const archive = db.prepare("SELECT id, event_ids FROM daily_archives WHERE owner_id = ? AND archive_date = ?")
    .get(ownerId, date) as { id: string; event_ids: string } | undefined;
  if (!archive) return 0;
  const eventIds = parseJsonArray(archive.event_ids);
  deleteEmbeddingsForEvents(eventIds);
  const deleteBySourceArchive = prepareRawMessageEventDeletion(db);
  deleteBySourceArchive(archive.id, ownerId);
  db.prepare("DELETE FROM diaries WHERE id = ?").run(`daily:${archive.id}`);
  db.prepare("DELETE FROM daily_archives WHERE id = ?").run(archive.id);
  return 1;
}

function parseJsonArray(raw?: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function deletePipelineStatus(messageId: string) {
  getDB().prepare("DELETE FROM pipeline_status WHERE message_id = ?").run(messageId);
}

function deleteEmbeddingsForEvents(eventIds: string[]) {
  if (eventIds.length === 0) return;
  try {
    const db = getEmbeddingDB();
    const stmt = db.prepare("DELETE FROM memory_embeddings WHERE target_id = ?");
    for (const eventId of eventIds) stmt.run(eventId);
  } catch (error) {
    logWarn("product_loop_embedding_delete_skipped", {
      event_count: eventIds.length,
      error: safeErrorMessage(error),
    });
  }
}

function deleteTurns(turnIds: string[]) {
  if (turnIds.length === 0) return;
  const db = getDB();
  const stmt = db.prepare("DELETE FROM conversation_turns WHERE id = ?");
  for (const id of turnIds) stmt.run(id);
}
