import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { closeDB, getDB } from "../packages/db/src/database";
import type { MemoryEvent } from "../packages/domain/src/memory-event";
import { buildCanonicalSearchText } from "../packages/domain/src/search-text";
import {
  DEFAULT_QUERY_EXPANSION,
  recall,
  recallHybrid,
  type HybridHitDiagnostic,
  type RecallCandidateLimitMode,
  type RecallDiagnostics,
  type RecallQuery,
} from "../packages/retrieval/src/recall";
import {
  explainRelevance,
  findOwnerLeaks,
  type ExpectedRelevance,
  type RelevanceExplanation,
} from "./eval-recall-real";

export interface PrecisionQuerySet {
  version: number;
  owners?: Record<string, string>;
  notes?: string[];
  cases: PrecisionCase[];
}

export interface PrecisionCase {
  id: string;
  category?: string;
  query: string;
  owner_id?: string;
  expected: PrecisionExpected;
}

export interface PrecisionExpected extends ExpectedRelevance {
  no_answer?: boolean;
  generic?: boolean;
  strict_no_results?: boolean;
  types_any?: string[];
  forbidden_ids?: string[];
  forbidden_owner_ids?: string[];
  forbidden_terms_any?: string[];
  forbidden_terms_all?: string[];
  forbidden_entities_any?: string[];
  forbidden_tags_any?: string[];
  parent_only_terms?: string[];
}

export type PrecisionCaseKind = "positive" | "negative" | "generic";

export interface HitAssessment {
  relevant: boolean;
  false_positive: boolean;
  leak_false_positive: boolean;
  topical_false_positive: boolean;
  matched: string[];
  failed: string[];
  diagnostics: string[];
  id_matched: boolean;
}

interface FalsePositiveExplanation extends RelevanceExplanation {
  leak_false_positive: boolean;
  topical_false_positive: boolean;
}

export interface PrecisionHitReport {
  rank: number;
  id?: string;
  owner_id?: string;
  date?: string;
  type: string;
  assessment: HitAssessment;
  recall_source?: "lexical" | "embedding" | "hybrid";
  lexical_rank?: number;
  semantic_rank?: number;
  semantic_score?: number;
  target_type?: string;
  fact_kind?: string | null;
}

export interface GenericCaseDiagnostics {
  top1_type?: string;
  top1_owner_matches_expected: boolean | null;
  parent_only_query: boolean;
  top1_matches_parent_only_term: boolean;
  search_term_count: number;
}

export interface PrecisionCaseReport {
  id: string;
  category?: string;
  kind: PrecisionCaseKind;
  query: string;
  owner_id?: string;
  recall_query: RecallQuery;
  query_expansion: RecallDiagnostics["query_expansion"];
  elapsed_ms: number;
  total_candidates: number;
  relevant_count_at_1: number;
  relevant_count_at_3: number;
  relevant_count_at_5: number;
  false_positive_at_1: boolean;
  false_positive_at_3: boolean;
  false_positive_at_5: boolean;
  leak_false_positive_at_1: boolean;
  leak_false_positive_at_3: boolean;
  leak_false_positive_at_5: boolean;
  topical_false_positive_at_1: boolean;
  topical_false_positive_at_3: boolean;
  topical_false_positive_at_5: boolean;
  non_empty_at_1: boolean;
  non_empty_at_3: boolean;
  non_empty_at_5: boolean;
  owner_leak_count: number;
  owner_leaks: Array<{ rank: number; id?: string; owner_id?: string }>;
  top_hits: PrecisionHitReport[];
  generic_diagnostics?: GenericCaseDiagnostics;
}

export interface PrecisionMetrics {
  total_cases: number;
  positive_cases: number;
  negative_cases: number;
  generic_cases: number;
  precision_at_1: number;
  precision_at_3: number;
  precision_at_5: number;
  false_positive_at_1: number;
  false_positive_at_3: number;
  false_positive_at_5: number;
  false_positive_rate_at_1: number;
  false_positive_rate_at_3: number;
  false_positive_rate_at_5: number;
  leak_false_positive_at_1: number;
  leak_false_positive_at_3: number;
  leak_false_positive_at_5: number;
  leak_false_positive_rate_at_1: number;
  leak_false_positive_rate_at_3: number;
  leak_false_positive_rate_at_5: number;
  topical_false_positive_at_1: number;
  topical_false_positive_at_3: number;
  topical_false_positive_at_5: number;
  topical_false_positive_rate_at_1: number;
  topical_false_positive_rate_at_3: number;
  topical_false_positive_rate_at_5: number;
  no_answer_abstained_at_1: number;
  no_answer_abstained_at_3: number;
  no_answer_abstained_at_5: number;
  no_answer_abstention_rate_at_1: number;
  no_answer_abstention_rate_at_3: number;
  no_answer_abstention_rate_at_5: number;
  no_answer_non_empty_at_1: number;
  no_answer_non_empty_at_3: number;
  no_answer_non_empty_at_5: number;
  owner_scoped_cases: number;
  owner_leak_count: number;
  owner_leak_rate: number;
  avg_ms: number;
  p95_ms: number;
}

export interface GenericDiagnosticsSummary {
  cases: number;
  expansion_enabled: boolean;
  candidate_limit: number | null;
  candidate_limit_mode: RecallCandidateLimitMode;
  top1_type_distribution: Record<string, number>;
  top5_type_distribution: Record<string, number>;
  top1_owner_match_count: number;
  parent_only_cases: number;
  parent_only_top1_term_match_count: number;
}

export interface PrecisionEvalOutput {
  generated_at: string;
  db_path: string;
  readonly: boolean;
  mode: PrecisionRecallMode;
  query_expansion: {
    enabled: boolean;
    variant: "baseline" | "deterministic_v1";
    candidate_limit: number | null;
    candidate_limit_mode: RecallCandidateLimitMode;
  };
  query_path?: string;
  k: number;
  limit?: number;
  db_counts: DbCounts;
  label_caveat: string;
  metrics: PrecisionMetrics;
  generic_diagnostics: GenericDiagnosticsSummary;
  false_positive_cases: Array<{
    id: string;
    category?: string;
    query: string;
    at_1: boolean;
    at_3: boolean;
    at_5: boolean;
    leak_at_1: boolean;
    leak_at_3: boolean;
    leak_at_5: boolean;
    topical_at_1: boolean;
    topical_at_3: boolean;
    topical_at_5: boolean;
    top_false_positive_ids: string[];
    top_leak_false_positive_ids: string[];
    top_topical_false_positive_ids: string[];
  }>;
  cases: PrecisionCaseReport[];
}

export interface DbCounts {
  memory_events: number;
  memory_events_fts: number | null;
  owners: Array<{ owner_id: string; count: number }>;
  event_types: Array<{ event_type: string; count: number }>;
  date_range: { min_date: string | null; max_date: string | null };
}

export type PrecisionRecallMode = "lexical" | "hybrid";

export interface RunPrecisionEvalOptions {
  dbPath?: string;
  queryPath?: string;
  querySet?: PrecisionQuerySet;
  jsonPath?: string;
  markdownPath?: string;
  limit?: number;
  k?: number;
  readonly?: boolean;
  allowEmpty?: boolean;
  queryExpansion?: boolean;
  candidateLimitMode?: RecallCandidateLimitMode;
  mode?: PrecisionRecallMode;
}

type CliArgs = {
  queryFile: string;
  dbPath: string;
  json: string;
  markdown: string;
  limit?: number;
  k: number;
  allowEmpty: boolean;
  queryExpansion: boolean;
  candidateLimitMode: RecallCandidateLimitMode;
  mode: PrecisionRecallMode;
};

const DEFAULT_QUERY_PATH = "data/eval/precision-real-queries.json";
const DEFAULT_JSON_PATH = `${tmpdir()}/xfeel-v3-precision-real.json`;
const DEFAULT_MARKDOWN_PATH = `${tmpdir()}/xfeel-v3-precision-real.md`;
const LABEL_CAVEAT = "Heuristic labels are approximate retrieval precision / retrieval false-positive regressions, not human truth labels. True generation hallucination evaluation is out of scope. Reports intentionally omit private full text.";

export async function runPrecisionEval(options: RunPrecisionEvalOptions = {}): Promise<PrecisionEvalOutput> {
  const dbPath = resolveDbPath(options.dbPath || process.env.XFEEL_DB_PATH || "data/xfeel.db");
  const queryPath = options.queryPath || DEFAULT_QUERY_PATH;
  const querySet = options.querySet || loadPrecisionQuerySet(queryPath);
  validatePrecisionQuerySet(querySet, options.querySet ? "(embedded/test)" : queryPath);
  const readonly = options.readonly ?? dbPath !== ":memory:";
  const mode = options.mode || "lexical";
  const k = Math.max(5, Math.floor(options.k || 5));
  const selectedCases = typeof options.limit === "number"
    ? querySet.cases.slice(0, Math.max(0, Math.floor(options.limit)))
    : querySet.cases;

  closeDB();
  const db = getDB(dbPath, readonly ? { readonly: true, create: false } : {});
  try {
    const dbCounts = readDbCounts(db);
    if (dbCounts.memory_events === 0 && !options.allowEmpty) {
      throw new Error(`Refusing to run precision eval against empty DB (${dbPath}); pass --allow-empty to allow this explicitly.`);
    }

    const canonicalLookup = createCanonicalLookup(db);
    const queryExpansion = options.queryExpansion ?? DEFAULT_QUERY_EXPANSION;
    const candidateLimitMode = options.candidateLimitMode || "auto";
    const cases: PrecisionCaseReport[] = [];
    for (const item of selectedCases) {
      cases.push(await evaluateCase(item, k, canonicalLookup, queryExpansion, candidateLimitMode, mode));
    }
    const output: PrecisionEvalOutput = {
      generated_at: new Date().toISOString(),
      db_path: dbPath,
      readonly,
      mode,
      query_expansion: {
        enabled: queryExpansion,
        variant: queryExpansion ? "deterministic_v1" : "baseline",
        candidate_limit: cases[0]?.query_expansion.candidate_limit ?? null,
        candidate_limit_mode: candidateLimitMode,
      },
      query_path: options.querySet ? undefined : resolve(queryPath),
      k,
      limit: options.limit,
      db_counts: dbCounts,
      label_caveat: LABEL_CAVEAT,
      metrics: computeMetrics(cases),
      generic_diagnostics: summarizeGenericDiagnostics(cases, queryExpansion, candidateLimitMode),
      false_positive_cases: summarizeFalsePositiveCases(cases),
      cases,
    };

    if (options.jsonPath) writeText(options.jsonPath, JSON.stringify(output, null, 2));
    if (options.markdownPath) writeText(options.markdownPath, toMarkdown(output));
    return output;
  } finally {
    closeDB();
  }
}

export function loadPrecisionQuerySet(path: string): PrecisionQuerySet {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as PrecisionQuerySet;
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`Precision query set has no cases: ${path}`);
  }
  validatePrecisionQuerySet(parsed, path);
  return parsed;
}

export function validatePrecisionQuerySet(querySet: PrecisionQuerySet, source = "(embedded/test)") {
  if (!Array.isArray(querySet.cases) || querySet.cases.length === 0) {
    throw new Error(`Precision query set has no cases: ${source}`);
  }

  for (const item of querySet.cases) {
    if (item.category !== "negative-wrong-owner") continue;
    const expected = item.expected || {};
    if (!expected.forbidden_owner_ids?.length) {
      throw new Error(`negative-wrong-owner case ${item.id} in ${source} must configure expected.forbidden_owner_ids`);
    }
    if (expected.terms_any?.length) {
      throw new Error(`negative-wrong-owner case ${item.id} in ${source} must not configure expected.terms_any; use strict expected.terms_all for distinctive terms`);
    }
  }
}

async function evaluateCase(
  item: PrecisionCase,
  k: number,
  canonicalLookup: (id?: string) => string,
  queryExpansion: boolean,
  candidateLimitMode: RecallCandidateLimitMode,
  mode: PrecisionRecallMode,
): Promise<PrecisionCaseReport> {
  const expected = normalizeExpected(item.expected, item.owner_id);
  const ownerId = item.owner_id || expected.owner_id;
  const kind = classifyCase(expected);
  const recallQuery: RecallQuery = {
    text: item.query,
    owner_id: ownerId,
    limit: k,
  };

  const started = process.hrtime.bigint();
  const result = mode === "hybrid"
    ? await recallHybrid(recallQuery, { expansion: queryExpansion, candidateLimitMode })
    : recall(recallQuery, { expansion: queryExpansion, candidateLimitMode });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const hybridHitsById = new Map((result.diagnostics?.hybrid?.hits || []).map(hit => [hit.event_id, hit]));
  const topHits = result.events.slice(0, k).map((event, index) =>
    toHitReport(event, index + 1, expected, kind, canonicalLookup(event.id), hybridHitsById.get(event.id)));
  const ownerLeaks = findOwnerLeaks(topHits, expected.owner_id);

  return {
    id: item.id,
    category: item.category,
    kind,
    query: item.query,
    owner_id: ownerId,
    recall_query: recallQuery,
    query_expansion: result.diagnostics?.query_expansion || {
      enabled: queryExpansion,
      variant: queryExpansion ? "deterministic_v1" : "baseline",
      candidate_limit: 0,
      candidate_limit_mode: candidateLimitMode,
      search_terms: [],
    },
    elapsed_ms: round2(elapsedMs),
    total_candidates: result.total,
    relevant_count_at_1: countRelevant(topHits, 1),
    relevant_count_at_3: countRelevant(topHits, 3),
    relevant_count_at_5: countRelevant(topHits, 5),
    false_positive_at_1: hasFalsePositive(topHits, 1),
    false_positive_at_3: hasFalsePositive(topHits, 3),
    false_positive_at_5: hasFalsePositive(topHits, 5),
    leak_false_positive_at_1: hasFalsePositive(topHits, 1, "leak"),
    leak_false_positive_at_3: hasFalsePositive(topHits, 3, "leak"),
    leak_false_positive_at_5: hasFalsePositive(topHits, 5, "leak"),
    topical_false_positive_at_1: hasFalsePositive(topHits, 1, "topical"),
    topical_false_positive_at_3: hasFalsePositive(topHits, 3, "topical"),
    topical_false_positive_at_5: hasFalsePositive(topHits, 5, "topical"),
    non_empty_at_1: topHits.slice(0, 1).length > 0,
    non_empty_at_3: topHits.slice(0, 3).length > 0,
    non_empty_at_5: topHits.slice(0, 5).length > 0,
    owner_leak_count: ownerLeaks.length,
    owner_leaks: ownerLeaks,
    top_hits: topHits,
    ...(kind === "generic" ? { generic_diagnostics: buildGenericCaseDiagnostics(item.query, expected, topHits, result.diagnostics?.query_expansion) } : {}),
  };
}

function toHitReport(
  event: MemoryEvent,
  rank: number,
  expected: PrecisionExpected,
  kind: PrecisionCaseKind,
  storedCanonicalText: string,
  hybridHit?: HybridHitDiagnostic,
): PrecisionHitReport {
  return {
    rank,
    id: event.id,
    owner_id: event.user_id,
    date: event.event_date || event.event_time?.slice(0, 10) || event.created_at?.slice(0, 10),
    type: event.event_type,
    assessment: assessHit(event, expected, kind, storedCanonicalText),
    ...(hybridHit ? {
      recall_source: hybridHit.source,
      lexical_rank: hybridHit.lexical_rank,
      semantic_rank: hybridHit.semantic_rank,
      semantic_score: hybridHit.semantic_score,
      target_type: hybridHit.target_type,
      fact_kind: hybridHit.fact_kind,
    } : {}),
  };
}

function assessHit(
  event: MemoryEvent,
  expected: PrecisionExpected,
  kind: PrecisionCaseKind,
  storedCanonicalText: string,
): HitAssessment {
  if (kind === "positive") {
    const relevance = explainRelevance(event, toExpectedRelevance(expected), storedCanonicalText);
    return {
      relevant: relevance.relevant,
      false_positive: false,
      leak_false_positive: false,
      topical_false_positive: false,
      matched: relevance.matched,
      failed: relevance.failed,
      diagnostics: relevance.diagnostics,
      id_matched: relevance.id_matched,
    };
  }

  if (kind === "negative") {
    const falsePositive = explainFalsePositive(event, expected, storedCanonicalText);
    return {
      relevant: false,
      false_positive: falsePositive.relevant,
      leak_false_positive: falsePositive.leak_false_positive,
      topical_false_positive: falsePositive.topical_false_positive,
      matched: falsePositive.matched,
      failed: falsePositive.failed,
      diagnostics: falsePositive.diagnostics,
      id_matched: falsePositive.id_matched,
    };
  }

  return explainGenericHit(event, expected, storedCanonicalText);
}

function explainFalsePositive(
  event: MemoryEvent,
  expected: PrecisionExpected,
  storedCanonicalText: string,
): FalsePositiveExplanation {
  if (expected.strict_no_results) {
    return {
      relevant: true,
      leak_false_positive: false,
      topical_false_positive: true,
      matched: ["strict_no_results:any_result"],
      failed: [],
      diagnostics: ["no_answer case configured to treat any retrieved item as a false positive"],
      id_matched: false,
    };
  }

  const forbidden = explainForbiddenMatch(event, expected, storedCanonicalText);
  if (forbidden.relevant) {
    return {
      ...forbidden,
      leak_false_positive: true,
      topical_false_positive: false,
    };
  }

  const criteria = toExpectedRelevance(expected);
  if (hasRelevanceCriteria(criteria)) {
    const relevance = explainRelevance(event, criteria, storedCanonicalText);
    if (relevance.relevant) {
      return {
        relevant: true,
        leak_false_positive: false,
        topical_false_positive: true,
        matched: ["loose_no_answer_criteria", ...relevance.matched],
        failed: [],
        diagnostics: relevance.diagnostics,
        id_matched: relevance.id_matched,
      };
    }
    return {
      relevant: false,
      leak_false_positive: false,
      topical_false_positive: false,
      matched: forbidden.matched,
      failed: relevance.failed,
      diagnostics: [...forbidden.diagnostics, ...relevance.diagnostics],
      id_matched: relevance.id_matched,
    };
  }

  return {
    ...forbidden,
    leak_false_positive: false,
    topical_false_positive: false,
  };
}

function explainForbiddenMatch(
  event: MemoryEvent,
  expected: PrecisionExpected,
  storedCanonicalText: string,
): RelevanceExplanation {
  const matched: string[] = [];
  const failed: string[] = [];
  const diagnostics: string[] = [];
  let triggered = false;
  const haystack = buildHaystack(event, storedCanonicalText);

  if (expected.owner_id && event.user_id && event.user_id !== expected.owner_id) {
    matched.push(`owner_leak:${event.user_id}!=${expected.owner_id}`);
    triggered = true;
  }

  if (event.id && expected.forbidden_ids?.includes(event.id)) {
    matched.push(`forbidden_id:${event.id}`);
    triggered = true;
  }

  if (event.user_id && expected.forbidden_owner_ids?.includes(event.user_id)) {
    matched.push(`forbidden_owner:${event.user_id}`);
    triggered = true;
  }

  const forbiddenAny = expected.forbidden_terms_any?.filter(term => haystack.includes(normalizeForMatch(term))) || [];
  if (expected.forbidden_terms_any?.length) {
    if (forbiddenAny.length) {
      matched.push(`forbidden_terms_any:${forbiddenAny.join("|")}`);
      triggered = true;
    } else {
      diagnostics.push(`forbidden_terms_any:missed ${expected.forbidden_terms_any.join("|")}`);
    }
  }

  if (expected.forbidden_terms_all?.length) {
    const missing = expected.forbidden_terms_all.filter(term => !haystack.includes(normalizeForMatch(term)));
    if (missing.length === 0) {
      matched.push(`forbidden_terms_all:${expected.forbidden_terms_all.join("|")}`);
      triggered = true;
    } else {
      failed.push(`forbidden_terms_all:missing ${missing.join("|")}`);
    }
  }

  const entityHits = expected.forbidden_entities_any?.filter(value =>
    (event.entities || []).map(normalizeForMatch).includes(normalizeForMatch(value)) ||
    haystack.includes(normalizeForMatch(value))) || [];
  if (expected.forbidden_entities_any?.length) {
    if (entityHits.length) {
      matched.push(`forbidden_entities_any:${entityHits.join("|")}`);
      triggered = true;
    } else {
      diagnostics.push(`forbidden_entities_any:missed ${expected.forbidden_entities_any.join("|")}`);
    }
  }

  const tagHits = expected.forbidden_tags_any?.filter(value =>
    (event.tags || []).map(normalizeForMatch).includes(normalizeForMatch(value)) ||
    haystack.includes(normalizeForMatch(value))) || [];
  if (expected.forbidden_tags_any?.length) {
    if (tagHits.length) {
      matched.push(`forbidden_tags_any:${tagHits.join("|")}`);
      triggered = true;
    } else {
      diagnostics.push(`forbidden_tags_any:missed ${expected.forbidden_tags_any.join("|")}`);
    }
  }

  return {
    relevant: triggered,
    matched,
    failed,
    diagnostics,
    id_matched: Boolean(event.id && expected.forbidden_ids?.includes(event.id)),
  };
}

function explainGenericHit(
  event: MemoryEvent,
  expected: PrecisionExpected,
  storedCanonicalText: string,
): HitAssessment {
  const matched: string[] = [];
  const failed: string[] = [];
  const diagnostics = ["generic:diagnostic_only"];

  if (expected.owner_id) {
    if (event.user_id === expected.owner_id) matched.push(`owner:${expected.owner_id}`);
    else failed.push(`owner:${event.user_id || "(none)"}!=${expected.owner_id}`);
  }

  const types = expected.event_types || expected.types_any || [];
  if (types.length) {
    if (types.includes(event.event_type)) matched.push(`type:${event.event_type}`);
    else diagnostics.push(`type:${event.event_type} not in ${types.join("|")}`);
  }

  const parentTerms = expected.parent_only_terms || [];
  if (parentTerms.length) {
    const haystack = buildHaystack(event, storedCanonicalText);
    const hits = parentTerms.filter(term => haystack.includes(normalizeForMatch(term)));
    if (hits.length) diagnostics.push(`parent_only_terms:${hits.join("|")}`);
  }

  return {
    relevant: false,
    false_positive: false,
    leak_false_positive: false,
    topical_false_positive: false,
    matched,
    failed,
    diagnostics,
    id_matched: false,
  };
}

export function computeMetrics(cases: PrecisionCaseReport[]): PrecisionMetrics {
  const total = cases.length || 1;
  const positive = cases.filter(item => item.kind === "positive");
  const negative = cases.filter(item => item.kind === "negative");
  const generic = cases.filter(item => item.kind === "generic");
  const positiveDenominator = positive.length || 1;
  const negativeDenominator = negative.length || 1;
  const latencies = cases.map(item => item.elapsed_ms).sort((a, b) => a - b);
  const ownerScopedCases = cases.filter(item => item.owner_id || item.recall_query.owner_id).length;
  const ownerScopedHitSlots = cases
    .filter(item => item.owner_id || item.recall_query.owner_id)
    .reduce((sum, item) => sum + item.top_hits.length, 0);
  const ownerLeakCount = cases.reduce((sum, item) => sum + item.owner_leak_count, 0);
  const fpAt1 = negative.filter(item => item.false_positive_at_1).length;
  const fpAt3 = negative.filter(item => item.false_positive_at_3).length;
  const fpAt5 = negative.filter(item => item.false_positive_at_5).length;
  const leakFpAt1 = negative.filter(item => item.leak_false_positive_at_1).length;
  const leakFpAt3 = negative.filter(item => item.leak_false_positive_at_3).length;
  const leakFpAt5 = negative.filter(item => item.leak_false_positive_at_5).length;
  const topicalFpAt1 = negative.filter(item => item.topical_false_positive_at_1).length;
  const topicalFpAt3 = negative.filter(item => item.topical_false_positive_at_3).length;
  const topicalFpAt5 = negative.filter(item => item.topical_false_positive_at_5).length;

  return {
    total_cases: cases.length,
    positive_cases: positive.length,
    negative_cases: negative.length,
    generic_cases: generic.length,
    precision_at_1: round4(positive.reduce((sum, item) => sum + item.relevant_count_at_1 / 1, 0) / positiveDenominator),
    precision_at_3: round4(positive.reduce((sum, item) => sum + item.relevant_count_at_3 / 3, 0) / positiveDenominator),
    precision_at_5: round4(positive.reduce((sum, item) => sum + item.relevant_count_at_5 / 5, 0) / positiveDenominator),
    false_positive_at_1: fpAt1,
    false_positive_at_3: fpAt3,
    false_positive_at_5: fpAt5,
    false_positive_rate_at_1: round4(fpAt1 / negativeDenominator),
    false_positive_rate_at_3: round4(fpAt3 / negativeDenominator),
    false_positive_rate_at_5: round4(fpAt5 / negativeDenominator),
    leak_false_positive_at_1: leakFpAt1,
    leak_false_positive_at_3: leakFpAt3,
    leak_false_positive_at_5: leakFpAt5,
    leak_false_positive_rate_at_1: round4(leakFpAt1 / negativeDenominator),
    leak_false_positive_rate_at_3: round4(leakFpAt3 / negativeDenominator),
    leak_false_positive_rate_at_5: round4(leakFpAt5 / negativeDenominator),
    topical_false_positive_at_1: topicalFpAt1,
    topical_false_positive_at_3: topicalFpAt3,
    topical_false_positive_at_5: topicalFpAt5,
    topical_false_positive_rate_at_1: round4(topicalFpAt1 / negativeDenominator),
    topical_false_positive_rate_at_3: round4(topicalFpAt3 / negativeDenominator),
    topical_false_positive_rate_at_5: round4(topicalFpAt5 / negativeDenominator),
    no_answer_abstained_at_1: negative.length - fpAt1,
    no_answer_abstained_at_3: negative.length - fpAt3,
    no_answer_abstained_at_5: negative.length - fpAt5,
    no_answer_abstention_rate_at_1: round4((negative.length - fpAt1) / negativeDenominator),
    no_answer_abstention_rate_at_3: round4((negative.length - fpAt3) / negativeDenominator),
    no_answer_abstention_rate_at_5: round4((negative.length - fpAt5) / negativeDenominator),
    no_answer_non_empty_at_1: negative.filter(item => item.non_empty_at_1).length,
    no_answer_non_empty_at_3: negative.filter(item => item.non_empty_at_3).length,
    no_answer_non_empty_at_5: negative.filter(item => item.non_empty_at_5).length,
    owner_scoped_cases: ownerScopedCases,
    owner_leak_count: ownerLeakCount,
    owner_leak_rate: round4(ownerScopedHitSlots ? ownerLeakCount / ownerScopedHitSlots : 0),
    avg_ms: round2(cases.reduce((sum, item) => sum + item.elapsed_ms, 0) / total),
    p95_ms: round2(latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] || 0),
  };
}

function summarizeGenericDiagnostics(
  cases: PrecisionCaseReport[],
  queryExpansion: boolean,
  candidateLimitMode: RecallCandidateLimitMode,
): GenericDiagnosticsSummary {
  const generic = cases.filter(item => item.kind === "generic");
  const top1Types: Record<string, number> = {};
  const top5Types: Record<string, number> = {};
  let top1OwnerMatchCount = 0;
  let parentOnlyCases = 0;
  let parentOnlyTop1TermMatchCount = 0;

  for (const item of generic) {
    const top1 = item.top_hits[0];
    if (top1?.type) top1Types[top1.type] = (top1Types[top1.type] || 0) + 1;
    for (const hit of item.top_hits.slice(0, 5)) {
      top5Types[hit.type] = (top5Types[hit.type] || 0) + 1;
    }
    if (item.generic_diagnostics?.top1_owner_matches_expected) top1OwnerMatchCount += 1;
    if (item.generic_diagnostics?.parent_only_query) parentOnlyCases += 1;
    if (item.generic_diagnostics?.top1_matches_parent_only_term) parentOnlyTop1TermMatchCount += 1;
  }

  return {
    cases: generic.length,
    expansion_enabled: queryExpansion,
    candidate_limit: generic[0]?.query_expansion.candidate_limit ?? null,
    candidate_limit_mode: candidateLimitMode,
    top1_type_distribution: sortRecord(top1Types),
    top5_type_distribution: sortRecord(top5Types),
    top1_owner_match_count: top1OwnerMatchCount,
    parent_only_cases: parentOnlyCases,
    parent_only_top1_term_match_count: parentOnlyTop1TermMatchCount,
  };
}

function summarizeFalsePositiveCases(cases: PrecisionCaseReport[]) {
  return cases
    .filter(item => item.kind === "negative" && item.false_positive_at_5)
    .map(item => ({
      id: item.id,
      category: item.category,
      query: item.query,
      at_1: item.false_positive_at_1,
      at_3: item.false_positive_at_3,
      at_5: item.false_positive_at_5,
      leak_at_1: item.leak_false_positive_at_1,
      leak_at_3: item.leak_false_positive_at_3,
      leak_at_5: item.leak_false_positive_at_5,
      topical_at_1: item.topical_false_positive_at_1,
      topical_at_3: item.topical_false_positive_at_3,
      topical_at_5: item.topical_false_positive_at_5,
      top_false_positive_ids: item.top_hits
        .filter(hit => hit.assessment.false_positive)
        .map(hit => hit.id)
        .filter((id): id is string => Boolean(id)),
      top_leak_false_positive_ids: item.top_hits
        .filter(hit => hit.assessment.leak_false_positive)
        .map(hit => hit.id)
        .filter((id): id is string => Boolean(id)),
      top_topical_false_positive_ids: item.top_hits
        .filter(hit => hit.assessment.topical_false_positive)
        .map(hit => hit.id)
        .filter((id): id is string => Boolean(id)),
    }));
}

function buildGenericCaseDiagnostics(
  query: string,
  expected: PrecisionExpected,
  topHits: PrecisionHitReport[],
  expansion?: RecallDiagnostics["query_expansion"],
): GenericCaseDiagnostics {
  const top1 = topHits[0];
  const parentOnlyQuery = isParentOnlyQuery(query, expected);
  return {
    top1_type: top1?.type,
    top1_owner_matches_expected: expected.owner_id ? top1?.owner_id === expected.owner_id : null,
    parent_only_query: parentOnlyQuery,
    top1_matches_parent_only_term: Boolean(parentOnlyQuery && top1?.assessment.diagnostics.some(item => item.startsWith("parent_only_terms:"))),
    search_term_count: expansion?.search_terms.length || 0,
  };
}

function classifyCase(expected: PrecisionExpected): PrecisionCaseKind {
  if (expected.no_answer) return "negative";
  if (expected.generic) return "generic";
  return "positive";
}

function normalizeExpected(expected: PrecisionExpected, caseOwnerId?: string): PrecisionExpected {
  return {
    ...expected,
    owner_id: expected.owner_id || caseOwnerId,
    event_types: unique([...(expected.event_types || []), ...(expected.types_any || [])]),
  };
}

function toExpectedRelevance(expected: PrecisionExpected): ExpectedRelevance {
  return {
    ids: expected.ids,
    owner_id: expected.owner_id,
    event_types: unique([...(expected.event_types || []), ...(expected.types_any || [])]),
    entities_any: expected.entities_any,
    entities_all: expected.entities_all,
    tags_any: expected.tags_any,
    tags_all: expected.tags_all,
    terms_any: expected.terms_any,
    terms_all: expected.terms_all,
    weak_terms_any: expected.weak_terms_any,
    valence: expected.valence,
  };
}

function hasRelevanceCriteria(expected: ExpectedRelevance): boolean {
  return Boolean(
    expected.ids?.length ||
    expected.event_types?.length ||
    expected.entities_any?.length ||
    expected.entities_all?.length ||
    expected.tags_any?.length ||
    expected.tags_all?.length ||
    expected.terms_any?.length ||
    expected.terms_all?.length ||
    expected.valence
  );
}

function countRelevant(hits: PrecisionHitReport[], k: 1 | 3 | 5): number {
  return hits.slice(0, k).filter(hit => hit.assessment.relevant).length;
}

function hasFalsePositive(hits: PrecisionHitReport[], k: 1 | 3 | 5, kind: "overall" | "leak" | "topical" = "overall"): boolean {
  const field = kind === "leak"
    ? "leak_false_positive"
    : kind === "topical"
      ? "topical_false_positive"
      : "false_positive";
  return hits.slice(0, k).some(hit => hit.assessment[field]);
}

function isParentOnlyQuery(query: string, expected: PrecisionExpected): boolean {
  if (expected.parent_only_terms?.length) return true;
  const normalized = normalizeForMatch(query);
  return normalized === "妈妈" || normalized === "爸爸";
}

function buildHaystack(event: MemoryEvent, storedCanonicalText: string): string {
  const canonicalText = storedCanonicalText || buildCanonicalSearchText(event);
  return normalizeForMatch([
    event.summary,
    event.original_text,
    canonicalText,
    event.event_type,
    ...(event.entities || []),
    ...(event.tags || []),
    event.emotion?.primary,
    event.emotion?.secondary,
    event.emotion?.valence,
  ].filter(Boolean).join(" "));
}

function createCanonicalLookup(db: Database): (id?: string) => string {
  const stmt = db.prepare("SELECT canonical_search_text FROM memory_events WHERE id = ?");
  return (id?: string) => {
    if (!id) return "";
    const row = stmt.get(id) as { canonical_search_text?: string } | null;
    return row?.canonical_search_text || "";
  };
}

function readDbCounts(db: Database): DbCounts {
  return {
    memory_events: countTableRows(db, "memory_events") ?? 0,
    memory_events_fts: tableExists(db, "memory_events_fts") ? countTableRows(db, "memory_events_fts") : null,
    owners: db.prepare(`
      SELECT COALESCE(NULLIF(user_id, ''), '(none)') as owner_id, COUNT(*) as count
      FROM memory_events
      GROUP BY owner_id
      ORDER BY count DESC, owner_id
    `).all() as Array<{ owner_id: string; count: number }>,
    event_types: db.prepare(`
      SELECT event_type, COUNT(*) as count
      FROM memory_events
      GROUP BY event_type
      ORDER BY count DESC, event_type
    `).all() as Array<{ event_type: string; count: number }>,
    date_range: db.prepare(`
      SELECT
        MIN(COALESCE(NULLIF(event_date, ''), date(event_time), substr(event_time, 1, 10), date(created_at), substr(created_at, 1, 10))) as min_date,
        MAX(COALESCE(NULLIF(event_date, ''), date(event_time), substr(event_time, 1, 10), date(created_at), substr(created_at, 1, 10))) as max_date
      FROM memory_events
    `).get() as { min_date: string | null; max_date: string | null },
  };
}

function countTableRows(db: Database, table: string): number | null {
  if (!tableExists(db, table)) return null;
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
  return row.count;
}

function tableExists(db: Database, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(table);
  return Boolean(row);
}

function writeText(path: string, text: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, text);
}

function resolveDbPath(input: string): string {
  return input === ":memory:" ? input : resolve(input);
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function sortRecord(input: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(input).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

export function toMarkdown(output: PrecisionEvalOutput): string {
  const lines = [
    "# xfeel-v3 real retrieval precision / false-positive eval",
    "",
    `Generated: ${output.generated_at}`,
    `DB: ${output.db_path}`,
    `Read-only: ${output.readonly}`,
    `Mode: ${output.mode}`,
    `Query expansion: ${output.query_expansion.enabled ? output.query_expansion.variant : "disabled"}`,
    `Candidate limit: ${output.query_expansion.candidate_limit ?? "n/a"} (${output.query_expansion.candidate_limit_mode})`,
    `Queries: ${output.query_path || "(embedded/test)"}`,
    `Cases: ${output.metrics.total_cases}`,
    "",
    `Caveat: ${output.label_caveat}`,
    "Scope: these are retrieval false-positive metrics. Leak FP is a hard forbidden-row / owner-leak signal; topical FP is loose topical overlap. True generation hallucination evaluation is out of scope.",
    "",
    "## Metrics",
    "",
    "| P@1 | P@3 | P@5 | overall FP@1 | overall FP@3 | overall FP@5 | owner leaks | avg ms | p95 ms |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| ${pct(output.metrics.precision_at_1)} | ${pct(output.metrics.precision_at_3)} | ${pct(output.metrics.precision_at_5)} | ${output.metrics.false_positive_at_1} (${pct(output.metrics.false_positive_rate_at_1)}) | ${output.metrics.false_positive_at_3} (${pct(output.metrics.false_positive_rate_at_3)}) | ${output.metrics.false_positive_at_5} (${pct(output.metrics.false_positive_rate_at_5)}) | ${output.metrics.owner_leak_count} | ${output.metrics.avg_ms} | ${output.metrics.p95_ms} |`,
    "",
    "## Retrieval False-Positive Split",
    "",
    "| leak-FP@1 | leak-FP@3 | leak-FP@5 | topical-FP@1 | topical-FP@3 | topical-FP@5 |",
    "|---:|---:|---:|---:|---:|---:|",
    `| ${output.metrics.leak_false_positive_at_1} (${pct(output.metrics.leak_false_positive_rate_at_1)}) | ${output.metrics.leak_false_positive_at_3} (${pct(output.metrics.leak_false_positive_rate_at_3)}) | ${output.metrics.leak_false_positive_at_5} (${pct(output.metrics.leak_false_positive_rate_at_5)}) | ${output.metrics.topical_false_positive_at_1} (${pct(output.metrics.topical_false_positive_rate_at_1)}) | ${output.metrics.topical_false_positive_at_3} (${pct(output.metrics.topical_false_positive_rate_at_3)}) | ${output.metrics.topical_false_positive_at_5} (${pct(output.metrics.topical_false_positive_rate_at_5)}) |`,
    "",
    `positive_cases: ${output.metrics.positive_cases}; negative_cases: ${output.metrics.negative_cases}; generic_cases: ${output.metrics.generic_cases}`,
    `no_answer_abstained_at_5: ${output.metrics.no_answer_abstained_at_5}/${output.metrics.negative_cases}`,
    `no_answer_non_empty_at_5: ${output.metrics.no_answer_non_empty_at_5}/${output.metrics.negative_cases}`,
    "",
    "## Generic Diagnostics",
    "",
    `top1_type_distribution: ${formatRecord(output.generic_diagnostics.top1_type_distribution)}`,
    `top5_type_distribution: ${formatRecord(output.generic_diagnostics.top5_type_distribution)}`,
    `top1_owner_match_count: ${output.generic_diagnostics.top1_owner_match_count}/${output.generic_diagnostics.cases}`,
    `parent_only_top1_term_match_count: ${output.generic_diagnostics.parent_only_top1_term_match_count}/${output.generic_diagnostics.parent_only_cases}`,
    "",
    "## False Positives",
    "",
  ];

  if (output.false_positive_cases.length === 0) {
    lines.push("No no-answer cases had a top-5 false positive under the configured heuristic criteria.");
  } else {
    for (const item of output.false_positive_cases) {
      lines.push(`- ${item.id} (${item.category || "uncategorized"}): overall @1=${item.at_1} @3=${item.at_3} @5=${item.at_5}; leak @1=${item.leak_at_1} @3=${item.leak_at_3} @5=${item.leak_at_5}; topical @1=${item.topical_at_1} @3=${item.topical_at_3} @5=${item.topical_at_5}; ids=${item.top_false_positive_ids.join(", ") || "n/a"}; leak_ids=${item.top_leak_false_positive_ids.join(", ") || "n/a"}; topical_ids=${item.top_topical_false_positive_ids.join(", ") || "n/a"}`);
    }
  }

  lines.push("", "## Cases", "");
  for (const item of output.cases) {
    lines.push(`### ${item.id}`);
    lines.push(`query: ${item.query}`);
    lines.push(`kind: ${item.kind}; category: ${item.category || "uncategorized"}; elapsed_ms: ${item.elapsed_ms}; total_candidates: ${item.total_candidates}`);
    lines.push(`expansion: ${formatExpansion(item.query_expansion)}`);
    if (item.kind === "positive") {
      lines.push(`relevant_count: @1=${item.relevant_count_at_1} @3=${item.relevant_count_at_3} @5=${item.relevant_count_at_5}`);
    }
    if (item.kind === "negative") {
      lines.push(`retrieval_false_positive: overall @1=${item.false_positive_at_1} @3=${item.false_positive_at_3} @5=${item.false_positive_at_5}; leak @1=${item.leak_false_positive_at_1} @3=${item.leak_false_positive_at_3} @5=${item.leak_false_positive_at_5}; topical @1=${item.topical_false_positive_at_1} @3=${item.topical_false_positive_at_3} @5=${item.topical_false_positive_at_5}; non_empty@5=${item.non_empty_at_5}`);
    }
    if (item.generic_diagnostics) {
      lines.push(`generic: top1_type=${item.generic_diagnostics.top1_type || "none"}; owner_match=${item.generic_diagnostics.top1_owner_matches_expected}; parent_only=${item.generic_diagnostics.parent_only_query}; search_terms=${item.generic_diagnostics.search_term_count}`);
    }
    for (const hit of item.top_hits) {
      lines.push(`- ${hit.rank}. ${hit.id || "?"} owner=${hit.owner_id || "?"} date=${hit.date || "?"} type=${hit.type} relevant=${hit.assessment.relevant} retrieval_false_positive=${hit.assessment.false_positive} leak_fp=${hit.assessment.leak_false_positive} topical_fp=${hit.assessment.topical_false_positive}`);
      if (hit.assessment.matched.length) lines.push(`  - matched: ${hit.assessment.matched.join("; ")}`);
      if (hit.assessment.failed.length) lines.push(`  - failed: ${hit.assessment.failed.join("; ")}`);
      if (hit.assessment.diagnostics.length) lines.push(`  - diagnostics: ${hit.assessment.diagnostics.join("; ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatRecord(record: Record<string, number>): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return "none";
  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function formatExpansion(expansion: RecallDiagnostics["query_expansion"]): string {
  if (!expansion.enabled) return `disabled; candidate_limit=${expansion.candidate_limit}; mode=${expansion.candidate_limit_mode}`;
  const terms = expansion.search_terms.slice(0, 10).join("|");
  const hints = expansion.expansion?.typeHints.length
    ? `; type_hints=${expansion.expansion.typeHints.join("|")}`
    : "";
  return `${expansion.variant}; candidate_limit=${expansion.candidate_limit}; mode=${expansion.candidate_limit_mode}; terms=${terms || "none"}${hints}`;
}

export function parseArgs(argv = process.argv.slice(2), env = process.env): CliArgs {
  const out: CliArgs = {
    queryFile: DEFAULT_QUERY_PATH,
    dbPath: env.XFEEL_DB_PATH || "data/xfeel.db",
    json: DEFAULT_JSON_PATH,
    markdown: DEFAULT_MARKDOWN_PATH,
    k: 5,
    allowEmpty: false,
    queryExpansion: DEFAULT_QUERY_EXPANSION,
    candidateLimitMode: "auto",
    mode: "lexical",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--query-file" || arg === "--queries") out.queryFile = argv[++i]!;
    else if (arg === "--db") out.dbPath = argv[++i]!;
    else if (arg === "--json") out.json = argv[++i]!;
    else if (arg === "--markdown") out.markdown = argv[++i]!;
    else if (arg === "--limit") out.limit = parsePositiveInt(argv[++i]!, "--limit");
    else if (arg === "--k") out.k = parsePositiveInt(argv[++i]!, "--k");
    else if (arg === "--allow-empty") out.allowEmpty = true;
    else if (arg === "--expansion") out.queryExpansion = true;
    else if (arg === "--no-expansion") out.queryExpansion = false;
    else if (arg === "--candidate-limit") out.candidateLimitMode = parseCandidateLimitMode(argv[++i]!);
    else if (arg === "--mode") out.mode = parsePrecisionRecallMode(argv[++i]!);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  out.k = Math.max(5, out.k);
  return out;
}

function parseCandidateLimitMode(value: string): RecallCandidateLimitMode {
  if (value === "auto" || value === "baseline" || value === "expanded") return value;
  throw new Error("--candidate-limit must be one of: auto, baseline, expanded");
}

function parsePrecisionRecallMode(value: string): PrecisionRecallMode {
  if (value === "lexical" || value === "hybrid") return value;
  throw new Error("--mode must be one of: lexical, hybrid");
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function printHelp() {
  console.log([
    "Usage: bun run scripts/eval-precision-real.ts [options]",
    "",
    "Options:",
    "  --query-file <path>  Query set JSON path (default: data/eval/precision-real-queries.json)",
    "  --queries <path>     Alias for --query-file",
    "  --db <path>          SQLite DB path (default: XFEEL_DB_PATH or data/xfeel.db)",
    "  --json <path>        JSON output path (default: /tmp/xfeel-v3-precision-real.json)",
    "  --markdown <path>    Markdown output path (default: /tmp/xfeel-v3-precision-real.md)",
    "  --limit <n>          Evaluate only the first n cases",
    "  --k <n>              Top hits to fetch/report; minimum 5",
    "  --allow-empty        Allow running against a DB with zero memory_events",
    "  --expansion          Enable deterministic query expansion",
    "  --no-expansion       Disable deterministic query expansion for baseline comparison",
    "  --candidate-limit <auto|baseline|expanded>",
    "                       Select candidate pool size independently for ablations",
    "  --mode <lexical|hybrid>",
    "                       Select recall path for precision/no-answer eval",
  ].join("\n"));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const output = await runPrecisionEval({
    dbPath: args.dbPath,
    queryPath: args.queryFile,
    jsonPath: args.json,
    markdownPath: args.markdown,
    limit: args.limit,
    k: args.k,
    readonly: true,
    allowEmpty: args.allowEmpty,
    queryExpansion: args.queryExpansion,
    candidateLimitMode: args.candidateLimitMode,
    mode: args.mode,
  });

  console.log(`[eval-precision-real] DB: ${output.db_path} readonly=${output.readonly} mode=${output.mode}`);
  console.log(`[eval-precision-real] query_expansion: enabled=${output.query_expansion.enabled} variant=${output.query_expansion.variant} candidate_limit=${output.query_expansion.candidate_limit ?? "n/a"} candidate_limit_mode=${output.query_expansion.candidate_limit_mode}`);
  console.log(`[eval-precision-real] counts: memory_events=${output.db_counts.memory_events} fts=${output.db_counts.memory_events_fts ?? "n/a"} owners=${output.db_counts.owners.map(row => `${row.owner_id}:${row.count}`).join(", ")}`);
  console.log(`[eval-precision-real] metrics: P@1=${pct(output.metrics.precision_at_1)} P@3=${pct(output.metrics.precision_at_3)} P@5=${pct(output.metrics.precision_at_5)} retrieval-FP@5=${output.metrics.false_positive_at_5}/${output.metrics.negative_cases} leak-FP@5=${output.metrics.leak_false_positive_at_5}/${output.metrics.negative_cases} topical-FP@5=${output.metrics.topical_false_positive_at_5}/${output.metrics.negative_cases} owner_leak_count=${output.metrics.owner_leak_count} avg_ms=${output.metrics.avg_ms} p95_ms=${output.metrics.p95_ms}`);
  console.log(`[eval-precision-real] wrote: json=${args.json} markdown=${args.markdown}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    closeDB();
    process.exit(1);
  }
}
