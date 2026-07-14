import { getLLM, type LLMTool } from "../../ai-client/src/llm";
import { roleLLMConfig } from "../../ai-client/src/roles";
import { getDB } from "../../db/src/database";
import { getMemberLabels } from "../../db/src/family";
import { recall, recallHybrid } from "../../retrieval/src/recall";
import { normalizeLocalDate } from "../../domain/src/local-date";
import { normalizeOwnerId } from "../../domain/src/owner";
import { routeMessage, type ConversationMode, type RouteResult } from "./intent-router";
import { loadSessionContext, summarizeRecentTurns, type AmbientContext, type SessionContext, type SessionTurn } from "./session-context";
import { entityCanonForOwner, executeRecallIntent, ruleBasedRecallIntent, type RecalledItem, type RecallDirection } from "./recall-intent";
import { loadUnderstandingContext, type UnderstandingContext } from "./memory/profile-context";
import { loadWisdomContext } from "./wisdom/wisdom-context";
import { maybeCaptureNarrative } from "./wisdom/narrative-capture";
import { getLastAssistantTurnId, recordIntervention } from "./wisdom/lever-store";
import type { WisdomPlan } from "./wisdom/lever-types";

export type ConversationRole = "user" | "assistant" | "system";

export interface ConversationTurn {
  id: string;
  owner_id?: string;
  role: ConversationRole;
  content: string;
  turn_date: string;
  source: string;
  metadata: Record<string, unknown>;
  archive_id?: string;
  created_at: string;
}

export interface RecordTurnInput {
  content: string;
  owner_id?: string;
  user_id?: string;
  role?: ConversationRole;
  turn_date?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatResult {
  mode: ConversationMode;
  user_turn: ConversationTurn;
  assistant_turn: ConversationTurn;
  reply: string;
  recalled: Array<{ id?: string; summary: string; event_time?: string; emotion?: string }>;
}

type ConversationIntent = "question" | "memory_note";
type RecallToolIntent = "specific_recall" | "window_recap" | "timeline";
type RecallToolSource = "events" | "daily_archives" | "mixed";
type RecallToolPeriod =
  | "today"
  | "yesterday"
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month"
  | "recent_days"
  | "recent_month"
  | "last_30_days"
  | "custom";

interface RecallToolTime {
  raw?: string;
  period?: RecallToolPeriod;
  since?: string;
  until?: string;
  days?: number;
  confidence?: number;
}

type ToolRecalledItem = RecalledItem & { source?: "event" | "daily_archive" | "today_log"; archive_date?: string };

export function recordConversationTurn(input: RecordTurnInput): ConversationTurn {
  const content = input.content?.trim();
  if (!content) throw new Error("content is required");

  const db = getDB();
  const id = crypto.randomUUID();
  const ownerId = normalizeOwnerId(input.owner_id ?? input.user_id);
  const role = input.role || "user";
  const turnDate = normalizeDate(input.turn_date);
  const source = input.source || "chat";
  const metadata = input.metadata || {};
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO conversation_turns (id, owner_id, role, content, turn_date, source, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, ownerId || null, role, content, turnDate, source, JSON.stringify(metadata), createdAt);

  return {
    id,
    owner_id: ownerId,
    role,
    content,
    turn_date: turnDate,
    source,
    metadata,
    created_at: createdAt,
  };
}

export function getConversationTurns(query: {
  owner_id?: string;
  user_id?: string;
  date?: string;
  limit?: number;
  include_archived?: boolean;
} = {}): ConversationTurn[] {
  const db = getDB();
  const conditions: string[] = [];
  const params: Array<string | number | null> = [];
  const ownerId = normalizeOwnerId(query.owner_id ?? query.user_id);

  if (ownerId) {
    conditions.push("owner_id = ?");
    params.push(ownerId);
  }
  if (query.date) {
    conditions.push("turn_date = ?");
    params.push(normalizeDate(query.date));
  }
  if (!query.include_archived) {
    conditions.push("archive_id IS NULL");
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = query.limit || 100;
  const rows = db.prepare(`
    SELECT * FROM conversation_turns
    ${where}
    ORDER BY created_at ASC
    LIMIT ?
  `).all(...params, limit) as Array<Record<string, unknown>>;

  return rows.map(rowToTurn);
}

export async function chatWithMemory(input: {
  text: string;
  owner_id?: string;
  user_id?: string;
  date?: string;
  limit?: number;
  mode?: ConversationMode | "auto";
  recallDepth?: RouteResult["recallDepth"];
  /** 家庭共享记忆：召回扇出的家庭成员 owner 池集合。缺省=仅说话人自己。 */
  scope_owner_ids?: string[];
  /** true = text 是图片的自动转写：回复 LLM 按「TA 发来一张照片」理解，不当成用户亲口说的话 */
  image_transcript?: boolean;
}): Promise<ChatResult> {
  const ownerId = normalizeOwnerId(input.owner_id ?? input.user_id);
  const rawText = input.text.trim();
  // auto：不预先分意图，交给 reply LLM 自己判断"记/查/聊"并按需召回。
  const isAuto = input.mode === "auto";
  const route: RouteResult = input.mode
    ? { mode: input.mode === "auto" ? "chat" : input.mode, text: rawText, matchedBy: "command", confidence: 1, recallDepth: input.mode === "auto" ? "hybrid" : (input.recallDepth ?? "none") }
    : routeMessage(rawText);
  const mode = normalizeChatMode(route.mode);
  const routedText = route.text || rawText;
  const userTurn = recordConversationTurn({
    content: rawText,
    owner_id: ownerId,
    role: "user",
    turn_date: input.date,
    source: "chat",
    metadata: input.image_transcript ? { mode, image_transcript: true } : { mode },
  });
  // 图片转写不是用户亲口说的话：给回复 LLM 的输入明确框定，避免它「引用用户原话」造成对不上
  const replyText = input.image_transcript
    ? `【我发来一张照片，下面是照片内容的自动转写，不是我打的字】${routedText}`
    : routedText;

  const sessionContext = loadSessionContext({
    owner_id: ownerId,
    date: input.date,
    maxTurns: 8,
    excludeTurnId: userTurn.id,
  });

  const recentDialogue = formatRecentDialogue(sessionContext.recentTurns);
  // 长期理解(L3)+近期状态(L2)理解层：让回复像懂这个人的家人，而不只是检索相似事件。
  const understanding = loadUnderstandingContext({ owner_id: ownerId });

  // 智慧干预：先回收"上一句反问有没有被 ta 自己答出一句新解释"，再判断这一句要不要发问。
  // 顺序不能反：同一条消息既是上次干预的答案，又可能是新一轮的触发。
  const previousAssistantTurnId = getLastAssistantTurnId(ownerId);
  await maybeCaptureNarrative({
    owner_id: ownerId,
    text: routedText,
    date: normalizeDate(input.date),
    previousAssistantTurnId,
  });
  const wisdom = await loadWisdomContext({
    owner_id: ownerId,
    text: routedText,
    date: normalizeDate(input.date),
    recentDialogue,
    turn_id: userTurn.id,
    scope_owner_ids: input.scope_owner_ids,
  });

  let recalled: ChatResult["recalled"] = [];
  let reply: string;
  if (isAuto) {
    // 统一入口：极简确定性快路（问候 / "上条记好了吗"）之外，全部交给 reply LLM，
    // 它自己判断这是记录/追问/闲聊，需要历史时再调用 recall 工具。
    if (isSimpleGreeting(routedText)) {
      reply = buildSimpleGreetingReply();
    } else if (isLatestLogStatusQuestion(routedText)) {
      reply = buildLatestLogStatusReply(ownerId, input.date);
    } else {
      ({ reply, recalled } = await buildReplyWithRecall({ text: replyText, owner_id: ownerId, scope_owner_ids: input.scope_owner_ids, date: input.date, recentDialogue, ambient: sessionContext.ambient, understanding, wisdomText: wisdom.text, limit: input.limit || 6 }));
    }
  } else if ((mode === "chat" || mode === "recall") && isLatestLogStatusQuestion(routedText)) {
    reply = buildLatestLogStatusReply(ownerId, input.date);
  } else if (mode === "recap") {
    reply = buildRecapReply(sessionContext);
  } else if (mode === "reflect") {
    reply = buildReflectReply(routedText, sessionContext);
  } else if (mode === "recall") {
    // 共情回复 LLM 自己按需调用 recall 工具（结构化/语义检索），失败时降级到预取召回。
    ({ reply, recalled } = await buildReplyWithRecall({ text: replyText, owner_id: ownerId, scope_owner_ids: input.scope_owner_ids, date: input.date, recentDialogue, ambient: sessionContext.ambient, understanding, wisdomText: wisdom.text, limit: input.limit || 6 }));
  } else if (mode === "chat") {
    if (isSimpleGreeting(routedText)) {
      reply = buildSimpleGreetingReply();
    } else if (route.recallDepth === "hybrid" || isRecallSeekingQuestion(routedText)) {
      ({ reply, recalled } = await buildReplyWithRecall({ text: replyText, owner_id: ownerId, scope_owner_ids: input.scope_owner_ids, date: input.date, recentDialogue, ambient: sessionContext.ambient, understanding, wisdomText: wisdom.text, limit: input.limit || 6 }));
    } else {
      reply = await buildReply(replyText, [], "question", sessionContext.ambient, understanding, wisdom.text);
    }
  } else {
    reply = await buildReply(replyText, [], "memory_note", sessionContext.ambient, understanding, wisdom.text);
  }

  const assistantTurn = recordConversationTurn({
    content: reply,
    owner_id: ownerId,
    role: "assistant",
    turn_date: input.date,
    source: "chat",
    metadata: {
      recalled_event_ids: recalled.map(r => r.id).filter(Boolean),
      ...(wisdom.intervene ? { wisdom: { lever: wisdom.lever, asked: true } } : {}),
    },
  });
  recordWisdomAsk(wisdom, { ownerId, reply, date: normalizeDate(input.date), askedTurnId: assistantTurn.id });

  return { mode, user_turn: userTurn, assistant_turn: assistantTurn, reply, recalled };
}

/**
 * 记下"我们问过 ta 这个问题"。
 * 它撑起两件事：冷却期（别每次难过都追问）、以及下一条消息里回收 ta 自己的回答。
 * 落库失败不能影响已经发出去的回复——最坏结果只是这次没形成闭环。
 */
function recordWisdomAsk(
  wisdom: WisdomPlan,
  ctx: { ownerId?: string; reply: string; date: string; askedTurnId: string },
): void {
  if (!wisdom.intervene || !wisdom.lever || !ctx.ownerId) return;
  try {
    recordIntervention({
      ownerId: ctx.ownerId,
      lever: wisdom.lever,
      question: ctx.reply,
      evidence: wisdom.counterEvidence,
      date: ctx.date,
      askedTurnId: ctx.askedTurnId,
    });
  } catch {
    // 不阻塞回复
  }
}

function formatRecentDialogue(recentTurns: SessionTurn[]): string {
  return recentTurns
    .slice(-6)
    .map(turn => {
      const who = turn.role === "user" ? "用户" : turn.role === "assistant" ? "助手" : "系统";
      let content = turn.content.replace(/\s+/g, " ").trim();
      content = content.length > 120 ? `${content.slice(0, 119)}…` : content;
      // 图片转写不是用户打的字：标注清楚，助手引用时不要说「你刚说的」
      if (turn.image_transcript) content = `[发来一张照片，自动转写：${content}]`;
      return `${who}: ${content}`;
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeChatMode(mode: ConversationMode): ConversationMode {
  if (mode === "archive" || mode === "undo" || mode === "correct") return "chat";
  return mode;
}

async function recallRelevantMemories(input: {
  text: string;
  owner_id?: string;
  limit: number;
}): Promise<Array<{ id?: string; summary: string; event_time?: string; emotion?: string }>> {
  const limit = Math.min(Math.max(1, Math.floor(input.limit || 6)), 20);
  const maxCandidates = Math.max(limit * 4, 12);
  const scored = new Map<string, { event: ReturnType<typeof recall>["events"][number]; score: number; firstSeen: number }>();
  let firstSeen = 0;

  const addEvents = (events: ReturnType<typeof recall>["events"], score: number) => {
    for (const event of events) {
      const key = event.id || `${event.raw_message_id || ""}:${event.summary}:${event.event_time || ""}`;
      const existing = scored.get(key);
      if (existing) {
        existing.score += score;
      } else {
        scored.set(key, { event, score, firstSeen: firstSeen++ });
      }
    }
  };

  const semanticResult = await recallHybrid({
    text: input.text,
    owner_id: input.owner_id,
    limit: maxCandidates,
  });
  addEvents(semanticResult.events, 5);

  for (const keyword of extractRecallKeywords(input.text, entityCanonForOwner(input.owner_id)).slice(0, 8)) {
    addEvents(recall({ text: keyword, owner_id: input.owner_id, limit: maxCandidates }).events, keyword.length >= 3 ? 3 : 2);
  }

  return [...scored.values()]
    .filter(({ event }) => !isDailyArchiveEvent(event))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const timeA = a.event.event_time || a.event.created_at || "";
      const timeB = b.event.event_time || b.event.created_at || "";
      if (timeA !== timeB) return timeB.localeCompare(timeA);
      return a.firstSeen - b.firstSeen;
    })
    .slice(0, limit)
    .map(({ event }) => ({
      id: event.id,
      summary: event.summary,
      event_time: event.event_time,
      emotion: event.emotion?.primary,
    }));
}

function isDailyArchiveEvent(event: ReturnType<typeof recall>["events"][number]): boolean {
  return Boolean(event.raw_message_id && event.id !== event.raw_message_id && event.original_text?.includes("对话归档"));
}

function isSimpleGreeting(text: string): boolean {
  return /^(hi|hello|hey|哈喽|你好|嗨|在吗|在不在|早|早安|晚上好|下午好)[~!！。,.，\s]*$/i.test(text.trim());
}

function buildSimpleGreetingReply(): string {
  return "hello，我在。";
}

function isRecallSeekingQuestion(text: string): boolean {
  return /上次|之前|以前|历史|记录|记得|有没有.*记录|什么时候|哪天|最近.*怎么样/.test(text);
}

function isLatestLogStatusQuestion(text: string): boolean {
  return /(上条|上一条|刚刚|刚才|前面那条|前一条).*(日志|记录).*(记好|记上|保存|成功|了吗|没有|没)/.test(text) ||
    /(日志|记录).*(记好|记上|保存|成功).*(了吗|没有|没)/.test(text);
}

function buildLatestLogStatusReply(ownerId: string | undefined, date: string | undefined): string {
  if (!ownerId) return "我还没法确认上一条日志，因为当前消息没有绑定到具体家庭成员。";
  const latest = getLatestUserLogTurn(ownerId, normalizeDate(date));
  if (!latest) return "我没找到今天上一条已保存的日志。你可以把要记录的内容再发一次，我来重记。";
  const eventCount = Array.isArray(latest.metadata?.current_event_ids) ? latest.metadata.current_event_ids.length : undefined;
  const suffix = typeof eventCount === "number" && eventCount > 0 ? `，生成了 ${eventCount} 条记忆事件` : "";
  return `记好了${suffix}。上一条是：${latest.content}`;
}

function getLatestUserLogTurn(ownerId: string, date: string): ConversationTurn | null {
  return getConversationTurns({ owner_id: ownerId, date, limit: 200, include_archived: true })
    .filter(turn => turn.role === "user" && (turn.source === "log" || turn.metadata?.mode === "log_with_contextual_reply" || turn.metadata?.mode === "product_correction"))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;
}

function extractRecallKeywords(text: string, entityCanon: Record<string, string> = {}): string[] {
  const normalized = text.replace(/[，。！？、,.!?;；:：()[\]{}“”"'\s]/g, " ");
  const candidates = new Set<string>();
  for (const token of normalized.split(/\s+/)) {
    if (/^[\p{Script=Han}A-Za-z0-9]{2,}$/u.test(token) && !isStopword(token)) candidates.add(token);
  }

  const domainTerms = [
    "语言表达", "语言", "表达", "说话", "大爆发", "主动表达",
    "夜醒", "睡眠", "哄睡", "辅食", "吃饭", "生病", "发烧", "咳嗽", "疫苗", "健康",
    "走路", "爬", "站", "翻身", "里程碑",
    // 家人名/昵称来自运行时家庭词典
    ...Object.keys(entityCanon),
  ];
  for (const term of domainTerms) {
    if (text.includes(term) && !isStopword(term)) candidates.add(term);
  }

  const semanticExpansions: Record<string, string[]> = {
    生病: ["发烧", "咳嗽", "健康"],
    病: ["发烧", "咳嗽", "健康"],
    什么时候生病: ["发烧", "咳嗽", "健康"],
  };
  for (const [trigger, expansions] of Object.entries(semanticExpansions)) {
    if (!text.includes(trigger)) continue;
    for (const expansion of expansions) {
      if (!isStopword(expansion)) candidates.add(expansion);
    }
  }
  // 昵称 ↔ 规范名双向扩展：命中任一 surface，就把它的规范名和同人所有别名都加入关键词
  const labelToSurfaces = new Map<string, string[]>();
  for (const [surface, label] of Object.entries(entityCanon)) {
    if (!labelToSurfaces.has(label)) labelToSurfaces.set(label, []);
    labelToSurfaces.get(label)!.push(surface);
  }
  for (const [surface, label] of Object.entries(entityCanon)) {
    if (!text.includes(surface)) continue;
    candidates.add(label);
    for (const sibling of labelToSurfaces.get(label) || []) candidates.add(sibling);
  }

  return [...candidates].sort((a, b) => b.length - a.length);
}

function isStopword(token: string): boolean {
  return new Set([
    "最近", "怎么样", "有没有", "之前", "类似", "记录", "一下", "这个", "那个", "什么", "我们", "你们",
  ]).has(token);
}

function buildRecapReply(ctx: SessionContext): string {
  const summary = summarizeRecentTurns(ctx);
  if (summary) return summary;
  return "刚刚这段我能看到的上下文不多，没有足够的近期对话可以概括。";
}

function buildReflectReply(text: string, ctx: SessionContext): string {
  const summary = summarizeRecentTurns(ctx);
  const subject = inferReflectSubject(text);
  if (summary) {
    return `${summary}如果你问的是这段里的${subject}，我会先看当时的压力、期待、受挫和缓和这些线索；它可能不是单一情绪，而是在情境变化里跟着起伏。`;
  }
  return `如果你指的是刚才那件事，我能看到的上下文不多。就这句追问来说，${subject}需要结合前一段事件判断：通常要看当时有没有压力、期待、受挫、放松或开心这些变化。`;
}

function inferReflectSubject(text: string): string {
  if (text.includes("她")) return "她的情绪";
  if (text.includes("他")) return "他的情绪";
  if (text.includes("我")) return "你的情绪";
  return "当事人的情绪";
}

const RECALL_REPLY_SYSTEM = [
  "你是 xfeel 的家庭记忆助手，像家里人发微信：温暖、简短、具体、克制。",
  "用户这条消息可能是三种之一，请你自己判断后再回应：",
  "①在记录/倾诉当下发生的事或心情 —— 直接温和接住当下，不要去查历史，也不要说“已记录/记下来了/收到”（记录是后台默认动作，不用声明）；",
  "②在追问过去（上次/什么时候/有没有记录过/最近怎么样/以前） —— 调用 recall_memory 查询后，据实回答第一手命中；",
  "如果用户问“这个月/上个月/最近一个月/这周/最近几天我经历了什么、发生了什么、总结一下”，这是时间窗口回顾：调用 recall_memory，intent 用 window_recap 或 timeline，并填 time.raw、time.period、time.since、time.until；不要用普通关键词 top-N 代替时间窗口。",
  "③只是随口聊两句 —— 自然接话即可。",
  "可参考给到的“长期理解/近期状态/近期对话”作为背景，但它们是假设不是事实；与用户当下这句冲突时，一律以当下为准，不要拿背景去纠正或编造具体事件。",
  "长度克制：像微信里随口回家人，最多 2-3 句、控制在 120 字内；不要用 Markdown 加粗，不要展开分点清单。即使是健康/安全这类需要提醒的事，也只挑最关键的一两点用一句话说清，不要罗列长 checklist。",
  "没查到就如实说没找到，绝不编造记忆；不要诊断、贴标签、比较或指责任何家庭成员；同一个人只用用户这条里的叫法，不要混用或补全大名。",
  "若命中的记忆带 recorder 字段（说明是别的家人记的，如 recorder='爸爸'），回答时自然点明来源，如「这是爸爸记的」；没有 recorder 的就是你正对话的这位本人记的，不用特别说明。",
].join("\n");

/**
 * 让共情回复的 LLM（reply 角色模型）按需主动调用 recall 工具：
 * 模型决定何时检索、检索什么；我们执行后回传，最终生成回复。
 * 工具/模型不可用时，降级到"预取召回 + 单轮直答"。
 */
async function buildReplyWithRecall(input: {
  text: string;
  owner_id?: string;
  scope_owner_ids?: string[];
  date?: string;
  recentDialogue: string;
  ambient?: AmbientContext;
  understanding?: UnderstandingContext;
  /** 智慧干预提示块：命中时要求"先接住、再把解释权交回给 ta"，未命中为空串。 */
  wisdomText?: string;
  limit: number;
}): Promise<{ reply: string; recalled: ChatResult["recalled"] }> {
  // 所有 recall 统一走 tool-loop：reply LLM 自己把原句聚焦成 query（如"阿星 发烧"）再调 recall_memory，
  // 比规则用整句召回更准。不再用基于情绪词的快路（它会被情绪过滤劫持、且整句召回不聚焦）。
  const collected = new Map<string, RecalledItem>();
  const record = (items: RecalledItem[]) => {
    for (const item of items) collected.set(item.id || item.summary, item);
  };

  const recallTool: LLMTool = {
    name: "recall_memory",
    description: "查询这个家庭过去的记忆/日志。可做具体记忆召回，也可按明确时间窗口汇总日终归档（如这个月、最近一个月、这周）。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索主题，可含人物/事件/关键词，如 '爸爸 压力'、'孩子 发烧'、'夜醒'" },
        intent: {
          type: "string",
          enum: ["specific_recall", "window_recap", "timeline"],
          description: "specific_recall=查某件具体旧事；window_recap=总结某个时间窗口经历；timeline=按时间列出窗口内关键记录",
        },
        emotions: { type: "array", items: { type: "string" }, description: "若在找特定情绪，给情绪词，如 ['压力','焦虑','开心']" },
        direction: { type: "string", enum: ["latest", "earlier", "earliest", "recent"], description: "时间方向：上次=latest，更早=earlier，最早=earliest，最近=recent" },
        time: {
          type: "object",
          description: "用户表达的时间范围。遇到这个月/上个月/最近一个月/这周/最近几天等必须填写。",
          properties: {
            raw: { type: "string", description: "用户原话里的时间短语，如 '这个月'" },
            period: {
              type: "string",
              enum: ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "recent_days", "recent_month", "last_30_days", "custom"],
            },
            since: { type: "string", description: "YYYY-MM-DD，时间窗口起点" },
            until: { type: "string", description: "YYYY-MM-DD，时间窗口终点" },
            days: { type: "number", description: "recent_days 时的天数" },
            confidence: { type: "number", description: "0-1，时间识别置信度" },
          },
        },
        source: {
          type: "string",
          enum: ["events", "daily_archives", "mixed"],
          description: "window_recap 优先用 daily_archives；具体旧事通常用 events；不确定用 mixed",
        },
      },
      required: ["query"],
    },
    run: async (args) => {
      const items = await runRecallTool(args, input.owner_id, input.recentDialogue, input.limit, normalizeDate(input.date), input.scope_owner_ids);
      record(items);
      return items.length
        ? items.map(item => ({ date: item.event_time?.slice(0, 10), summary: item.summary, emotion: item.emotion, source: (item as ToolRecalledItem).source, recorder: item.recorder }))
        : { found: 0, note: "没有找到匹配的记录" };
    },
  };

  const prompt = [
    input.understanding?.text ? `${input.understanding.text}\n` : "",
    input.wisdomText ? `${input.wisdomText}\n` : "",
    `当前日期：${normalizeDate(input.date)}`,
    "",
    `用户刚说：${input.text}`,
    "",
    `近期对话（短期上下文）：\n${input.recentDialogue || "（无）"}`,
    "",
    `近期环境背景（弱背景，不是事实依据）：\n${input.ambient?.text || "（无）"}`,
  ].filter(Boolean).join("\n");

  try {
    const result = await withTimeout(
      getLLM(roleLLMConfig("reply")).respondWithTools({ system: RECALL_REPLY_SYSTEM, prompt, tools: [recallTool], maxRounds: 4 }),
      getReplyLlmTimeoutMs() * 3,
      "reply tool loop timed out",
    );
    const reply = clampReply(result.text);
    if (reply) return { reply, recalled: [...collected.values()] };
  } catch {
    // fall through to deterministic pre-fetch path
  }

  const pre = await recallMemoriesForReply({ text: input.text, recentDialogue: input.recentDialogue, owner_id: input.owner_id, scope_owner_ids: input.scope_owner_ids, limit: input.limit });
  const reply = await buildReply(input.text, pre, "question", input.ambient, input.understanding, input.wisdomText);
  return { reply, recalled: pre };
}

/**
 * 共用召回：以语义+全文混合召回（recallHybrid）为主，对"发烧/咳嗽/夜醒"这类具体事件/症状词最稳；
 * 结构化情绪/类型严格层只在语义为空时兜底。
 *
 * 不走 recallRelevantMemories——它叠加的关键词召回会让"阿星"这类高频实体把近期事件分数拉高，
 * 把真正语义最相关的旧记录（如多年前那次发烧）挤出 top-N。
 * 也不要因为带了情绪词就直接走结构化情绪 AND——会把"发烧那次我好担心"这种症状查询按情绪过滤而漏召回。
 */
/** 构造"记录者"解析器：把 owner 池 id 映射成家人称呼，仅对非说话人本人的记录返回称呼。 */
function buildRecorderResolver(speakerOwnerId?: string, scopeOwnerIds?: string[]): (userId?: string) => string | undefined {
  if (!scopeOwnerIds?.length) return () => undefined;
  const labels = getMemberLabels(scopeOwnerIds);
  return (userId?: string) => (userId && userId !== speakerOwnerId ? labels.get(userId) : undefined);
}

async function recallMemoriesForReply(input: {
  text: string;
  emotions?: string[];
  direction?: RecallDirection;
  since?: string;
  until?: string;
  recentDialogue?: string;
  owner_id?: string;
  scope_owner_ids?: string[];
  limit: number;
}): Promise<RecalledItem[]> {
  const limit = input.limit;
  // 家庭共享记忆：给"非说话人本人"记录的事件标注记录者（如"爸爸"），供回复点明来源。
  const recorderFor = buildRecorderResolver(input.owner_id, input.scope_owner_ids);
  const hybrid = await recallHybrid({
    text: input.text,
    owner_id: input.owner_id,
    scope_owner_ids: input.scope_owner_ids,
    date_from: input.since,
    date_to: input.until,
    limit: Math.max(limit * 3, 12),
  });
  const semantic: RecalledItem[] = hybrid.events
    .filter(event => !isDailyArchiveEvent(event))
    .slice(0, limit)
    .map(event => ({
      id: event.id || "",
      summary: event.summary,
      event_time: event.event_time,
      emotion: event.emotion?.primary,
      recorder: recorderFor(event.user_id),
    }));
  if (semantic.length > 0) return semantic;

  // 兜底：语义没命中、但有情绪/类型这种强结构信号（如纯情绪追问"最近有没有特别崩溃的时候"），走严格结构层。
  const enriched = [input.text, (input.emotions || []).join(" ")].filter(Boolean).join(" ") || input.text;
  const base = ruleBasedRecallIntent(enriched, input.recentDialogue, entityCanonForOwner(input.owner_id));
  const intent = { ...base, isMemoryQuery: true, direction: input.direction ?? base.direction };
  if (intent.emotions.length || intent.event_types.length) {
    return executeRecallIntent(intent, { owner_id: input.owner_id, scope_owner_ids: input.scope_owner_ids, limit });
  }
  return semantic;
}

/** recall_memory 工具的执行：把模型给的 query/emotions/direction 交给共用召回。 */
async function runRecallTool(
  args: Record<string, unknown>,
  ownerId: string | undefined,
  recentDialogue: string,
  limit: number,
  currentDate: string,
  scopeOwnerIds?: string[],
): Promise<ToolRecalledItem[]> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const emotions = Array.isArray(args.emotions) ? args.emotions.filter((x): x is string => typeof x === "string") : [];
  const enriched = [query, emotions.join(" ")].filter(Boolean).join(" ") || query;
  const dir = args.direction;
  const direction = dir === "latest" || dir === "earlier" || dir === "earliest" || dir === "recent" || dir === "all" ? dir : undefined;
  const intent = normalizeRecallToolIntent(args.intent);
  const source = normalizeRecallToolSource(args.source);
  const time = normalizeRecallToolTime(args.time);
  const window = resolveRecallToolWindow(time, currentDate, intent);

  if ((intent === "window_recap" || intent === "timeline") && window) {
    return queryWindowRecap({ ownerId, scopeOwnerIds, query: query || enriched, since: window.since, until: window.until, source, limit });
  }

  return recallMemoriesForReply({
    text: query || enriched,
    emotions,
    direction,
    since: window?.since,
    until: window?.until,
    recentDialogue,
    owner_id: ownerId,
    scope_owner_ids: scopeOwnerIds,
    limit,
  });
}

function ownerScopeList(ownerId: string, scopeOwnerIds?: string[]): string[] {
  if (!scopeOwnerIds?.length) return [ownerId];
  return [...new Set([ownerId, ...(scopeOwnerIds.map(id => normalizeOwnerId(id)).filter(Boolean) as string[])])];
}

function queryWindowRecap(input: {
  ownerId?: string;
  scopeOwnerIds?: string[];
  query: string;
  since: string;
  until: string;
  source: RecallToolSource;
  limit: number;
}): ToolRecalledItem[] {
  const ownerId = normalizeOwnerId(input.ownerId);
  if (!ownerId) return [];
  const owners = ownerScopeList(ownerId, input.scopeOwnerIds);
  const ownerPlaceholders = owners.map(() => "?").join(",");
  const db = getDB();
  const archiveLimit = Math.min(Math.max(input.limit * 4, 12), 60);
  const archives = input.source !== "events"
    ? db.prepare(`
      SELECT id, archive_date, summary
      FROM daily_archives
      WHERE owner_id IN (${ownerPlaceholders}) AND archive_date BETWEEN ? AND ? AND status = 'done' AND summary != ''
      ORDER BY archive_date ASC
      LIMIT ?
    `).all(...owners, input.since, input.until, archiveLimit) as Array<{ id: string; archive_date: string; summary: string }>
    : [];

  const items: ToolRecalledItem[] = archives.map(row => ({
    id: `archive:${row.id}`,
    event_time: `${row.archive_date}T00:00:00.000Z`,
    summary: `${row.archive_date}：${clipText(row.summary, 360)}`,
    source: "daily_archive",
    archive_date: row.archive_date,
  }));

  for (const turn of queryUnarchivedLogTurns(owners, input.since, input.until, Math.max(4, input.limit))) {
    items.push({
      id: `turn:${turn.id}`,
      event_time: `${turn.turn_date}T23:59:59.000Z`,
      summary: `${turn.turn_date} 未归档日志：${clipText(turn.content, 180)}`,
      source: "today_log",
    });
  }

  if (items.length > 0 || input.source === "daily_archives") return items;

  return queryWindowEvents({ owners, query: input.query, since: input.since, until: input.until, limit: Math.max(input.limit, 8) });
}

function queryUnarchivedLogTurns(owners: string[], since: string, until: string, limit: number): ConversationTurn[] {
  if (owners.length === 0) return [];
  const rows = getDB().prepare(`
    SELECT *
    FROM conversation_turns
    WHERE owner_id IN (${owners.map(() => "?").join(",")})
      AND role = 'user'
      AND turn_date BETWEEN ? AND ?
      AND archive_id IS NULL
      AND (source = 'log' OR metadata LIKE '%"mode":"log_with_contextual_reply"%')
    ORDER BY turn_date ASC, created_at ASC
    LIMIT ?
  `).all(...owners, since, until, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToTurn);
}

function queryWindowEvents(input: {
  owners: string[];
  query: string;
  since: string;
  until: string;
  limit: number;
}): ToolRecalledItem[] {
  if (input.owners.length === 0) return [];
  const textFilter = input.query.trim() ? "AND (summary LIKE ? OR original_text LIKE ? OR canonical_search_text LIKE ?)" : "";
  const like = `%${input.query.trim()}%`;
  const params: Array<string | number> = [...input.owners, input.since, input.until];
  if (textFilter) params.push(like, like, like);
  params.push(Math.min(Math.max(input.limit, 1), 50));
  const rows = getDB().prepare(`
    SELECT id, summary, event_time, event_date, created_at, emotion
    FROM memory_events
    WHERE user_id IN (${input.owners.map(() => "?").join(",")})
      AND COALESCE(NULLIF(event_date, ''), date(event_time), substr(event_time, 1, 10), date(created_at, 'localtime'), substr(created_at, 1, 10)) BETWEEN ? AND ?
      ${textFilter}
    ORDER BY COALESCE(event_time, NULLIF(event_date, ''), created_at) ASC
    LIMIT ?
  `).all(...params) as Array<{ id?: string; summary: string; event_time?: string | null; event_date?: string | null; created_at?: string; emotion?: string }>;
  return rows.map(row => ({
    id: row.id,
    summary: `${(row.event_time || row.event_date || row.created_at || "").slice(0, 10)}：${clipText(row.summary, 220)}`,
    event_time: row.event_time || (row.event_date ? `${row.event_date}T00:00:00.000Z` : row.created_at),
    emotion: parseToolEmotion(row.emotion),
    source: "event",
  }));
}

function normalizeRecallToolIntent(raw: unknown): RecallToolIntent {
  return raw === "window_recap" || raw === "timeline" || raw === "specific_recall" ? raw : "specific_recall";
}

function normalizeRecallToolSource(raw: unknown): RecallToolSource {
  return raw === "events" || raw === "daily_archives" || raw === "mixed" ? raw : "mixed";
}

function normalizeRecallToolTime(raw: unknown): RecallToolTime | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = raw as Record<string, unknown>;
  const period = normalizeRecallToolPeriod(input.period);
  return {
    raw: typeof input.raw === "string" ? input.raw.trim() : undefined,
    period,
    since: normalizeDateOnly(input.since),
    until: normalizeDateOnly(input.until),
    days: typeof input.days === "number" && Number.isFinite(input.days) ? input.days : undefined,
    confidence: typeof input.confidence === "number" && Number.isFinite(input.confidence) ? input.confidence : undefined,
  };
}

function normalizeRecallToolPeriod(raw: unknown): RecallToolPeriod | undefined {
  return raw === "today" ||
    raw === "yesterday" ||
    raw === "this_week" ||
    raw === "last_week" ||
    raw === "this_month" ||
    raw === "last_month" ||
    raw === "recent_days" ||
    raw === "recent_month" ||
    raw === "last_30_days" ||
    raw === "custom"
    ? raw
    : undefined;
}

function resolveRecallToolWindow(
  time: RecallToolTime | undefined,
  currentDate: string,
  intent: RecallToolIntent,
): { since: string; until: string } | undefined {
  const today = normalizeDateOnly(currentDate) || normalizeDate();
  let since = time?.since;
  let until = time?.until;

  if (!since || !until) {
    const derived = deriveWindowFromPeriod(time?.period, today, time?.days, intent);
    since = since || derived?.since;
    until = until || derived?.until;
  }
  if (!since || !until) return undefined;
  if (since > until) [since, until] = [until, since];
  if (until > today) until = today;
  if (since > today) since = today;
  if (daysBetween(since, until) > 366) since = addDays(until, -365);
  return { since, until };
}

function deriveWindowFromPeriod(
  period: RecallToolPeriod | undefined,
  today: string,
  days: number | undefined,
  intent: RecallToolIntent,
): { since: string; until: string } | undefined {
  switch (period) {
    case "today":
      return { since: today, until: today };
    case "yesterday": {
      const day = addDays(today, -1);
      return { since: day, until: day };
    }
    case "this_week":
      return { since: startOfWeek(today), until: today };
    case "last_week": {
      const end = addDays(startOfWeek(today), -1);
      return { since: addDays(end, -6), until: end };
    }
    case "this_month":
      return { since: `${today.slice(0, 7)}-01`, until: today };
    case "last_month": {
      const firstThisMonth = `${today.slice(0, 7)}-01`;
      const end = addDays(firstThisMonth, -1);
      return { since: `${end.slice(0, 7)}-01`, until: end };
    }
    case "recent_days": {
      const safeDays = Math.min(Math.max(1, Math.floor(days || 7)), 90);
      return { since: addDays(today, -(safeDays - 1)), until: today };
    }
    case "recent_month":
    case "last_30_days":
      return { since: addDays(today, -29), until: today };
    case "custom":
      return undefined;
    default:
      return intent === "window_recap" || intent === "timeline"
        ? { since: addDays(today, -29), until: today }
        : undefined;
  }
}

function startOfWeek(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function daysBetween(since: string, until: string): number {
  const start = new Date(`${since}T00:00:00.000Z`).getTime();
  const end = new Date(`${until}T00:00:00.000Z`).getTime();
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

function normalizeDateOnly(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return undefined;
  const value = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? undefined : value;
}

function parseToolEmotion(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    return (JSON.parse(raw) as { primary?: string }).primary;
  } catch {
    return undefined;
  }
}

function clipText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(1, maxLength - 3))}...` : normalized;
}

function clampReply(raw: string, maxChars = 280): string {
  const normalized = raw.trim().replace(/\n{3,}/g, "\n\n");
  if (normalized.length <= maxChars) return normalized;
  // 超长时按句子边界回退截断，避免切在词中间；找不到边界再硬切。
  const head = normalized.slice(0, maxChars);
  const lastBreak = Math.max(
    head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"),
    head.lastIndexOf("\n"),
  );
  return lastBreak >= maxChars * 0.5 ? head.slice(0, lastBreak + 1) : `${head.trim()}…`;
}

async function buildWarmStructuredRecallReply(
  text: string,
  items: RecalledItem[],
  direction: "latest" | "earlier" | "earliest" | "recent" | "all",
  ambient?: AmbientContext,
  understanding?: UnderstandingContext,
): Promise<string> {
  // 结构化检索仍然不走 tool-loop：先毫秒级确定结果，再给 reply LLM 一次机会润色。
  // LLM 超时/失败时退回同一事实的确定性温和模板，避免为了“温度”牺牲可用性。
  try {
    const memoryLines = items
      .slice(0, 4)
      .map((m, idx) => `${idx + 1}. ${m.event_time ? `${m.event_time.slice(0, 10)} ` : ""}${compactMemorySummary(m.summary)}${m.emotion ? `（情绪：${m.emotion}）` : ""}`)
      .join("\n");
    const raw = await withTimeout(
      getLLM(roleLLMConfig("reply")).chat(
        `${understanding?.text ? `${understanding.text}\n\n` : ""}用户刚说：${text}\n\n结构化检索方向：${direction}\n\n查到的记忆（已按时间方向排好序，第 1 条就是应该优先回答的命中）：\n${memoryLines || "暂无"}\n\n近期环境上下文（弱背景，不等于召回证据）：\n${ambient?.text || "暂无"}\n\n回复要求：\n- 用 1-2 句口语化中文，像在微信里回家人；自然、温和，但不要煽情。\n- 必须优先回答第 1 条记忆的日期和内容；不要跳过第 1 条。\n- 除非用户问“都有哪些/列出来”，不要主动展开列表，最多顺带说“还看到几条，可以继续翻”。\n- 不要使用 Markdown 加粗；不要把同一个情绪词在摘要和括号里重复两遍。\n- 称呼沿用用户问句里的叫法；同一个人不要在一句里出现两个名字。\n- 如果没查到，就直接说没找到相关记录。\n- 不要说“我记下来了”，不要编造，不要诊断、归因或评价家人。`,
        "你是 xfeel 的家庭记忆助手。只基于给定检索结果回应；优先回答第 1 条命中。语气温暖、自然、克制，适合微信短消息。",
      ),
      getStructuredRecallReplyTimeoutMs(),
      "structured recall reply LLM timed out",
    );
    const reply = clampReply(raw);
    if (reply) return reply;
  } catch {
    // fall through to deterministic warm template
  }
  return buildDeterministicRecallReply(items, direction);
}

function buildDeterministicRecallReply(items: RecalledItem[], direction: "latest" | "earlier" | "earliest" | "recent" | "all"): string {
  if (!items.length) return "我这边没有找到相关记录，可能是当时没有被整理成这类情绪/状态。";
  const first = items[0]!;
  const prefix = direction === "earliest"
    ? "我翻到最早的一条是"
    : direction === "earlier"
      ? "再往前翻到的一条是"
      : "我翻到最近的一条是";
  const date = first.event_time ? `${first.event_time.slice(0, 10)}：` : "";
  const summary = compactMemorySummary(first.summary);
  const emotion = first.emotion && !summary.includes(first.emotion) ? `（当时标到的是“${first.emotion}”）` : "";
  const extra = items.length > 1
    ? `\n\n我还看到了另外 ${items.length - 1} 条相关记录，如果你愿意，我可以继续往前翻。`
    : "";
  return `${prefix} ${date}${summary}${emotion}${extra}`;
}

function compactMemorySummary(summary: string): string {
  const withoutStructuredDetails = summary
    .split(/\n\s*\[/)[0]!
    .replace(/\s*\[[^\]]+\].*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return withoutStructuredDetails.length > 70 ? `${withoutStructuredDetails.slice(0, 67)}...` : withoutStructuredDetails;
}

function getStructuredRecallReplyTimeoutMs(): number {
  const configured = Number(process.env.XFEEL_STRUCTURED_RECALL_REPLY_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return 3_000;
}

async function buildReply(
  text: string,
  recalled: Array<{ summary: string; event_time?: string; emotion?: string; recorder?: string }>,
  intent: ConversationIntent,
  ambient?: AmbientContext,
  understanding?: UnderstandingContext,
  wisdomText?: string,
): Promise<string> {
  try {
    const memoryLines = recalled
      .slice(0, 6)
      .map((m, idx) => `${idx + 1}. ${m.event_time ? `${m.event_time.slice(0, 10)} ` : ""}${m.summary}${m.emotion ? `（${m.emotion}）` : ""}${m.recorder ? `（${m.recorder}记的）` : ""}`)
      .join("\n");
    const llm = getLLM(roleLLMConfig("reply"));
    const raw = await withTimeout(
      llm.chat(
        `${understanding?.text ? `${understanding.text}\n\n` : ""}${wisdomText ? `${wisdomText}\n\n` : ""}用户刚说：${text}\n\n意图判断：${intent === "question" ? "用户在提问/讨论，不是在提供新记忆" : "用户可能在提供一条可归档的新记忆"}\n\n相关记忆：\n${memoryLines || "暂无"}\n\n近期环境上下文（弱背景，不等于召回证据）：\n${ambient?.text || "暂无"}\n\n请用简短、自然、具体的方式回应，并在适合时承接已有记忆。最多 2-3 句、控制在 120 字内，不要用 Markdown 加粗，不要展开分点清单。若用户是在提问，不要回复“我记下来了”或承诺归档；只有用户明确提供新事实时才确认记录。`,
        "你是 xfeel 的家庭记忆助手。不要编造事实；只基于用户当前消息和给定记忆回应。必须先区分用户是在提问还是在记录新事实。",
      ),
      getReplyLlmTimeoutMs(),
      "reply LLM timed out",
    );
    const reply = clampReply(raw);
    if (reply) return reply;
  } catch {
    // fall through to deterministic reply
  }

  if (intent === "question") {
    if (isRecallSeekingQuestion(text)) {
      if (recalled.length > 0) {
        const first = recalled[0]!;
        return `${first.event_time ? `${first.event_time.slice(0, 10)}：` : ""}${first.summary}${first.recorder ? `（${first.recorder}记的）` : ""}`;
      }
      return "我没有找到相关记录。";
    }
    // LLM 不可用时的兜底：保持温和、在场，不编造、不硬塞旧记忆，邀请继续说。
    return "嗯，我在听。这会儿先不急着下结论，你愿意的话再多和我说说。";
  }

  if (recalled.length > 0) {
    return `我记下来了。这个和之前的「${recalled[0]!.summary}」有点相关，今晚归档时我会一起整理进情绪和成长记录。`;
  }
  return "我记下来了。今晚归档时我会把这段对话整理成当天的情绪日志和成长记录。";
}

function getReplyLlmTimeoutMs(): number {
  const configured = Number(process.env.XFEEL_REPLY_LLM_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  // 云端共情回复比本地小模型慢，给足生成时间，失败再降级到确定性回复。
  return 12_000;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function normalizeDate(input?: string): string {
  return normalizeLocalDate(input);
}

function rowToTurn(row: Record<string, unknown>): ConversationTurn {
  return {
    id: row.id as string,
    owner_id: row.owner_id as string | undefined,
    role: row.role as ConversationRole,
    content: row.content as string,
    turn_date: row.turn_date as string,
    source: row.source as string,
    metadata: JSON.parse(row.metadata as string || "{}"),
    archive_id: row.archive_id as string | undefined,
    created_at: row.created_at as string,
  };
}
