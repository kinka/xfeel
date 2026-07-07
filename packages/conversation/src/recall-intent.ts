import { getLLM } from "../../ai-client/src/llm";
import { roleLLMConfig } from "../../ai-client/src/roles";
import { getDB } from "../../db/src/database";
import { getEntityLexiconForOwner, getMemberLabels } from "../../db/src/family";
import { queryEvents } from "../../retrieval/src/events-query";
import { ALL_EMOTIONS, normalizeEmotion } from "../../domain/src/emotion-vocabulary";

/**
 * 检索意图识别：把"X 上次/更早/最早什么时候 Y"这类记忆提问（含省略句），
 * 解析成结构化检索条件，路由到严格的 queryEvents（emotion/entity/date/order 硬过滤），
 * 而不是模糊的语义/全文召回。这是 recall 拼图里缺的最后一块。
 *
 * 意图识别用 intent 角色模型，失败时降级到规则解析。
 */
export type RecallDirection = "latest" | "earlier" | "earliest" | "recent" | "all";

export interface RecallIntent {
  isMemoryQuery: boolean;
  emotions: string[];
  entities: string[];
  event_types: string[];
  direction: RecallDirection;
  anchorDate?: string; // YYYY-MM-DD，用于"更早"的锚点（通常来自上一轮回答）
}

export interface RecalledItem {
  id?: string;
  summary: string;
  event_time?: string;
  emotion?: string;
  /** 家庭共享记忆：这条由哪位家人记录（如"爸爸"）；仅当不是说话人本人时填，用于回答里点明来源。 */
  recorder?: string;
}

// 规则兜底用：surface → 规范实体名（通用称谓基础映射；具体家人名/昵称由运行时家庭词典合并进来，
// 避免"阿星"这类昵称查不到入库的规范名）。
const GENERIC_ENTITY_CANON: Record<string, string> = {
  "爸爸": "爸爸", "老公": "爸爸", "父亲": "爸爸",
  "妈妈": "妈妈", "老婆": "妈妈", "母亲": "妈妈",
  "外婆": "外婆", "外公": "外公", "奶奶": "奶奶", "爷爷": "爷爷",
  "宝宝们": "宝宝们",
};

/** owner 所在家庭的 surface → 规范名映射（通用称谓 + 家庭别名表） */
export function entityCanonForOwner(ownerId?: string): Record<string, string> {
  try {
    return { ...GENERIC_ENTITY_CANON, ...getEntityLexiconForOwner(ownerId).aliasToLabel };
  } catch {
    return { ...GENERIC_ENTITY_CANON };
  }
}

function canonizeEntities(entities: string[], canon: Record<string, string>): string[] {
  return [...new Set(entities.map(entity => canon[entity] || entity))];
}
const DATE_RE = /(\d{4})-(\d{2})-(\d{2})/g;

const INTENT_SYSTEM = `你是 xfeel 家庭记忆助手的"检索意图识别器"。用户在回顾家庭/工作/情绪历史时，可能这样问：
"爸爸上次压力大是什么时候"、"更早之前呢"、"孩子最早什么时候发烧"、"这周我崩溃过吗"。
请结合"最近对话"理解省略句（例如上一句在问压力，这一句"更早之前呢"仍是问压力），输出 JSON：
{
  "isMemoryQuery": true/false,      // 是否在检索过去的记忆/记录
  "emotions": ["压力"],             // 涉及的情绪词，从给定词表里选，没有则[]
  "entities": ["爸爸"],             // 涉及的人物，没有则[]
  "event_types": [],                // 如 sleep/feeding/health/work 等，没有则[]
  "direction": "latest|earlier|earliest|recent|all", // 上次=latest，更早/之前=earlier，最早/第一次=earliest，这周/最近=recent
  "anchorDate": "YYYY-MM-DD"        // "更早"相对的锚点日期，通常是上一轮回答里提到的日期；没有则省略
}
情绪词表：${ALL_EMOTIONS.join("、")}`;

export async function resolveRecallIntent(text: string, recentDialogue?: string, entityCanon?: Record<string, string>): Promise<RecallIntent> {
  const canon = entityCanon || GENERIC_ENTITY_CANON;
  try {
    const parsed = await getLLM(roleLLMConfig("intent")).chatJSON<Partial<RecallIntent>>(
      `最近对话：\n${recentDialogue || "（无）"}\n\n当前消息：${text}`,
      INTENT_SYSTEM,
    );
    const direction = normalizeDirection(parsed.direction);
    return {
      isMemoryQuery: Boolean(parsed.isMemoryQuery),
      emotions: normalizeEmotions(parsed.emotions),
      entities: Array.isArray(parsed.entities)
        ? canonizeEntities(parsed.entities.filter(e => typeof e === "string" && e.trim()).map(e => e.trim()), canon)
        : [],
      event_types: Array.isArray(parsed.event_types) ? parsed.event_types.filter(e => typeof e === "string" && e.trim()) : [],
      direction,
      anchorDate: normalizeAnchor(parsed.anchorDate) || (direction === "earlier" ? extractLatestDate(recentDialogue) : undefined),
    };
  } catch {
    return ruleBasedRecallIntent(text, recentDialogue, canon);
  }
}

export function ruleBasedRecallIntent(text: string, recentDialogue?: string, entityCanon?: Record<string, string>): RecallIntent {
  const canon = entityCanon || GENERIC_ENTITY_CANON;
  const emotions = normalizeEmotions(ALL_EMOTIONS.filter(e => text.includes(e)));
  const entities = [...new Set(
    Object.entries(canon).filter(([surface]) => text.includes(surface)).map(([, c]) => c),
  )];
  const direction = ruleDirection(text);
  const carriedEmotions = emotions.length === 0 && isEllipsisFollowUp(text) ? extractEmotionsFrom(recentDialogue) : [];
  const finalEmotions = emotions.length ? emotions : carriedEmotions;
  const isMemoryQuery = hasRecallSignal(text) || (finalEmotions.length > 0 && /[?？吗]|什么时候|哪天|何时/.test(text));
  return {
    isMemoryQuery,
    emotions: finalEmotions,
    entities,
    event_types: [],
    direction,
    anchorDate: direction === "earlier" ? extractLatestDate(recentDialogue) : undefined,
  };
}

/**
 * 结构化召回：解析检索意图→严格 queryEvents。
 * 返回 null = 不是结构化记忆提问，调用方应降级到模糊召回；
 * 返回数组（含空）= 结构化检索已执行，按结果作答。
 */
export async function recallByIntent(input: {
  text: string;
  owner_id?: string;
  recentDialogue?: string;
  limit?: number;
}): Promise<RecalledItem[] | null> {
  const intent = await resolveRecallIntent(input.text, input.recentDialogue, entityCanonForOwner(input.owner_id));
  // 只有"情绪/事件类型"这种强结构信号才由严格层接管（并在空结果时如实作答）。
  // 仅有实体或纯话题的提问留给模糊召回（FTS/语义对它们更稳，也避免实体规范化偏差误判）。
  const hasStrongFilter = intent.emotions.length > 0 || intent.event_types.length > 0;
  if (!intent.isMemoryQuery || !hasStrongFilter) return null;
  return executeRecallIntent(intent, { owner_id: input.owner_id, limit: input.limit });
}

/** 用已结构化的检索意图直接查严格层 queryEvents（不再调用 LLM 解析），供工具/外部复用。 */
export function executeRecallIntent(intent: RecallIntent, input: { owner_id?: string; scope_owner_ids?: string[]; limit?: number }): RecalledItem[] {
  const limit = Math.min(Math.max(1, Math.floor(input.limit || 6)), 20);
  const order: "asc" | "desc" = intent.direction === "earliest" ? "asc" : "desc";
  const until = intent.direction === "earlier" && intent.anchorDate ? addDays(intent.anchorDate, -1) : undefined;
  const since = intent.direction === "recent" ? undefined : undefined; // recent 暂不强制下界，靠排序取近

  const db = getDB();
  const emotions = intent.emotions.length ? intent.emotions : [undefined];
  const entities = intent.entities.length ? intent.entities : [undefined];
  const eventType = intent.event_types[0];

  // 家庭共享记忆：对非说话人本人记的事件标注记录者称呼。
  const recorderLabels = input.scope_owner_ids?.length ? getMemberLabels(input.scope_owner_ids) : undefined;
  const recorderFor = (userId?: string) => (recorderLabels && userId && userId !== input.owner_id ? recorderLabels.get(userId) : undefined);

  const merged = new Map<string, RecalledItem & { sortKey: string }>();
  for (const emotion of emotions) {
    for (const entity of entities) {
      const rows = queryEvents(db, {
        owner: input.owner_id,
        owners: input.scope_owner_ids,
        emotion,
        entity,
        type: eventType,
        until,
        since,
        order,
        limit: limit * 2,
      }).events as Array<Record<string, unknown>>;
      for (const row of rows) {
        const id = String(row.id ?? "");
        if (merged.has(id)) continue;
        const eventTime = (row.event_time as string) || (row.event_date as string) || (row.created_at as string) || "";
        merged.set(id, {
          id,
          summary: String(row.summary ?? ""),
          event_time: (row.event_time as string) || (row.event_date as string) || undefined,
          emotion: parseEmotionPrimary(row.emotion),
          recorder: recorderFor(row.user_id as string | undefined),
          sortKey: eventTime,
        });
      }
    }
  }

  const items = [...merged.values()].sort((a, b) =>
    order === "asc" ? a.sortKey.localeCompare(b.sortKey) : b.sortKey.localeCompare(a.sortKey),
  );
  return items.slice(0, limit).map(({ sortKey, ...item }) => item);
}

// ---- helpers ----

function hasRecallSignal(text: string): boolean {
  return /上次|上一次|之前|以前|历史|记得|记录|什么时候|哪天|何时|最早|更早|第一次|这周|本周|最近|近来|近况/.test(text);
}

function isEllipsisFollowUp(text: string): boolean {
  return /^(更早之前呢|更早呢|再早呢|之前呢|那之前呢|更久之前呢|那更早呢)[?？。\s]*$/.test(text.trim()) || text.trim().length <= 6;
}

function ruleDirection(text: string): RecallDirection {
  if (/最早|最开始|第一次|最初/.test(text)) return "earliest";
  if (/更早|再早|更久|之前呢|那之前/.test(text)) return "earlier";
  if (/这周|本周|这几天|最近|近来|近况/.test(text)) return "recent";
  if (/上次|上一次|最近一次/.test(text)) return "latest";
  return "latest";
}

function normalizeDirection(raw?: string): RecallDirection {
  return raw === "earlier" || raw === "earliest" || raw === "recent" || raw === "all" || raw === "latest" ? raw : "latest";
}

function normalizeEmotions(raw?: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const normalized = normalizeEmotion(item);
    if (normalized) out.add(normalized.word);
  }
  return [...out];
}

function extractEmotionsFrom(dialogue?: string): string[] {
  if (!dialogue) return [];
  // 省略追问（如“更早之前呢”）只继承最近一轮话题，不能把整段上下文里出现过的
  // 所有情绪都混进过滤条件，否则会把“压力”的追问扩大成“压力/焦虑”等合集。
  const lines = dialogue.split(/\n+/).map(line => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    const emotions = normalizeEmotions(ALL_EMOTIONS.filter(e => line.includes(e)));
    if (emotions.length) return emotions;
  }
  return [];
}

function normalizeAnchor(raw?: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

function extractLatestDate(dialogue?: string): string | undefined {
  if (!dialogue) return undefined;
  const matches = [...dialogue.matchAll(DATE_RE)].map(m => `${m[1]}-${m[2]}-${m[3]}`);
  return matches.length ? matches.sort().at(-1) : undefined;
}

function parseEmotionPrimary(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    return (JSON.parse(raw) as { primary?: string }).primary;
  } catch {
    return undefined;
  }
}

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
