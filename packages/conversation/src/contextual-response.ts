import { getLLM } from "../../ai-client/src/llm";
import { roleLLMConfig } from "../../ai-client/src/roles";
import { getDB } from "../../db/src/database";
import { normalizeLocalDate } from "../../domain/src/local-date";
import { normalizeOwnerId } from "../../domain/src/owner";
import type { AliasContext } from "../../domain/src/family";
import type { MemoryEvent } from "../../domain/src/memory-event";
import { processMessage, type PipelineResult } from "../../pipeline/src/pipeline";
import { recall } from "../../retrieval/src/recall";
import { recordConversationTurn, type ConversationTurn } from "./conversation";
import { buildWeakEntitySet, isContextuallyRelevant } from "./relevance-gate";
import { loadSessionContext } from "./session-context";
import { loadUnderstandingContext } from "./memory/profile-context";
import { loadWisdomContext } from "./wisdom/wisdom-context";
import { maybeCaptureNarrative } from "./wisdom/narrative-capture";
import { getLastAssistantTurnId, recordIntervention } from "./wisdom/lever-store";

export interface LogWithContextInput {
  text: string;
  owner_id?: string;
  user_id?: string;
  /** 家庭共享记忆：召回扇出的家庭成员 owner 池集合。缺省=仅说话人自己。 */
  scope_owner_ids?: string[];
  date?: string;
  force?: boolean;
  limit?: number;
  speaker_id?: string;
  speaker_label?: string;
  aliasContext?: AliasContext;
}

export interface RecalledMemory {
  id: string;
  raw_message_id?: string;
  summary: string;
  event_time?: string;
  event_type: MemoryEvent["event_type"];
  emotion?: string;
  entities: string[];
  tags: string[];
  user_id?: string;
}

export interface ContextualLogResult {
  mode: "log_with_contextual_reply";
  pipeline: PipelineResult;
  user_turn: ConversationTurn;
  assistant_turn: ConversationTurn;
  reply: string;
  context: {
    current_event_summaries: string[];
    recalled: RecalledMemory[];
    signals: {
      has_related_history: boolean;
      has_negative_emotion: boolean;
      owner_id?: string;
    };
  };
}

interface ContextSignals {
  has_related_history: boolean;
  has_negative_emotion: boolean;
  owner_id?: string;
}

export const CONTEXTUAL_RECALL_OPTIONS = { expansion: false } as const;

export async function logWithContextualReply(input: LogWithContextInput): Promise<ContextualLogResult> {
  const text = input.text?.trim();
  if (!text) throw new Error("text is required");

  const ownerId = normalizeOwnerId(input.owner_id ?? input.user_id);
  const turnDate = normalizeDate(input.date);

  const userTurn = recordConversationTurn({
    content: text,
    owner_id: ownerId,
    role: "user",
    turn_date: turnDate,
    source: "log",
    metadata: { mode: "log_with_contextual_reply" },
  });

  const pipeline = await processMessage(text, {
    ownerId,
    userId: ownerId,
    speakerId: input.speaker_id,
    speakerLabel: input.speaker_label,
    aliasContext: input.aliasContext,
    force: input.force,
    eventDate: turnDate,
    embedNewEvents: false,
  });

  const recalled = await recallContextualHistory({
    text,
    ownerId,
    scopeOwnerIds: input.scope_owner_ids,
    events: pipeline.events,
    messageId: pipeline.message_id,
    limit: input.limit,
    aliasContext: input.aliasContext,
  });
  const signals: ContextSignals = {
    has_related_history: recalled.length > 0,
    has_negative_emotion: pipeline.events.some(event => event.emotion?.valence === "negative"),
    owner_id: ownerId,
  };
  const currentEventSummaries = pipeline.events.map(event => event.summary).filter(Boolean);

  // 接入短期记忆：近期对话 + 近一周弱背景，让 log 路径的共情回复能承接上下文，
  // 支撑围绕记录意图展开的多轮问答。
  const session = loadSessionContext({ owner_id: ownerId, date: turnDate, maxTurns: 8, excludeTurnId: userTurn.id });
  const understanding = loadUnderstandingContext({ owner_id: ownerId });
  const recentDialogue = formatRecentDialogue(session.recentTurns);

  // 智慧干预：日志路径同样先回收上一句反问的答案，再判断这条要不要把解释权交回给 ta。
  const previousAssistantTurnId = getLastAssistantTurnId(ownerId);
  await maybeCaptureNarrative({ owner_id: ownerId, text, date: turnDate, previousAssistantTurnId });
  const wisdom = await loadWisdomContext({
    owner_id: ownerId,
    text,
    date: turnDate,
    recentDialogue,
    turn_id: userTurn.id,
    scope_owner_ids: input.scope_owner_ids,
  });

  const reply = await buildContextualReply({
    text,
    currentEventSummaries,
    recalled,
    signals,
    recentDialogue,
    ambientText: session.ambient?.text,
    understandingText: understanding.text,
    wisdomText: wisdom.text,
    aliasContext: input.aliasContext,
  });

  const userMetadata = {
    mode: "log_with_contextual_reply",
    pipeline_message_id: pipeline.message_id,
    current_event_ids: pipeline.events.map(event => event.id).filter(Boolean),
  };
  getDB().prepare("UPDATE conversation_turns SET metadata = ? WHERE id = ?")
    .run(JSON.stringify(userMetadata), userTurn.id);
  userTurn.metadata = userMetadata;

  const assistantTurn = recordConversationTurn({
    content: reply,
    owner_id: ownerId,
    role: "assistant",
    turn_date: turnDate,
    source: "contextual_log_reply",
    metadata: {
      pipeline_message_id: pipeline.message_id,
      current_event_ids: pipeline.events.map(event => event.id).filter(Boolean),
      recalled_event_ids: recalled.map(event => event.id),
      signals,
      ...(wisdom.intervene ? { wisdom: { lever: wisdom.lever, asked: true } } : {}),
    },
  });

  if (wisdom.intervene && wisdom.lever && ownerId) {
    try {
      recordIntervention({
        ownerId,
        lever: wisdom.lever,
        question: reply,
        evidence: wisdom.counterEvidence,
        date: turnDate,
        askedTurnId: assistantTurn.id,
      });
    } catch {
      // 落库失败不影响已发出的回复：最坏只是这次没形成闭环。
    }
  }

  return {
    mode: "log_with_contextual_reply",
    pipeline,
    user_turn: userTurn,
    assistant_turn: assistantTurn,
    reply,
    context: {
      current_event_summaries: currentEventSummaries,
      recalled,
      signals,
    },
  };
}

export async function recallContextualHistory(input: {
  text: string;
  ownerId?: string;
  scopeOwnerIds?: string[];
  events: MemoryEvent[];
  messageId: string;
  limit?: number;
  aliasContext?: AliasContext;
}): Promise<RecalledMemory[]> {
  const limit = clampLimit(input.limit);
  const maxCandidates = Math.max(limit * 4, 12);
  // 召回默认开启：不再只在强负面情绪时才召回。正面/中性日志同样可以联动相关历史
  // （“懂你”是常态），弱匹配交给下方 relevance-gate 过滤。无结构化事件时自然返回空。
  if (input.events.length === 0) return [];
  const currentEventIds = new Set(input.events.map(event => event.id).filter((id): id is string => Boolean(id)));
  const currentMessageId = input.messageId;
  const scored = new Map<string, { event: MemoryEvent; score: number; firstSeen: number }>();
  let seenOrder = 0;

  const addEvents = (events: MemoryEvent[], score: number) => {
    for (const event of events) {
      if (isCurrentEvent(event, currentMessageId, currentEventIds)) continue;
      const key = event.id || `${event.raw_message_id || ""}:${event.summary}:${event.event_time || ""}`;
      const existing = scored.get(key);
      if (existing) {
        existing.score += score;
      } else {
        scored.set(key, { event, score, firstSeen: seenOrder++ });
      }
    }
  };

  const eventTypes = unique(input.events.map(event => event.event_type).filter(Boolean));
  if (eventTypes.length > 0) {
    addEvents(recall({
      event_types: eventTypes,
      owner_id: input.ownerId,
      scope_owner_ids: input.scopeOwnerIds,
      limit: maxCandidates,
    }, CONTEXTUAL_RECALL_OPTIONS).events, 4);
  }

  const entities = unique(input.events.flatMap(event => event.entities || []));
  if (entities.length > 0) {
    addEvents(recall({
      entities,
      owner_id: input.ownerId,
      scope_owner_ids: input.scopeOwnerIds,
      limit: maxCandidates,
    }, CONTEXTUAL_RECALL_OPTIONS).events, 3);
  }

  const emotions = unique(input.events
    .map(event => event.emotion?.primary)
    .filter((emotion): emotion is MemoryEvent["emotion"]["primary"] => Boolean(emotion)));
  if (emotions.length > 0) {
    addEvents(recall({
      emotions,
      owner_id: input.ownerId,
      scope_owner_ids: input.scopeOwnerIds,
      limit: maxCandidates,
    }, CONTEXTUAL_RECALL_OPTIONS).events, 3);
  }

  if (input.events.some(event => event.emotion?.valence === "negative")) {
    addEvents(recall({
      valence: "negative",
      owner_id: input.ownerId,
      scope_owner_ids: input.scopeOwnerIds,
      limit: maxCandidates,
    }, CONTEXTUAL_RECALL_OPTIONS).events, 2);
  }

  const shouldFilterByCurrentEvents = input.events.length > 0;
  const weakEntities = buildWeakEntitySet(input.aliasContext);
  return [...scored.values()]
    .filter(({ event, score }) => !shouldFilterByCurrentEvents || isContextuallyRelevant(event, input.events, score, weakEntities) || isEmotionallyRelevant(event, input.events, score))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const timeA = a.event.event_time || a.event.created_at || "";
      const timeB = b.event.event_time || b.event.created_at || "";
      if (timeA !== timeB) return timeB.localeCompare(timeA);
      return a.firstSeen - b.firstSeen;
    })
    .slice(0, limit)
    .map(({ event }) => ({
      id: event.id || "",
      raw_message_id: event.raw_message_id,
      summary: event.summary,
      event_time: event.event_time,
      event_type: event.event_type,
      emotion: event.emotion?.primary,
      entities: event.entities || [],
      tags: event.tags || [],
      user_id: event.user_id,
    }));
}

function hasStrongNegativeEmotion(event: MemoryEvent): boolean {
  return event.emotion?.valence === "negative" && (event.emotion.intensity ?? 0) >= 0.7;
}

function isEmotionallyRelevant(candidate: MemoryEvent, currentEvents: MemoryEvent[], score: number): boolean {
  if (score < 2) return false;
  return currentEvents.some(current =>
    hasStrongNegativeEmotion(current) &&
    candidate.emotion?.valence === "negative" &&
    ((candidate.emotion?.intensity ?? 0) >= 0.6 || candidate.event_type === "emotion")
  );
}

async function buildContextualReply(input: {
  text: string;
  currentEventSummaries: string[];
  recalled: RecalledMemory[];
  signals: ContextSignals;
  recentDialogue?: string;
  ambientText?: string;
  understandingText?: string;
  /** 智慧干预提示块：命中时要求"先接住、再把解释权交回给 ta"，未命中为空串。 */
  wisdomText?: string;
  aliasContext?: AliasContext;
}): Promise<string> {
  try {
    const memoryLines = input.recalled
      .slice(0, 6)
      .map((memory, idx) => {
        const date = memory.event_time ? `${memory.event_time.slice(0, 10)} ` : "";
        const emotion = memory.emotion ? `（${memory.emotion}）` : "";
        return `${idx + 1}. ${date}${memory.summary}${emotion}`;
      })
      .join("\n");
    const currentLines = input.currentEventSummaries
      .map((summary, idx) => `${idx + 1}. ${summary}`)
      .join("\n");

    const raw = await getLLM(roleLLMConfig("reply")).chat(
      [
        input.understandingText ? `${input.understandingText}\n` : "",
        input.wisdomText ? `${input.wisdomText}\n` : "",
        `当前日志：${input.text}`,
        "",
        `本次抽取：\n${currentLines || "暂无结构化事件"}`,
        "",
        `相关历史：\n${memoryLines || "暂无"}`,
        "",
        `近期对话（短期上下文，用于自然承接，不是新事实）：\n${input.recentDialogue || "暂无"}`,
        "",
        `近期环境背景（弱背景，帮助理解，不要当作新事实）：\n${input.ambientText || "暂无"}`,
        "",
        `信号：has_related_history=${input.signals.has_related_history}; has_negative_emotion=${input.signals.has_negative_emotion}; owner_id=${input.signals.owner_id || "unknown"}`,
        "",
        "请生成一条像家人在微信里发的回应，不要客服腔：\n- 【硬规则·名字】通篇只用用户在本条里对每个人用的叫法（如“阿星”“阿禾”），哪怕“本次抽取/相关历史”里是别的名字（如“小星”“小禾”），也一律换成用户的叫法；同一个人同一条里只能出现一种叫法，绝不混用、不纠正、不补全大名。\n- 【硬规则·不回执】禁止以“已记录/记下来了/收到/好的”开头。记录是默认动作，无需声明。直接说人话。\n- 只对“当前这条”做一句具体、贴事实的共情或回应：负向先稳稳接住，再给一点支撑；不夸张、不口号、不替对方下结论。\n- 【硬规则·不凑反差】只允许回应当前这一条的情绪。绝对不要把“近期对话”里上一条的事拿来和这条做情绪对比（如“刚还崩溃转头又可爱”），除非用户在本条里自己点出了对比。\n- “相关历史”默认不引用：只有当历史与当前在【同一个人 且 同一类具体事】上高度重合时才提一句；“下雨/累/开心/情绪变化”这类弱关联一律当作无关，宁可不提，也不要为了“显得懂你”硬扯。\n- 不诊断、不贴标签、不在孩子之间或夫妻之间比较或评价。\n- 结尾另起一行写“提取到：…”，一句话概括本条记录，叫法同样只用用户本条的叫法。",
      ].join("\n"),
      "你是 xfeel 的家庭记忆助手，像家里人发微信：温暖、简短、具体、克制。三条铁律，违反任意一条都算失败：(1) 只用用户对家人的叫法，绝不换成大名或混用两个名字；(2) 不写“已记录”类回执，不煽情不喊口号；(3) 只回应当前这一条的情绪，不与上一条凑情绪反差。不编造、不诊断、不比较。",
    );
    const reply = stickyRename(clampReply(raw), input.text, input.aliasContext);
    if (reply) return reply;
  } catch {
    // LLM failure must not fail the logging endpoint.
  }

  return stickyRename(deterministicReply(input.currentEventSummaries, input.recalled, input.signals), input.text, input.aliasContext);
}

function stickyRename(reply: string, userText: string, aliasContext?: AliasContext): string {
  if (!reply || !aliasContext?.aliases?.length) return reply;
  let out = reply;
  const aliasesByMember = new Map<string, Set<string>>();
  for (const entry of aliasContext.aliases) {
    if (!entry.memberId) continue;
    const surfaces = aliasesByMember.get(entry.memberId) || new Set<string>();
    for (const surface of [entry.alias, entry.label, entry.memberId]) {
      if (surface?.trim()) surfaces.add(surface.trim());
    }
    aliasesByMember.set(entry.memberId, surfaces);
  }

  for (const surfaces of aliasesByMember.values()) {
    const sorted = [...surfaces].sort((a, b) => b.length - a.length);
    const used = sorted.find(surface => userText.includes(surface));
    if (!used) continue;
    for (const surface of sorted) {
      if (surface === used) continue;
      out = out.split(surface).join(used);
    }
  }
  return out;
}

function deterministicReply(currentEventSummaries: string[], recalled: RecalledMemory[], signals: ContextSignals): string {
  const extracted = formatExtractedSummary(currentEventSummaries);
  if (recalled.length > 0) {
    const prefix = signals.has_negative_emotion
      ? "记下来了。听起来这件事里有不少压力和情绪起伏。"
      : "记下来了。这个细节挺有画面感的。";
    return `${prefix}这条和之前的「${recalled[0]!.summary}」有点相关，我会把它们一起放进近期脉络里。\n提取到：${extracted}`;
  }

  if (signals.has_negative_emotion) {
    return `记下来了。听起来这件事里有不少压力和情绪起伏，好在后来有一个转折。我暂时没有找到特别接近的历史片段，会先按这条独立记录整理。\n提取到：${extracted}`;
  }

  return `记下来了。这个变化挺具体的，我会先按这条独立记录整理。\n提取到：${extracted}`;
}

function formatExtractedSummary(currentEventSummaries: string[]): string {
  const summaries = currentEventSummaries.map(summary => summary.trim()).filter(Boolean);
  if (summaries.length === 0) return "暂无结构化事件，会保留原文。";
  return summaries.slice(0, 3).join("；");
}

function formatRecentDialogue(recentTurns: Array<{ role: string; content: string }>): string {
  return recentTurns
    .slice(-6)
    .map(turn => {
      const who = turn.role === "user" ? "用户" : turn.role === "assistant" ? "助手" : "系统";
      const content = turn.content.replace(/\s+/g, " ").trim();
      return `${who}: ${content.length > 80 ? `${content.slice(0, 79)}…` : content}`;
    })
    .filter(Boolean)
    .join("\n");
}

function isCurrentEvent(event: MemoryEvent, messageId: string, currentEventIds: Set<string>): boolean {
  return Boolean(
    event.raw_message_id === messageId ||
    (event.id && currentEventIds.has(event.id)),
  );
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function clampLimit(raw?: number): number {
  if (!Number.isFinite(raw)) return 6;
  return Math.min(Math.max(1, Math.floor(raw as number)), 20);
}

function clampReply(raw: string): string {
  const normalized = raw.trim().replace(/\n{3,}/g, "\n\n");
  if (!normalized) return "";
  return normalized.length > 420 ? `${normalized.slice(0, 417)}...` : normalized;
}

function normalizeDate(input?: string): string {
  return normalizeLocalDate(input);
}
