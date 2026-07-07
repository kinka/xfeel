import type { MemoryEvent } from "./memory-event";

export const OPEN_FACT_KINDS = [
  "symptom",
  "food",
  "activity",
  "object",
  "place",
  "routine",
  "work_topic",
  "emotion_signal",
  "developmental_skill",
  "relationship_signal",
  "topic",
] as const;

export type OpenFactKind = typeof OPEN_FACT_KINDS[number];

export interface OpenFact {
  id?: string;
  event_id?: string;
  kind: OpenFactKind;
  value: string;
  surface: string;
  evidence_span?: [number, number];
  confidence?: number;
  polarity?: "actual" | "negated" | "hypothetical" | "concern";
  actor_id?: string;
  experiencer_id?: string;
  observer_id?: string;
}

const KIND_SET = new Set<string>(OPEN_FACT_KINDS);

export function normalizeOpenFacts(raw: unknown, event?: Pick<MemoryEvent, "id" | "original_text" | "original_span" | "summary" | "tags" | "entities" | "location" | "event_type" | "emotion">): OpenFact[] {
  const candidates = Array.isArray(raw) ? raw : [];
  const out: OpenFact[] = [];
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const kind = typeof rec.kind === "string" && KIND_SET.has(rec.kind) ? rec.kind as OpenFactKind : "topic";
    const value = cleanString(rec.value) || cleanString(rec.surface);
    const surface = cleanString(rec.surface) || value;
    if (!value || !surface) continue;
    const fact: OpenFact = {
      id: cleanString(rec.id) || undefined,
      event_id: cleanString(rec.event_id) || event?.id,
      kind,
      value,
      surface,
      confidence: clampNumber(rec.confidence, 0, 1) ?? 0.75,
      polarity: normalizePolarity(rec.polarity),
      actor_id: cleanString(rec.actor_id) || undefined,
      experiencer_id: cleanString(rec.experiencer_id) || undefined,
      observer_id: cleanString(rec.observer_id) || undefined,
    };
    const span = normalizeSpan(rec.evidence_span);
    if (span) fact.evidence_span = span;
    out.push(fact);
  }

  // legacy 关键词派生仅作兜底：当 LLM 已抽出结构化 open_facts 时不再无条件追加。
  // 否则关键词正则会在整条消息的 original_text 上匹配，把全文里的词（如"虾"）泄漏到
  // 该消息每个子事件上，造成跨事件误标/重复。只有在没有任何结构化 facts（典型是
  // 规则降级路径，单事件=整条消息）时才回填。见 docs/decommission-knowledge-graph.md
  if (event && out.length === 0) {
    out.push(...deriveOpenFactsFromLegacy(event));
  }

  return dedupeFacts(out).map((fact, index) => ({
    ...fact,
    id: fact.id || stableFactId(event?.id || "event", fact, index),
    event_id: fact.event_id || event?.id,
  }));
}

export function deriveOpenFactsFromLegacy(event: Pick<MemoryEvent, "id" | "original_text" | "original_span" | "summary" | "tags" | "entities" | "location" | "event_type" | "emotion">): OpenFact[] {
  const text = [event.original_span, event.summary, event.original_text, ...(event.tags || [])].filter(Boolean).join(" ");
  const facts: OpenFact[] = [];
  const add = (kind: OpenFactKind, value: string, surface = value, confidence = 0.68) => {
    if (!value || !surface) return;
    facts.push({ kind, value, surface, confidence, polarity: inferPolarity(text, surface), event_id: event.id });
  };

  for (const tag of event.tags || []) add(classifyLegacyTag(tag), tag, tag, 0.62);
  if (event.location) add("place", event.location, event.location, 0.8);
  // 已移除两段噪声派生（2026-06）：
  //  - entities → topic@0.55：把实体原样塞成 topic（value===surface、含泛称），与实体层重复、无归一价值。
  //  - emotion.primary → emotion_signal@0.7：与事件 emotion 字段重复。
  // 真·情绪/主题信号交由 LLM 抽取（高置信、value≠surface、可带角色），见 docs。

  const patterns: Array<[RegExp, OpenFactKind, string]> = [
    [/吐|呕吐|上吐下泻/g, "symptom", "呕吐"],
    [/拉肚子|腹泻/g, "symptom", "腹泻"],
    [/咳嗽|夜咳/g, "symptom", "咳嗽"],
    [/发烧|低烧|高烧/g, "symptom", "发烧"],
    [/冰激凌|冰淇淋/g, "food", "冰激凌"],
    [/虾|青菜|辅食|奶粉|母乳/g, "food", "食物/喂养"],
    [/磁力片/g, "object", "磁力片"],
    [/绘本/g, "object", "绘本"],
    [/柯基|狗狗/g, "object", "柯基/狗狗"],
    [/接娃|送娃/g, "routine", "接送娃"],
    [/哄睡|带睡/g, "routine", "哄睡/带睡"],
    [/看海浪|海浪/g, "activity", "看海浪"],
    [/玩磁力片/g, "activity", "玩磁力片"],
    [/顺德|鲘门|海门|清远|森波拉/g, "place", "外出地点"],
    [/业绩|考核|绩效/g, "work_topic", "业绩考核"],
    [/客户水单|水单/g, "work_topic", "客户水单"],
    [/崩溃|焦虑|压力|疲惫|担心|心疼/g, "emotion_signal", "压力/负面情绪"],
    [/摇呀摇|摇腿|兴奋/g, "activity", "兴奋动作"],
  ];
  for (const [regex, kind, value] of patterns) {
    for (const match of text.matchAll(regex)) add(kind, value, match[0], 0.78);
  }

  return dedupeFacts(facts);
}

export function factsToSearchText(facts?: OpenFact[]): string {
  return (facts || [])
    .flatMap(fact => [fact.kind, fact.value, fact.surface, fact.actor_id, fact.experiencer_id, fact.observer_id, fact.polarity])
    .filter(Boolean)
    .join(" ");
}

function classifyLegacyTag(tag: string): OpenFactKind {
  if (/咳嗽|感冒|发烧|腹泻|湿疹|便秘|疫苗|健康|生病|呕吐|吐/.test(tag)) return "symptom";
  if (/辅食|进食|吃饭|奶|喂养/.test(tag)) return "food";
  if (/外出|旅行|公园|游乐场|温泉/.test(tag)) return "activity";
  if (/工作|项目|客户|业绩|考核|压力/.test(tag)) return "work_topic";
  if (/睡|哄睡|夜醒/.test(tag)) return "routine";
  if (/玩具|绘本|磁力片/.test(tag)) return "object";
  if (/开心|崩溃|担心|焦虑|疲惫|心疼|释然/.test(tag)) return "emotion_signal";
  return "topic";
}

function inferPolarity(text: string, surface: string): OpenFact["polarity"] {
  const index = text.indexOf(surface);
  const window = index >= 0 ? text.slice(Math.max(0, index - 8), index + surface.length + 8) : text;
  if (/没有|没再|未|不是|不再/.test(window)) return "negated";
  if (/担心|怕|可能|会不会|差点/.test(window)) return "concern";
  return "actual";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

function normalizePolarity(value: unknown): OpenFact["polarity"] {
  return value === "negated" || value === "hypothetical" || value === "concern" ? value : "actual";
}

function normalizeSpan(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const a = Number(value[0]);
  const b = Number(value[1]);
  return Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= a ? [a, b] : undefined;
}

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

function dedupeFacts(facts: OpenFact[]): OpenFact[] {
  const seen = new Set<string>();
  const out: OpenFact[] = [];
  for (const fact of facts) {
    const key = `${fact.kind}\u0000${fact.value}\u0000${fact.surface}\u0000${fact.polarity || "actual"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  return out;
}

function stableFactId(eventId: string, fact: OpenFact, index: number): string {
  let hash = 2166136261;
  for (const char of `${eventId}|${fact.kind}|${fact.value}|${fact.surface}|${index}`) {
    hash ^= char.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return `${eventId}:fact:${(hash >>> 0).toString(36)}`;
}
