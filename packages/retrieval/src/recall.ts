import { getDB, getEmbeddingDB } from "../../db/src/database";
import type { MemoryEvent } from "../../domain/src/memory-event";
import { normalizeTag } from "../../domain/src/tag-vocabulary";
import { normalizeEmotion } from "../../domain/src/emotion-vocabulary";
import { normalizeEntities, normalizeEventType } from "../../domain/src/normalization";
import { normalizeOwnerId, resolveOwnerContext } from "../../domain/src/owner";
import { buildCanonicalSearchText } from "../../domain/src/search-text";
import { normalizeOpenFacts } from "../../domain/src/open-facts";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_OLLAMA_BASE_URL, cosine, embedTexts, readEmbeddingVector, type StoredEmbeddingRow } from "../../../scripts/embedding-common";
import { getEntityLexiconForOwner } from "../../db/src/family";
import { expandRecallQuery, type RecallQueryExpansion } from "./query-expansion";

export interface RecallQuery {
  text?: string;
  entities?: string[];
  event_types?: string[];
  emotions?: string[];
  tags?: string[];
  valence?: "positive" | "negative" | "neutral";
  date_from?: string;
  date_to?: string;
  owner_id?: string;
  user_id?: string;
  /**
   * 家庭共享记忆：召回的 owner 池集合。给定时召回会跨这些池扇出（user_id IN ...），
   * owner_id（说话人本人）仍用于自池加权与"我"归一。缺省时退化为 [owner_id]（仅自己）。
   */
  scope_owner_ids?: string[];
  limit?: number;
  order?: "newest" | "oldest" | "emotion_intensity";
}

export interface RecallResult {
  events: MemoryEvent[];
  // Number of scored candidates before applying the requested limit.
  // This preserves the existing recall() contract and is not a full table count.
  total: number;
  query: RecallQuery;
  diagnostics?: RecallDiagnostics;
}

export interface RecallOptions {
  expansion?: boolean;
  candidateLimitMode?: RecallCandidateLimitMode;
}

export interface HybridRecallOptions extends RecallOptions {
  embeddingModel?: string;
  embeddingBaseUrl?: string;
  embeddingThreshold?: number;
  embeddingCandidateLimit?: number;
}

export interface RecallDiagnostics {
  query_expansion: {
    enabled: boolean;
    variant: "baseline" | "deterministic_v1";
    candidate_limit: number;
    candidate_limit_mode: RecallCandidateLimitMode;
    search_terms: string[];
    expansion?: RecallQueryExpansion;
  };
  hybrid?: {
    enabled: boolean;
    embedding_model: string;
    embedding_threshold: number;
    lexical_candidates: number;
    embedding_candidates: number;
    hits?: HybridHitDiagnostic[];
  };
}

export interface HybridHitDiagnostic {
  event_id?: string;
  rank: number;
  source: "lexical" | "embedding" | "hybrid";
  score: number;
  lexical_rank?: number;
  lexical_score?: number;
  semantic_rank?: number;
  semantic_score?: number;
  target_type?: string;
  fact_kind?: string | null;
}

export type RecallCandidateLimitMode = "auto" | "baseline" | "expanded";

type SqlParam = string | number | bigint | boolean | Uint8Array | null;

interface CandidateRow extends Record<string, unknown> {
  _fts_score?: number;
}

const EVENT_DATE_EXPR = "COALESCE(NULLIF(me.event_date, ''), date(me.event_time), substr(me.event_time, 1, 10), date(me.created_at, 'localtime'), substr(me.created_at, 1, 10))";
const EVENT_ORDER_EXPR = "COALESCE(me.event_time, NULLIF(me.event_date, ''), me.created_at)";
export const DEFAULT_QUERY_EXPANSION = true;
// 自己池命中给满加权；家庭其他成员池命中给较小加权——"优先我的记忆，家人的作补充"。
const SELF_OWNER_BOOST = 10;
const FAMILY_OWNER_BOOST = 3;

/** 查询扩展用的家庭实体词典：按说话人（或 scope 内任一 owner）取其家庭的别名表；查不到时返回 undefined，扩展只用通用词。 */
function familyLexiconFor(query: RecallQuery): { aliasToLabel: Record<string, string>; collectiveChildren: string[] } | undefined {
  try {
    const candidates = [query.owner_id, query.user_id, ...(query.scope_owner_ids || [])];
    for (const ownerId of candidates) {
      if (!ownerId) continue;
      const lexicon = getEntityLexiconForOwner(ownerId);
      if (lexicon.labels.length) return lexicon;
    }
  } catch { /* db 不可用时退化为通用扩展 */ }
  return undefined;
}

/** 召回的 owner 过滤集合：有 scope_owner_ids 用之（已含说话人），否则退化为 [owner_id]。 */
function recallOwnerFilter(query: RecallQuery): string[] {
  if (query.scope_owner_ids?.length) return query.scope_owner_ids;
  if (query.owner_id) return [query.owner_id];
  return [];
}

export function recall(query: RecallQuery, options: RecallOptions = {}): RecallResult {
  const db = getDB();
  const ownerContext = resolveOwnerContext({ ownerId: query.owner_id, userId: query.user_id });
  const normalizedQuery = normalizeRecallQuery(query, ownerContext);
  const expansionEnabled = options.expansion ?? DEFAULT_QUERY_EXPANSION;
  const expansion = expansionEnabled && normalizedQuery.text
    ? expandRecallQuery(normalizedQuery.text, familyLexiconFor(normalizedQuery))
    : undefined;
  const limit = Math.min(Math.max(1, Math.floor(query.limit || 20)), 100);

  const candidateLimitMode = options.candidateLimitMode || "auto";
  const candidateLimit = resolveCandidateLimit(limit, Boolean(expansion), candidateLimitMode);
  const ftsTerms = buildSearchTerms(normalizedQuery, expansion);
  let hard = buildHardFilters(normalizedQuery);
  let rows = runCandidateQueries(hard, ftsTerms, candidateLimit);

  if (rows.length === 0) {
    rows = runStructuredCandidateQuery(hard, candidateLimit);
  }
  if (rows.length === 0 && shouldRelaxSoftFilters(normalizedQuery)) {
    hard = buildHardFilters(normalizedQuery, { dropValence: true, dropEmotions: true });
    rows = runCandidateQueries(hard, ftsTerms, candidateLimit);
    if (rows.length === 0) rows = runStructuredCandidateQuery(hard, candidateLimit);
  }
  if (rows.length === 0 && normalizedQuery.entities?.length) {
    hard = buildHardFilters(normalizedQuery, { dropValence: true, dropEmotions: true, dropEntities: true });
    rows = runCandidateQueries(hard, ftsTerms, candidateLimit);
    if (rows.length === 0) rows = runStructuredCandidateQuery(hard, candidateLimit);
  }
  if (rows.length === 0 && normalizedQuery.event_types?.length) {
    hard = buildHardFilters(normalizedQuery, { dropValence: true, dropEmotions: true, dropEntities: true, dropEventTypes: true });
    rows = runCandidateQueries(hard, ftsTerms, candidateLimit);
    if (rows.length === 0) rows = runStructuredCandidateQuery(hard, candidateLimit);
  }

  const scored = rows
    .map((row, index) => ({ event: rowToEvent(row), score: scoreCandidate(row, normalizedQuery, index, ftsTerms, expansion), index }))
    .filter(({ score }) => score > Number.NEGATIVE_INFINITY)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (query.order === "oldest") return (a.event.event_time || "").localeCompare(b.event.event_time || "");
      if (query.order === "emotion_intensity") return (b.event.emotion?.intensity || 0) - (a.event.emotion?.intensity || 0);
      return (b.event.event_time || b.event.created_at || "").localeCompare(a.event.event_time || a.event.created_at || "");
    });

  const events = scored.slice(0, limit).map(({ event }) => event);
  return {
    events,
    total: scored.length,
    query,
    diagnostics: {
      query_expansion: {
        enabled: expansionEnabled,
        variant: expansionEnabled ? "deterministic_v1" : "baseline",
        candidate_limit: candidateLimit,
        candidate_limit_mode: candidateLimitMode,
        search_terms: ftsTerms,
        ...(expansion ? { expansion } : {}),
      },
    },
  };
}

export async function recallHybrid(query: RecallQuery, options: HybridRecallOptions = {}): Promise<RecallResult> {
  const lexical = recall(query, options);
  if (!query.text?.trim() || (!query.owner_id && !query.user_id)) return lexical;

  const model = options.embeddingModel || DEFAULT_EMBEDDING_MODEL;
  const threshold = options.embeddingThreshold ?? 0.42;
  const candidateLimit = Math.max(options.embeddingCandidateLimit || 80, query.limit || 20);
  const speakerOwnerId = normalizeOwnerId(query.owner_id ?? query.user_id);
  const scopeOwnerIds = query.scope_owner_ids?.length
    ? [...new Set([...(speakerOwnerId ? [speakerOwnerId] : []), ...query.scope_owner_ids.map(id => normalizeOwnerId(id))].filter(Boolean) as string[])]
    : (speakerOwnerId ? [speakerOwnerId] : []);
  const embeddingRows = await runEmbeddingCandidateQuery({
    text: query.text,
    ownerIds: scopeOwnerIds,
    model,
    baseUrl: options.embeddingBaseUrl || DEFAULT_OLLAMA_BASE_URL,
    threshold,
    limit: candidateLimit,
  });

  const byId = new Map<string, {
    event: MemoryEvent;
    score: number;
    index: number;
    lexical_rank?: number;
    lexical_score?: number;
    semantic_rank?: number;
    semantic_score?: number;
    target_type?: string;
    fact_kind?: string | null;
  }>();
  lexical.events.forEach((event, index) => {
    if (!event.id) return;
    const lexicalScore = 100 - index;
    byId.set(event.id, { event, score: lexicalScore, index, lexical_rank: index + 1, lexical_score: lexicalScore });
  });
  embeddingRows.forEach((hit, index) => {
    const eventId = hit.event.id || "";
    if (!eventId) return;
    const existing = byId.get(eventId);
    const targetBoost = hit.target_type === "fact" ? 8 : hit.target_type === "event" ? 4 : 2;
    const score = hit.semantic_score * 100 + targetBoost - index * 0.01;
    const next = existing || { event: hit.event, score: 0, index: lexical.events.length + index };
    next.score += score;
    next.semantic_rank = index + 1;
    next.semantic_score = hit.semantic_score;
    next.target_type = hit.target_type;
    next.fact_kind = hit.fact_kind;
    byId.set(eventId, next);
  });

  const limit = Math.min(Math.max(1, Math.floor(query.limit || 20)), 100);
  const ranked = [...byId.values()]
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const merged = ranked.slice(0, limit).map(item => item.event);
  const hitDiagnostics: HybridHitDiagnostic[] = ranked.slice(0, Math.max(limit, 10)).map((item, index) => ({
    event_id: item.event.id,
    rank: index + 1,
    source: item.lexical_rank && item.semantic_rank ? "hybrid" : item.semantic_rank ? "embedding" : "lexical",
    score: round4(item.score),
    ...(item.lexical_rank ? { lexical_rank: item.lexical_rank, lexical_score: round4(item.lexical_score || 0) } : {}),
    ...(item.semantic_rank ? { semantic_rank: item.semantic_rank, semantic_score: round4(item.semantic_score || 0) } : {}),
    ...(item.target_type ? { target_type: item.target_type } : {}),
    ...(item.fact_kind ? { fact_kind: item.fact_kind } : {}),
  }));

  return {
    ...lexical,
    events: merged,
    total: byId.size,
    diagnostics: {
      query_expansion: lexical.diagnostics?.query_expansion || {
        enabled: false,
        variant: "baseline",
        candidate_limit: 0,
        candidate_limit_mode: "baseline",
        search_terms: [],
      },
      hybrid: {
        enabled: true,
        embedding_model: model,
        embedding_threshold: threshold,
        lexical_candidates: lexical.events.length,
        embedding_candidates: embeddingRows.length,
        hits: hitDiagnostics,
      },
    },
  };
}

function resolveCandidateLimit(limit: number, expansion: boolean, mode: RecallCandidateLimitMode): number {
  if (mode === "baseline") return baselineCandidateLimit(limit);
  if (mode === "expanded") return expandedCandidateLimit(limit);
  return expansion ? expandedCandidateLimit(limit) : baselineCandidateLimit(limit);
}

function baselineCandidateLimit(limit: number): number {
  return Math.max(limit * 8, 80);
}

function expandedCandidateLimit(limit: number): number {
  return Math.min(Math.max(limit * 24, 240), 600);
}

function normalizeRecallQuery(query: RecallQuery, ownerContext: ReturnType<typeof resolveOwnerContext>): RecallQuery {
  const normalized: RecallQuery = { ...query };
  const ownerId = normalizeOwnerId(query.owner_id ?? query.user_id);
  if (ownerId) normalized.owner_id = ownerId;
  delete normalized.user_id;

  if (query.scope_owner_ids?.length) {
    const scope = query.scope_owner_ids.map(id => normalizeOwnerId(id)).filter(Boolean) as string[];
    if (ownerId && !scope.includes(ownerId)) scope.push(ownerId);
    const unique = [...new Set(scope)];
    // 只剩说话人自己时退化为单 owner 路径，避免无谓的 IN(...) 单元素查询。
    if (unique.length > 1) normalized.scope_owner_ids = unique;
    else delete normalized.scope_owner_ids;
  } else {
    delete normalized.scope_owner_ids;
  }

  if (query.entities?.length) {
    normalized.entities = normalizeEntities(query.entities, ownerContext);
  }
  if (query.event_types?.length) {
    normalized.event_types = [...new Set(query.event_types.map(t => normalizeEventType(t)))];
  }
  if (query.emotions?.length) {
    normalized.emotions = [...new Set(query.emotions.map(e => normalizeEmotion(e)?.word || e).filter(Boolean))];
  }
  if (query.tags?.length) {
    normalized.tags = [...new Set(query.tags.map(t => normalizeTag(t)).filter(Boolean) as string[])];
  }
  return normalized;
}

function buildHardFilters(query: RecallQuery, options: { dropValence?: boolean; dropEmotions?: boolean; dropEntities?: boolean; dropEventTypes?: boolean } = {}) {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  const owners = recallOwnerFilter(query);
  if (owners.length === 1) {
    conditions.push("me.user_id = ?");
    params.push(owners[0]!);
  } else if (owners.length > 1) {
    conditions.push(`me.user_id IN (${owners.map(() => "?").join(",")})`);
    params.push(...owners);
  }
  if (query.date_from) {
    conditions.push(`${EVENT_DATE_EXPR} >= ?`);
    params.push(query.date_from);
  }
  if (query.date_to) {
    conditions.push(`${EVENT_DATE_EXPR} <= ?`);
    params.push(query.date_to);
  }
  if (query.event_types?.length && !options.dropEventTypes) {
    conditions.push(`me.event_type IN (${query.event_types.map(() => "?").join(",")})`);
    params.push(...query.event_types);
  }
  if (query.entities?.length && !options.dropEntities) {
    const conds: string[] = [];
    for (const entity of query.entities) {
      conds.push("me.entities LIKE ?");
      params.push(`%\"${entity}\"%`);
    }
    conditions.push(`(${conds.join(" OR ")})`);
  }
  if (query.valence && !options.dropValence) {
    conditions.push("me.emotion LIKE ?");
    params.push(`%\"valence\":\"${query.valence}\"%`);
  }
  // emotions 与 valence 对称：明确指定情绪时按 emotion.primary 硬过滤，
  // 否则"压力"这类查询会被最近的高分（owner/recency）非压力事件淹没。
  if (query.emotions?.length && !options.dropEmotions) {
    const conds = query.emotions.map(() => "me.emotion LIKE ?");
    for (const emotion of query.emotions) params.push(`%\"primary\":\"${emotion}\"%`);
    conditions.push(`(${conds.join(" OR ")})`);
  }

  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

function runFtsCandidateQuery(hard: { where: string; params: SqlParam[] }, terms: string[], limit: number): CandidateRow[] {
  if (terms.length === 0) return [];
  const ftsQuery = buildFtsQuery(terms);
  if (!ftsQuery) return [];
  try {
    const where = appendWhere(hard, "memory_events_fts MATCH ?");
    return getDB().prepare(`
      SELECT me.*, bm25(memory_events_fts) as _fts_score
      FROM memory_events_fts
      JOIN memory_events me ON me.rowid = memory_events_fts.rowid
      ${where}
      ORDER BY bm25(memory_events_fts) ASC, ${EVENT_ORDER_EXPR} DESC
      LIMIT ?
    `).all(...hard.params, ftsQuery, limit) as CandidateRow[];
  } catch {
    return [];
  }
}

function runCandidateQueries(hard: { where: string; params: SqlParam[] }, terms: string[], limit: number): CandidateRow[] {
  const rowsById = new Map<string, CandidateRow>();
  for (const row of runFtsCandidateQuery(hard, terms, limit)) {
    const id = String(row.id || "");
    if (id) rowsById.set(id, row);
  }
  for (const row of runStoredTextCandidateQuery(hard, terms, limit)) {
    const id = String(row.id || "");
    if (!id || rowsById.has(id)) continue;
    rowsById.set(id, row);
  }
  return [...rowsById.values()];
}

function runStoredTextCandidateQuery(hard: { where: string; params: SqlParam[] }, terms: string[], limit: number): CandidateRow[] {
  const safeTerms = [...new Set(terms)]
    .map(term => term.trim())
    .filter(term => term.length >= 2)
    // Keep enough query-derived literal spans for unsegmented Chinese queries.
    // The terms are still escaped LIKE parameters and capped to avoid a broad
    // scan, but 12 was too small once expansion/entity hints preceded concrete
    // object/action spans such as “吃冰激凌” or “小腿摇呀摇”.
    .slice(0, 28);
  if (safeTerms.length === 0) return [];

  const termClauses = safeTerms.map(() => `
    CASE WHEN (
      me.canonical_search_text LIKE ? ESCAPE '\\'
      OR me.summary LIKE ? ESCAPE '\\'
      OR me.original_text LIKE ? ESCAPE '\\'
      OR me.tags LIKE ? ESCAPE '\\'
    ) THEN 1 ELSE 0 END
  `);
  const matchScoreExpr = termClauses.join(" + ");
  const patternParams: SqlParam[] = [];
  for (const term of safeTerms) {
    const pattern = `%${escapeLikePattern(term)}%`;
    patternParams.push(pattern, pattern, pattern, pattern);
  }

  return getDB().prepare(`
    SELECT me.*, 0 as _fts_score
    FROM memory_events me
    ${appendWhere(hard, `(${matchScoreExpr}) > 0`)}
    ORDER BY (${matchScoreExpr}) DESC, ${EVENT_ORDER_EXPR} DESC, me.created_at DESC
    LIMIT ?
  `).all(...hard.params, ...patternParams, ...patternParams, limit) as CandidateRow[];
}

function runStructuredCandidateQuery(
  hard: { where: string; params: SqlParam[] },
  limit: number,
  options: { dropValence?: boolean } = {},
): CandidateRow[] {
  // hard was already built by caller. The option is kept at call sites for readability/future extension.
  void options;
  return getDB().prepare(`
    SELECT me.*, 0 as _fts_score
    FROM memory_events me
    ${hard.where}
    ORDER BY ${EVENT_ORDER_EXPR} DESC, me.created_at DESC
    LIMIT ?
  `).all(...hard.params, limit) as CandidateRow[];
}

interface EmbeddingCandidateHit {
  event: MemoryEvent;
  semantic_score: number;
  target_type: string;
  fact_kind?: string | null;
}

async function runEmbeddingCandidateQuery(args: {
  text: string;
  ownerIds: string[];
  model: string;
  baseUrl: string;
  threshold: number;
  limit: number;
}): Promise<EmbeddingCandidateHit[]> {
  try {
    const vdb = getEmbeddingDB();
    const hasTable = vdb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memory_embeddings'`).get();
    if (!hasTable) return [];
    const owners = args.ownerIds.filter(Boolean);
    const ownerClause = owners.length ? `AND owner_id IN (${owners.map(() => "?").join(",")})` : "";
    const rows = vdb.prepare(`
      SELECT * FROM memory_embeddings
      WHERE embedding_model = ?
        ${ownerClause}
    `).all(args.model, ...owners) as StoredEmbeddingRow[];
    if (rows.length === 0) return [];

    const q = (await embedTexts([args.text], { model: args.model, baseUrl: args.baseUrl }))[0];
    if (!q) return [];

    const db = getDB();
    const bestByEvent = new Map<string, EmbeddingCandidateHit>();
    for (const row of rows) {
      const vector = readEmbeddingVector(row);
      if (vector.length === 0) continue;
      const semantic = cosine(q, vector);
      if (semantic < args.threshold) continue;
      const eventRow = db.prepare("SELECT * FROM memory_events WHERE id = ?").get(row.target_id) as Record<string, unknown> | null;
      if (!eventRow) continue;
      const event = rowToEvent(eventRow);
      const existing = bestByEvent.get(row.target_id);
      if (!existing || semantic > existing.semantic_score) {
        bestByEvent.set(row.target_id, {
          event,
          semantic_score: semantic,
          target_type: row.target_type,
          fact_kind: row.fact_kind,
        });
      }
    }
    return [...bestByEvent.values()]
      .sort((a, b) => b.semantic_score - a.semantic_score)
      .slice(0, args.limit);
  } catch {
    return [];
  }
}

function shouldRelaxSoftFilters(query: RecallQuery): boolean {
  return Boolean(query.valence || query.tags?.length || query.emotions?.length || query.text);
}

function scoreCandidate(
  row: CandidateRow,
  query: RecallQuery,
  index: number,
  terms: string[],
  expansion?: RecallQueryExpansion,
): number {
  const event = rowToEvent(row);
  let score = 0;

  if (query.owner_id && event.user_id === query.owner_id) score += SELF_OWNER_BOOST;
  else if (event.user_id && query.scope_owner_ids?.includes(event.user_id)) score += FAMILY_OWNER_BOOST;
  if (query.event_types?.includes(event.event_type)) score += 8;

  const eventEntities = new Set(event.entities || []);
  const entityMatches = (query.entities || []).filter(e => eventEntities.has(e)).length;
  score += entityMatches * 7;

  if (query.valence && event.emotion?.valence === query.valence) score += 4;

  const eventTags = new Set(event.tags || []);
  const tagMatches = (query.tags || []).filter(t => eventTags.has(t)).length;
  score += tagMatches * 3;

  const eventEmotion = event.emotion?.primary;
  if (eventEmotion && query.emotions?.includes(eventEmotion)) score += 3;

  const text = getSearchTextForScoring(row, event);
  if (expansion) {
    score += scoreExpandedTermMatches(text, terms);
  } else {
    const textMatches = terms.filter(term => text.includes(term)).length;
    score += textMatches * 1.5;
  }

  if (expansion) {
    const typeHintEvidence = expansion.debug.matches.filter(match => match.typeHints.includes(event.event_type)).length;
    if (typeHintEvidence > 0) score += Math.min(4, 1.4 + typeHintEvidence * 0.8);

    const hintedTags = new Set(expansion.tagHints);
    const hintedTagMatches = (event.tags || []).filter(tag => hintedTags.has(tag)).length;
    score += hintedTagMatches * 0.6;

    const hintedEntities = new Set(expansion.entityHints);
    const hintedEntityMatches = (event.entities || []).filter(entity => hintedEntities.has(entity)).length;
    score += hintedEntityMatches * 1.4;
  }

  const ftsScore = typeof row._fts_score === "number" ? row._fts_score : 0;
  if (ftsScore) score += ftsBm25Boost(ftsScore);

  score += recencyBoost(event.event_time || event.event_date || event.created_at);
  score -= index * 0.001;
  return score;
}

export function ftsBm25Boost(ftsScore: number): number {
  if (!Number.isFinite(ftsScore) || ftsScore >= 0) return 0;
  return Math.min(6, -ftsScore * 1_000_000);
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function buildSearchTerms(query: RecallQuery, expansion?: RecallQueryExpansion): string[] {
  const raw = new Set<string>();
  const add = (value?: string) => {
    const cleaned = value?.trim();
    // Keep 2-character Chinese terms for the stored text LIKE fallback. SQLite's
    // trigram tokenizer only matches 3+ character sequences, so FTS may miss
    // common terms like "疫苗" or "打针" and the fallback below is intentional.
    if (cleaned && cleaned.length >= 2 && !isRecallStopword(cleaned)) raw.add(cleaned);
  };

  for (const entity of query.entities || []) add(entity);
  for (const tag of query.tags || []) add(tag);
  for (const emotion of query.emotions || []) add(emotion);
  if (query.valence === "positive") { add("开心"); add("释然"); add("自豪"); }
  if (query.valence === "negative") { add("担心"); add("疲惫"); add("压力"); }

  const text = query.text || "";
  if (expansion) {
    for (const match of expansion.debug.matches) add(match.term);
    for (const alias of expansion.aliases) add(alias);
    for (const tag of expansion.tagHints) add(tag);
    for (const entity of expansion.entityHints) add(entity);
    for (const token of expansion.tokens) add(token);
  }
  for (const term of extractDomainTerms(text)) add(term);
  for (const token of text.split(/[\s，。！？、,.!?;；:：()[\]{}“”"']+/)) add(token);
  for (const term of extractLiteralSearchTerms(text)) add(term);

  return [...raw].slice(0, expansion ? 48 : 32);
}

function extractLiteralSearchTerms(text: string): string[] {
  const terms = new Set<string>();
  const cleaned = text.trim();
  if (!cleaned) return [];

  // Preserve exact user chunks and derive generic overlapping Chinese literal
  // spans from long unsegmented chunks. This is not a domain/corpus alias: it
  // only helps stored-text fallback and scoring notice concrete words already
  // present in the user's query (e.g. objects/actions/places) when the query has
  // no whitespace. Keep spans >=3 chars to avoid noisy single-character matches.
  for (const chunk of cleaned.split(/[\s，。！？、,.!?;；:：()[\]{}“”"']+/)) {
    const value = chunk.trim();
    if (value.length >= 4) terms.add(value);
    for (const span of extractChineseLiteralSpans(value)) terms.add(span);
  }

  return [...terms].slice(0, 18);
}

function extractChineseLiteralSpans(value: string): string[] {
  if (!/[\p{Script=Han}]/u.test(value) || value.length < 5) return [];
  const spans = new Set<string>();
  const chars = [...value];
  for (const size of [5, 4, 3]) {
    for (let index = 0; index <= chars.length - size; index++) {
      const span = chars.slice(index, index + size).join("");
      if (span.length < 3 || isRecallStopword(span)) continue;
      if (/^(爸爸|妈妈|宝宝们?|两个|小朋友)$/.test(span)) continue;
      spans.add(span);
    }
  }
  return [...spans].slice(0, 14);
}

function scoreExpandedTermMatches(text: string, terms: string[]): number {
  let score = 0;
  let literalSpanMatches = 0;
  for (const term of terms) {
    if (!text.includes(term)) continue;
    if (term.length >= 6) score += 3.2;
    else if (term.length >= 4) score += 2.6;
    else score += 0.9;
    if (term.length >= 3 && !isRecallStopword(term)) literalSpanMatches++;
  }
  // Reward multi-term literal coverage so older concrete matches outrank newer
  // rows that only share broad tags/emotions. This stays query-derived and does
  // not inject private aliases.
  if (literalSpanMatches >= 2) score += Math.min(8, (literalSpanMatches - 1) * 1.8);
  return Math.min(26, score);
}

function extractDomainTerms(text: string): string[] {
  const terms: string[] = [];
  const aliasPairs: Array<[RegExp, string[]]> = [
    [/睡觉|夜里醒|夜醒|入睡|午睡|哄睡/, ["夜醒", "自主入睡", "睡眠不足"]],
    [/吃东西|吃饭|辅食|进食|喂奶|吃奶/, ["辅食", "自主进食", "母乳", "奶粉"]],
    [/打针|疫苗|发烧|不舒服|咳嗽|生病/, ["疫苗", "发烧", "咳嗽", "感冒"]],
    [/表达|说话|语言|开口/, ["说话"]],
    [/大运动|走路|扶着|翻身|学站|站立/, ["走路", "站立", "爬行", "翻身"]],
    [/玩具|抢|闹别扭|冲突|吵/, ["双胞胎互动"]],
    [/周末|外出|公园|游乐场/, ["外出"]],
    [/项目|汇报|工作|代理|客户|订单|职场/, ["工作压力"]],
    [/压力|焦虑|崩溃/, ["育儿压力"]],
    [/松口气|顺利|放心/, ["释然"]],
  ];
  for (const [regex, values] of aliasPairs) {
    if (regex.test(text)) terms.push(...values);
  }
  return terms;
}

function buildFtsQuery(terms: string[]): string {
  const safe = [...new Set(terms)]
    .map(term => term.replace(/["*:^()\-]/g, " ").trim())
    // Do not raise this to 3: 2-character Chinese terms are still useful when
    // unicode61 is selected, and trigram misses are covered by the LIKE fallback.
    .filter(term => term.length >= 2)
    .slice(0, 8);
  return safe.map(term => `"${term}"`).join(" OR ");
}

function appendWhere(hard: { where: string }, condition: string): string {
  return hard.where ? `${hard.where} AND ${condition}` : `WHERE ${condition}`;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}

function getSearchTextForScoring(row: CandidateRow, event: MemoryEvent): string {
  const stored = typeof row.canonical_search_text === "string" ? row.canonical_search_text.trim() : "";
  if (!stored) return buildCanonicalSearchText(event);
  return [
    stored,
    event.summary,
    event.original_text,
    event.event_type,
    ...(event.entities || []),
    ...(event.tags || []),
    event.emotion?.primary,
    event.emotion?.secondary,
    event.emotion?.valence,
    ...(event.open_facts || []).flatMap(fact => [fact.kind, fact.value, fact.surface, fact.actor_id, fact.experiencer_id, fact.observer_id, fact.polarity]),
  ].filter(Boolean).join(" ");
}

function isRecallStopword(token: string): boolean {
  return new Set(["最近", "上周", "上个月", "什么", "有没有", "哪里", "记录", "事情", "这件事", "不要", "不是", "只看", "这边"]).has(token);
}

function recencyBoost(value?: string): number {
  if (!value) return 0;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 0;
  const days = Math.max(0, (Date.now() - time) / 86_400_000);
  return Math.max(0, 2 - days / 30);
}

/**
 * 获取统计信息
 */
export function getStats() {
  const db = getDB();
  const totalEvents = (db.prepare("SELECT COUNT(*) as c FROM memory_events").get() as {c: number}).c;
  const byType = db.prepare("SELECT event_type, COUNT(*) as c FROM memory_events GROUP BY event_type ORDER BY c DESC").all();
  const byEmotion = db.prepare(`SELECT json_extract(emotion, '$.primary') as emotion, COUNT(*) as c FROM memory_events GROUP BY emotion ORDER BY c DESC`).all();
  const topEntities = db.prepare(`SELECT json_each.value as entity, COUNT(*) as c FROM memory_events, json_each(memory_events.entities) GROUP BY json_each.value ORDER BY c DESC LIMIT 10`).all();
  const dateRange = db.prepare(`SELECT MIN(event_time) as earliest, MAX(event_time) as latest FROM memory_events WHERE event_time IS NOT NULL`).get();
  return { totalEvents, byType, byEmotion, topEntities, dateRange };
}

/**
 * 获取标签统计
 */
export function getTagStats(): Array<{ tag: string; count: number }> {
  const db = getDB();
  const rows = db.prepare(`
    SELECT json_each.value as tag, COUNT(*) as count 
    FROM memory_events, json_each(memory_events.tags) 
    GROUP BY json_each.value 
    ORDER BY count DESC
  `).all() as Array<{ tag: string; count: number }>;
  return rows;
}

/**
 * 获取情绪统计
 */
export function getEmotionStats(): Array<{ emotion: string; valence: string; count: number }> {
  const db = getDB();
  const rows = db.prepare(`
    SELECT 
      json_extract(emotion, '$.primary') as emotion,
      json_extract(emotion, '$.valence') as valence,
      COUNT(*) as count
    FROM memory_events 
    GROUP BY emotion 
    ORDER BY count DESC
  `).all() as Array<{ emotion: string; valence: string; count: number }>;
  return rows;
}

/**
 * 获取时间线统计（按天/周/月聚合）
 */
export function getTimelineStats(period: "day" | "week" | "month" = "day"): Array<{ period: string; count: number }> {
  const db = getDB();
  let dateFormat: string;
  switch (period) {
    case "day": dateFormat = "%Y-%m-%d"; break;
    case "week": dateFormat = "%Y-W%W"; break;
    case "month": dateFormat = "%Y-%m"; break;
  }
  const rows = db.prepare(`
    SELECT strftime('${dateFormat}', event_time) as period, COUNT(*) as count
    FROM memory_events 
    WHERE event_time IS NOT NULL
    GROUP BY period 
    ORDER BY period DESC
    LIMIT 30
  `).all() as Array<{ period: string; count: number }>;
  return rows;
}

/**
 * 获取实体关系图谱数据
 */
export interface EntityGraphNode {
  id: string;
  label: string;
  count: number;
  type: "entity" | "event_type" | "emotion" | "tag" | "owner";
}

export interface EntityGraphEdge {
  source: string;
  target: string;
  weight: number;
  type: "co_occurrence" | "has_type" | "has_emotion" | "has_tag" | "owner_event";
}

/**
 * 获取实体/事件/情绪/标签关系图谱数据。
 *
 * 注意：entities 表目前只保存少量规范实体；完整图谱必须直接从 memory_events
 * 的 JSON 字段聚合，否则 dashboard 看起来只有 6 个节点，误以为数据不全。
 */
export function getEntityGraph(): { nodes: EntityGraphNode[]; edges: EntityGraphEdge[] } {
  const db = getDB();

  const entityRows = db.prepare(`
    SELECT json_each.value as id, json_each.value as label, COUNT(*) as count
    FROM memory_events, json_each(memory_events.entities)
    WHERE json_each.value IS NOT NULL AND json_each.value != ''
    GROUP BY json_each.value
    ORDER BY count DESC
    LIMIT 60
  `).all() as Array<{ id: string; label: string; count: number }>;

  const eventTypeRows = db.prepare(`
    SELECT 'type:' || event_type as id, event_type as label, COUNT(*) as count
    FROM memory_events
    WHERE event_type IS NOT NULL AND event_type != ''
    GROUP BY event_type
    ORDER BY count DESC
    LIMIT 20
  `).all() as Array<{ id: string; label: string; count: number }>;

  const emotionRows = db.prepare(`
    SELECT 'emotion:' || json_extract(emotion, '$.primary') as id,
           json_extract(emotion, '$.primary') as label,
           COUNT(*) as count
    FROM memory_events
    WHERE json_extract(emotion, '$.primary') IS NOT NULL
      AND json_extract(emotion, '$.primary') != ''
    GROUP BY label
    ORDER BY count DESC
    LIMIT 30
  `).all() as Array<{ id: string; label: string; count: number }>;

  const tagRows = db.prepare(`
    SELECT 'tag:' || json_each.value as id, json_each.value as label, COUNT(*) as count
    FROM memory_events, json_each(memory_events.tags)
    WHERE json_each.value IS NOT NULL AND json_each.value != ''
    GROUP BY json_each.value
    ORDER BY count DESC
    LIMIT 40
  `).all() as Array<{ id: string; label: string; count: number }>;

  // owner 池以家庭 self 成员 id 为键，标签直接取 family_members.label（兼容历史 demo owner）。
  const ownerRows = db.prepare(`
    SELECT 'owner:' || me.user_id as id,
           COALESCE(
             fm.label,
             CASE me.user_id WHEN 'demo-dad-owner' THEN '爸爸' WHEN 'demo-mom-owner' THEN '妈妈' ELSE me.user_id END
           ) as label,
           COUNT(*) as count
    FROM memory_events me
    LEFT JOIN family_members fm ON fm.id = me.user_id
    WHERE me.user_id IS NOT NULL AND me.user_id != ''
    GROUP BY me.user_id
    ORDER BY count DESC
    LIMIT 10
  `).all() as Array<{ id: string; label: string; count: number }>;

  const nodes: EntityGraphNode[] = [
    ...entityRows.map(row => ({ ...row, type: "entity" as const })),
    ...eventTypeRows.map(row => ({ ...row, type: "event_type" as const })),
    ...emotionRows.map(row => ({ ...row, type: "emotion" as const })),
    ...tagRows.map(row => ({ ...row, type: "tag" as const })),
    ...ownerRows.map(row => ({ ...row, type: "owner" as const })),
  ];
  const nodeIds = new Set(nodes.map(node => node.id));
  const entityIds = new Set(entityRows.map(row => row.id));

  const coOccurrenceEdges = db.prepare(`
    WITH pairs AS (
      SELECT a.value as source, b.value as target
      FROM memory_events me, json_each(me.entities) a, json_each(me.entities) b
      WHERE a.value < b.value
    )
    SELECT source, target, COUNT(*) as weight
    FROM pairs
    GROUP BY source, target
    HAVING weight >= 2
    ORDER BY weight DESC
    LIMIT 120
  `).all() as Array<{ source: string; target: string; weight: number }>;

  const typeEdges = db.prepare(`
    SELECT json_each.value as source, 'type:' || me.event_type as target, COUNT(*) as weight
    FROM memory_events me, json_each(me.entities)
    GROUP BY source, target
    HAVING weight >= 2
    ORDER BY weight DESC
    LIMIT 160
  `).all() as Array<{ source: string; target: string; weight: number }>;

  const emotionEdges = db.prepare(`
    SELECT json_each.value as source, 'emotion:' || json_extract(me.emotion, '$.primary') as target, COUNT(*) as weight
    FROM memory_events me, json_each(me.entities)
    WHERE json_extract(me.emotion, '$.primary') IS NOT NULL
      AND json_extract(me.emotion, '$.primary') != ''
    GROUP BY source, target
    HAVING weight >= 2
    ORDER BY weight DESC
    LIMIT 160
  `).all() as Array<{ source: string; target: string; weight: number }>;

  const tagEdges = db.prepare(`
    SELECT ent.value as source, 'tag:' || tag.value as target, COUNT(*) as weight
    FROM memory_events me, json_each(me.entities) ent, json_each(me.tags) tag
    WHERE tag.value IS NOT NULL AND tag.value != ''
    GROUP BY source, target
    HAVING weight >= 2
    ORDER BY weight DESC
    LIMIT 160
  `).all() as Array<{ source: string; target: string; weight: number }>;

  const ownerEdges = db.prepare(`
    SELECT 'owner:' || me.user_id as source, json_each.value as target, COUNT(*) as weight
    FROM memory_events me, json_each(me.entities)
    WHERE me.user_id IS NOT NULL AND me.user_id != ''
    GROUP BY source, target
    HAVING weight >= 2
    ORDER BY weight DESC
    LIMIT 80
  `).all() as Array<{ source: string; target: string; weight: number }>;

  const keep = (edge: { source: string; target: string }) =>
    nodeIds.has(edge.source) && nodeIds.has(edge.target) &&
    (entityIds.has(edge.source) || entityIds.has(edge.target) || edge.source.startsWith("owner:"));

  const edges: EntityGraphEdge[] = [
    ...coOccurrenceEdges.filter(keep).map(e => ({ ...e, type: "co_occurrence" as const })),
    ...typeEdges.filter(keep).map(e => ({ ...e, type: "has_type" as const })),
    ...emotionEdges.filter(keep).map(e => ({ ...e, type: "has_emotion" as const })),
    ...tagEdges.filter(keep).map(e => ({ ...e, type: "has_tag" as const })),
    ...ownerEdges.filter(keep).map(e => ({ ...e, type: "owner_event" as const })),
  ];

  return { nodes, edges };
}

function parseJsonValue<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToEvent(row: Record<string, unknown>): MemoryEvent {
  return {
    id: row.id as string,
    raw_message_id: row.raw_message_id as string | undefined,
    summary: row.summary as string,
    original_text: row.original_text as string,
    original_span: row.original_span as string | undefined,
    event_type: row.event_type as MemoryEvent["event_type"],
    entities: JSON.parse(row.entities as string || "[]"),
    emotion: JSON.parse(row.emotion as string || "{}"),
    tags: JSON.parse(row.tags as string || "[]"),
    open_facts: normalizeOpenFacts(parseJsonValue(row.open_facts as string | undefined, []), {
      id: row.id as string,
      summary: row.summary as string,
      original_text: row.original_text as string,
      original_span: row.original_span as string | undefined,
      event_type: row.event_type as MemoryEvent["event_type"],
      entities: JSON.parse(row.entities as string || "[]"),
      emotion: JSON.parse(row.emotion as string || "{}"),
      tags: JSON.parse(row.tags as string || "[]"),
      location: row.location as string | undefined,
    }),
    location: row.location as string | undefined,
    event_time: row.event_time as string | undefined,
    event_date: row.event_date as string | undefined,
    confidence: row.confidence as number,
    source: row.source as MemoryEvent["source"],
    source_layer: row.source_layer as MemoryEvent["source_layer"],
    source_archive_id: row.source_archive_id as string | undefined,
    user_id: row.user_id as string | undefined,
    event_index: row.event_index as number | undefined,
    extractor_version: row.extractor_version as string | undefined,
    vocab_version: row.vocab_version as string | undefined,
    search_text_version: row.search_text_version as string | undefined,
    created_at: row.created_at as string,
  };
}
