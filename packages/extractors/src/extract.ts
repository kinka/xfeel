import { getLLM } from "../../ai-client/src/llm";
import { roleLLMConfig } from "../../ai-client/src/roles";
import { MemoryEventSchema, type MemoryEvent, type Emotion, type EventType, type ClassifyResult } from "../../domain/src/memory-event";
import { getTagVocabularyPrompt, normalizeTags, TAG_ALIASES, ALL_TAGS } from "../../domain/src/tag-vocabulary";
import { getEmotionPrompt, normalizeEmotion, EMOTION_ALIASES, ALL_EMOTIONS } from "../../domain/src/emotion-vocabulary";
import {
  normalizeEmotionPayload,
  normalizeEntities,
  normalizeEventType,
} from "../../domain/src/normalization";
import { type OwnerContext, resolveOwnerContext } from "../../domain/src/owner";
import { normalizeOpenFacts } from "../../domain/src/open-facts";
import type { AliasContext } from "../../domain/src/family";
import { logWarn, safeErrorMessage, textLogFields } from "../../observability/src/logging";

const EXTRACT_SYSTEM = `你是一个家庭日记结构化抽取器。从用户的消息中提取结构化的记忆事件。

返回 JSON 数组（一条消息可能包含多个事件）：
[{
  "summary": "一句话摘要，15字以内，能独立理解",
  "original_span": "原文中支撑该事件的精确片段",
  "event_type": "sleep|feeding|health|milestone|emotion|care|conflict|work|social|daily|reflection|other",
  "entities": ["涉及的人名"],
  "emotion": {
    "primary": "主要情绪（从词表选）",
    "secondary": "次要情绪（可选）",
    "intensity": 0.0到1.0,
    "valence": "positive|negative|neutral"
  },
  "tags": ["粗标签（从词表选，只保留稳定大类）"],
  "open_facts": [{
    "kind": "symptom|food|activity|object|place|routine|work_topic|emotion_signal|developmental_skill|relationship_signal|topic",
    "value": "开放规范值，如 呕吐/冰激凌/磁力片/业绩考核",
    "surface": "原文里的具体说法，如 吐了好几次",
    "polarity": "actual|negated|hypothetical|concern",
    "actor_id": "动作发起人，可选",
    "experiencer_id": "症状/情绪体验者，可选",
    "observer_id": "观察/记录者，可选",
    "confidence": 0.0到1.0
  }],
  "event_time": "事件时间（ISO格式，不能推断则null）",
  "confidence": 0.0到1.0
}]

规则：
1. summary 要简洁准确，能独立理解，不要复制原文
2. original_span 必须是输入原文中的连续片段，不要改写；无法定位时用整条消息
3. entities 必须使用输入“身份上下文”里的 canonical label。不要根据固定家庭名臆测；昵称/别名/亲属称谓以身份上下文为准。
4. 不要输出“宝宝们/孩子们”等集合实体；遇到集合称呼时展开为身份上下文里的 collective_children。若没有给出 collective_children，保留原文称呼，后处理会兜底。
5. 输入会附带 owner/speaker 标识；当文本出现独立“我/自己”时，默认指向 speaker_label，没有 speaker_label 时指向 owner_label。但“我老婆/我老公/我妈妈/我爸爸”等整体称谓应优先按身份上下文中的 speaker-scoped alias 解析，不要额外加入“我”。
6. 如果身份上下文没有某个别名或关系，不要编造映射；可保留原文实体名交给后处理。
7. 如果消息包含多个独立事件（如"发烧去医院"+"回来路上睡着了"），拆成多个事件
8. 长段落里出现不同主题/动作时必须拆分，不要用一个 event_type 覆盖整段；例如“接娃兴奋”应是 care/亲子互动，“晚饭顺利吃完”才是 feeding，“玩磁力片”应是 daily/care，“外出旅行地点”应用 daily+旅行/外出+location，“哄睡”才是 sleep
9. event_type 选核心记忆主题，不要被段落里后出现的次要事实覆盖；食物导致呕吐/不适时核心是 health，可同时打 feeding/健康相关标签
9b. milestone 只用于真正的成长节点：第一次出现的能力或发展跨越（第一次翻身/开口叫人/自主如厕/学会新技能），成人的"人生第一次"（第一次住院/第一次全家骑行）也算；日常动作里出现"说/走/坐"不构成里程碑
10. event_time 从"今天/昨晚/上周/5月"等词推断为 ISO 格式，不能推断则 null
11. 如果消息没有明显情绪，emotion 设为 {primary:"平静", intensity:0.3, valence:"neutral"}
12. 情绪和标签必须从下方词表选择，不要自创

${getEmotionPrompt()}

${getTagVocabularyPrompt()}`;

export { type MemoryEvent };

export interface ExtractContext extends OwnerContext {}

interface RawExtractEvent {
  summary: string;
  original_span?: string | null;
  event_type: string;
  entities: string[];
  emotion: { primary: string; secondary?: string; intensity: number; valence: string };
  tags: string[];
  open_facts?: unknown[];
  event_time?: string | null;
  confidence?: number;
}

export interface ExtractWithClassificationResult {
  classification: ClassifyResult;
  events: MemoryEvent[];
  /** true 表示 LLM 抽取失败、已退化到规则兜底，结果质量不可靠，需被上层标记/重处理。 */
  degraded: boolean;
}

export async function extract(
  text: string,
  context?: string | ExtractContext,
): Promise<MemoryEvent[]> {
  const llm = getLLM(roleLLMConfig("extract"));
  const ownerContext = normalizeExtractContext(context);

  try {
    const results = await llm.chatJSON<RawExtractEvent[]>(buildExtractPrompt(text, ownerContext), EXTRACT_SYSTEM);

    return results
      .map(r => normalizeRawEvent(r, text, ownerContext))
      .filter((e): e is MemoryEvent => e !== null);
  } catch (e) {
    logWarn("extract_llm_fallback", {
      error: safeErrorMessage(e),
      ...textLogFields("text", text),
    });
    return ruleBasedExtract(text, ownerContext);
  }
}

const CLASSIFY_EXTRACT_SYSTEM = `${EXTRACT_SYSTEM}

同时你还要判断这条消息是否有记录价值。返回一个 JSON 对象：
{
  "classification": {
    "is_meaningful": true/false,
    "modality": "text"|"voice"|"image"|"video"|"mixed",
    "category": "diary"|"command"|"chat"|"noise",
    "reason": "简短理由"
  },
  "events": [上面定义的记忆事件数组]
}

如果 classification.is_meaningful=false，events 返回空数组。
如果这条消息明显是在记录事件/情绪/状态变化，classification.category 用 "diary"，is_meaningful=true。

判断记录价值时务必结合“最近对话”：如果这条消息只是对你上一句追问的简短回应、情绪附和或闲聊延续（例如“崩溃。。。”“溜到地上”“罢了”“是的”“你没看前面吗”这类承接上文、脱离上文就看不懂的短句），它属于对话而非新日记 —— classification.category 设为 "chat"、is_meaningful=false、events 返回空数组，不要把它当成独立事件抽取。只有当消息本身在记录新的事件/状态/情绪/成长（脱离上文也能独立理解）时，才算 diary。`;

export async function extractWithClassification(
  text: string,
  context?: string | ExtractContext,
  recentDialogue?: string,
): Promise<ExtractWithClassificationResult> {
  const llm = getLLM(roleLLMConfig("extract"));
  const ownerContext = normalizeExtractContext(context);

  try {
    const result = await llm.chatJSON<{
      classification?: Partial<ClassifyResult>;
      events?: RawExtractEvent[];
    }>(buildExtractPrompt(text, ownerContext, recentDialogue), CLASSIFY_EXTRACT_SYSTEM);

    const classification: ClassifyResult = {
      is_meaningful: Boolean(result.classification?.is_meaningful),
      modality: result.classification?.modality || "text",
      category: result.classification?.category || (result.events?.length ? "diary" : "noise"),
      reason: result.classification?.reason,
    };
    const events = (result.events || [])
      .map(r => normalizeRawEvent(r, text, ownerContext))
      .filter((e): e is MemoryEvent => e !== null);

    return { classification, events, degraded: false };
  } catch (e) {
    logWarn("extract_llm_fallback", {
      error: safeErrorMessage(e),
      combined: true,
      ...textLogFields("text", text),
    });
    const events = ruleBasedExtract(text, ownerContext);
    return {
      classification: {
        is_meaningful: events.length > 0,
        modality: "text",
        category: events.length > 0 ? "diary" : "noise",
        reason: "rule fallback after combined extract failure",
      },
      events,
      degraded: true,
    };
  }
}

/**
 * 标准化 LLM 返回的原始事件
 */
function normalizeRawEvent(
  r: { summary: string; original_span?: string | null; event_type: string; entities: string[]; emotion: { primary: string; secondary?: string; intensity: number; valence: string }; tags: string[]; open_facts?: unknown[]; event_time?: string | null; confidence?: number },
  originalText: string,
  ownerContext?: ExtractContext,
): MemoryEvent | null {
  const normalizedContext = resolveOwnerContext(ownerContext);
  const emotion: Emotion = normalizeEmotionPayload(r.emotion);

  // 标准化标签
  const tags = normalizeTags(r.tags || []);

  // 标准化实体名称
  const entities = normalizeEntities(r.entities || [], normalizedContext, originalText);

  const event: MemoryEvent = {
    id: crypto.randomUUID(),
    summary: ((r.summary || originalText).trim() || originalText).slice(0, 50),
    original_text: originalText,
    original_span: (r.original_span?.trim() || originalText),
    event_type: normalizeEventType(r.event_type),
    entities,
    emotion,
    tags,
    open_facts: [],
    event_time: parseEventTime(r.event_time),
    confidence: clamp(r.confidence ?? 0.8, 0, 1),
    source: "user",
    source_layer: "extracted",
    user_id: normalizedContext.ownerId,
    created_at: new Date().toISOString(),
  };
  
  event.open_facts = normalizeOpenFacts(r.open_facts || [], event);

  const parsed = MemoryEventSchema.safeParse(event);
  if (parsed.success) return parsed.data;
  console.warn("Event validation warning:", parsed.error.issues);
  return event;
}

/**
 * 规则兜底抽取（LLM 不可用时）
 * 使用词表别名做匹配，不用硬编码映射
 */
/**
 * 规则版事件类型判断（LLM 兜底路径 + 存量数据修复脚本共用）。
 * milestone 只认明确的成长信号词：单字（站/走/说/坐）在日常中文里太高频，
 * 曾把整批导入日记误标成里程碑（"培训师说…"），污染 /milestones 时间线。
 */
export function ruleEventType(text: string): EventType {
  const typePatterns: [RegExp, EventType][] = [
    [/睡|醒|眠|nap/i, "sleep"],
    [/奶|辅食|喂|吃|餐/i, "feeding"],
    [/病|烧|咳|诊|牙|疫苗|拉肚子|湿疹/i, "health"],
    [/翻身|抓握|学会|第一次|首次|出牙|长牙|会走|会站|会爬|会坐|叫妈妈|叫爸爸|里程碑/i, "milestone"],
    [/工作|客户|项目|加班|会议/i, "work"],
    [/洗澡|换尿布|抚触|遛|早教/i, "care"],
    [/吵架|矛盾|婆媳|争执/i, "conflict"],
  ];
  for (const [pattern, type] of typePatterns) {
    if (pattern.test(text)) return type;
  }
  return "other";
}

export function ruleBasedExtract(
  text: string,
  context?: string | ExtractContext,
): MemoryEvent[] {
  const events: MemoryEvent[] = [];
  const ownerContext = normalizeExtractContext(context);

  // 实体识别：内置只保留通用角色/集合称谓，具体家人名来自运行时 profile/aliasContext。
  const entityPatterns = [
    "妈妈", "爸爸", "外婆", "外公", "奶奶", "爷爷",
    "宝宝们", "两个宝宝", "两个孩子", "宝宝", "孩子们", "孩子", "俩宝", "俩娃", "双胞胎",
    "我老婆", "我老公", "老公", "老婆", "我", "自己",
  ];
  const profileAliases = ownerContext.aliasContext?.aliases?.map(alias => alias.alias) || [];
  const profileLabels = ownerContext.aliasContext?.aliases?.map(alias => alias.label) || [];
  const rawEntities = [...new Set([...profileAliases, ...profileLabels, ...entityPatterns])]
    .filter(entity => entity && text.includes(entity));
  const entities = normalizeEntities(rawEntities, ownerContext, text);

  // 情绪识别（用词表别名）
  let emotion: Emotion = { primary: "平静", intensity: 0.3, valence: "neutral" };
  // 先检查别名
  for (const [alias] of Object.entries(EMOTION_ALIASES)) {
    if (text.includes(alias)) {
      const normalized = normalizeEmotion(alias);
      if (normalized) {
        emotion = { primary: normalized.word as Emotion["primary"], intensity: 0.7, valence: normalized.valence as Emotion["valence"] };
        break;
      }
    }
  }
  // 再检查标准词
  if (emotion.primary === "平静") {
    for (const word of ALL_EMOTIONS) {
      if (text.includes(word)) {
        const normalized = normalizeEmotion(word);
        if (normalized) {
          emotion = { primary: normalized.word as Emotion["primary"], intensity: 0.7, valence: normalized.valence as Emotion["valence"] };
          break;
        }
      }
    }
  }

  // 事件类型识别
  const eventType = ruleEventType(text);

  // 标签识别（用词表 + 别名）
  const tags: string[] = [];
  // 先检查别名
  for (const [alias, standard] of Object.entries(TAG_ALIASES)) {
    if (text.includes(alias) && !tags.includes(standard)) tags.push(standard);
  }
  // 再检查标准标签
  for (const tag of ALL_TAGS) {
    if (text.includes(tag) && !tags.includes(tag)) tags.push(tag);
  }

  // 时间推断
  const eventTime = parseRelativeTime(text);

  const fallbackEvent: MemoryEvent = {
    id: crypto.randomUUID(),
    summary: text.length > 50 ? text.slice(0, 50) + "..." : text,
    original_text: text,
    original_span: text,
    event_type: eventType,
    entities,
    emotion,
    tags,
    open_facts: [],
    event_time: eventTime || undefined,
    confidence: 0.5,
    source: "user",
    source_layer: "extracted",
    user_id: ownerContext.ownerId,
    created_at: new Date().toISOString(),
  };
  fallbackEvent.open_facts = normalizeOpenFacts([], fallbackEvent);
  events.push(fallbackEvent);

  return events;
}

/**
 * 解析相对时间词为 ISO 格式
 */
function parseRelativeTime(text: string): string | null {
  const now = new Date();
  const patterns: [RegExp, (m: RegExpMatchArray) => Date][] = [
    [/今天|今晚|今早|今晨/, () => now],
    [/昨晚|昨天/, () => { const d = new Date(now); d.setDate(d.getDate() - 1); return d; }],
    [/前天/, () => { const d = new Date(now); d.setDate(d.getDate() - 2); return d; }],
    [/上周/, () => { const d = new Date(now); d.setDate(d.getDate() - 7); return d; }],
    [/上个月/, () => { const d = new Date(now); d.setMonth(d.getMonth() - 1); return d; }],
    [/(\d+)天前/, (m) => { const d = new Date(now); d.setDate(d.getDate() - parseInt(m[1])); return d; }],
    [/(\d+)个月前/, (m) => { const d = new Date(now); d.setMonth(d.getMonth() - parseInt(m[1])); return d; }],
  ];
  
  for (const [pattern, calc] of patterns) {
    const m = text.match(pattern);
    if (m) return calc(m).toISOString();
  }
  return null;
}

/**
 * 解析 event_time 字段
 */
function parseEventTime(raw?: string | null): string | undefined {
  if (!raw || raw === "null" || raw === "undefined") return undefined;
  try {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  } catch {
    return undefined;
  }
}

function normalizeExtractContext(context?: string | ExtractContext): ExtractContext {
  if (typeof context === "string") {
    return resolveOwnerContext({ ownerId: context, speakerId: context });
  }
  return resolveOwnerContext(context);
}

export function buildExtractPrompt(text: string, context: ExtractContext, recentDialogue?: string): string {
  const lines = ["请从以下消息中提取记忆事件。"];

  const trimmedDialogue = recentDialogue?.trim();
  if (trimmedDialogue) {
    lines.push("");
    lines.push("最近对话（仅用于判断这条消息是不是对你上一句追问的简短延续回应；不要据此抽取新事件）：");
    lines.push(trimmedDialogue);
  }

  if (context.ownerId || context.ownerLabel || context.speakerId || context.speakerLabel) {
    lines.push("");
    lines.push("上下文标识：");
    lines.push(`owner_id=${context.ownerId || "unknown"}`);
    lines.push(`owner_label=${context.ownerLabel || "未知"}`);
    lines.push(`speaker_id=${context.speakerId || context.ownerId || "unknown"}`);
    lines.push(`speaker_label=${context.speakerLabel || context.ownerLabel || "未知"}`);
  }

  const aliasContext = context.aliasContext;
  if (aliasContext) {
    lines.push("");
    lines.push("身份上下文（实体解析必须以此为准）：");
    lines.push(`family_id=${aliasContext.familyId || "unknown"}`);
    lines.push(`speaker_profile_id=${aliasContext.speakerProfileId || context.speakerId || "unknown"}`);
    lines.push(`self_member_id=${aliasContext.selfMemberId || "unknown"}`);
    lines.push(`self_label=${aliasContext.selfLabel || context.speakerLabel || "未知"}`);
    if (aliasContext.collectiveChildren?.length) {
      lines.push(`collective_children=${aliasContext.collectiveChildren.join("、")}`);
    }
    if (aliasContext.aliases?.length) {
      lines.push("aliases:");
      for (const alias of sortedAliases(aliasContext)) {
        const scope = alias.scope || "global";
        const speakerSuffix = alias.speakerProfileId ? ` speaker=${alias.speakerProfileId}` : "";
        const relationSuffix = alias.relation ? ` relation=${alias.relation}` : "";
        lines.push(`- ${alias.alias} => ${alias.label} (${scope}${speakerSuffix}${relationSuffix})`);
      }
    }
    lines.push("实体输出要求：entities 只能优先输出上述 canonical label；集合称呼展开为 collective_children；speaker-scoped alias 只在当前 speaker 下生效。");
  }

  lines.push("");
  lines.push("消息正文：");
  lines.push(`"${text}"`);
  return lines.join("\n");
}

function sortedAliases(context: AliasContext) {
  return [...(context.aliases || [])].sort((a, b) => {
    const aScoped = a.scope === "speaker" ? 0 : 1;
    const bScoped = b.scope === "speaker" ? 0 : 1;
    if (aScoped !== bScoped) return aScoped - bScoped;
    return b.alias.length - a.alias.length || a.alias.localeCompare(b.alias, "zh-Hans-CN");
  });
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
