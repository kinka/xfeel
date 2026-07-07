import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { closeDB, getDB } from "../packages/db/src/database";
import type { MemoryEvent } from "../packages/domain/src/memory-event";
import { buildCanonicalSearchText } from "../packages/domain/src/search-text";
import {
  DEFAULT_QUERY_EXPANSION,
  recall,
  type RecallCandidateLimitMode,
  type RecallDiagnostics,
  type RecallQuery,
} from "../packages/retrieval/src/recall";

export interface RealRecallQuerySet {
  version: number;
  owners?: Record<string, string>;
  cases: RealRecallCase[];
}

export interface RealRecallCase {
  id: string;
  category?: string;
  query: string;
  owner_id?: string;
  expected: ExpectedRelevance;
}

export interface ExpectedRelevance {
  ids?: string[];
  owner_id?: string;
  event_types?: string[];
  entities_any?: string[];
  entities_all?: string[];
  tags_any?: string[];
  tags_all?: string[];
  terms_any?: string[];
  terms_all?: string[];
  weak_terms_any?: string[];
  valence?: "positive" | "negative" | "neutral";
}

export interface RelevanceExplanation {
  relevant: boolean;
  matched: string[];
  failed: string[];
  diagnostics: string[];
  id_matched: boolean;
}

export interface HitReport {
  rank: number;
  id?: string;
  owner_id?: string;
  date?: string;
  type: string;
  summary_snippet: string;
  score?: number;
  relevance: RelevanceExplanation;
}

export interface CaseReport {
  id: string;
  category?: string;
  query: string;
  owner_id?: string;
  recall_query: RecallQuery;
  query_expansion: RecallDiagnostics["query_expansion"];
  elapsed_ms: number;
  total_candidates: number;
  relevant_rank: number | null;
  hit_at_5: boolean;
  hit_at_10: boolean;
  miss_type_at_5: MissType | null;
  miss_type_at_10: MissType | null;
  miss_reasons_at_5: string[];
  miss_reasons_at_10: string[];
  relevant_hit_ids: string[];
  owner_leak_count: number;
  owner_leaks: Array<{ rank: number; id?: string; owner_id?: string }>;
  top_hits: HitReport[];
  failure_reasons: string[];
}

export interface RecallMetrics {
  total_cases: number;
  hit_at_5: number;
  hit_at_10: number;
  recall_at_5: number;
  recall_at_10: number;
  mrr: number;
  owner_scoped_cases: number;
  owner_leak_count: number;
  owner_leak_rate: number;
  avg_ms: number;
  p95_ms: number;
}

export interface EvalOutput {
  generated_at: string;
  db_path: string;
  readonly: boolean;
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
  metrics: RecallMetrics;
  failure_summary: {
    missed_by_category: Record<string, number>;
    missed_by_type_at_5: Record<string, number>;
    missed_by_type_at_10: Record<string, number>;
    top_failure_reasons: Record<string, number>;
  };
  cases: CaseReport[];
}

export interface DbCounts {
  memory_events: number;
  memory_events_fts: number | null;
  owners: Array<{ owner_id: string; count: number }>;
  event_types: Array<{ event_type: string; count: number }>;
  date_range: { min_date: string | null; max_date: string | null };
}

export interface RunRecallEvalOptions {
  dbPath?: string;
  queryPath?: string;
  querySet?: RealRecallQuerySet;
  jsonPath?: string;
  markdownPath?: string;
  limit?: number;
  k?: number;
  readonly?: boolean;
  allowEmpty?: boolean;
  queryExpansion?: boolean;
  candidateLimitMode?: RecallCandidateLimitMode;
}

type CliArgs = {
  queries: string;
  dbPath: string;
  json: string;
  markdown: string;
  limit?: number;
  k: number;
  allowEmpty: boolean;
  queryExpansion: boolean;
  candidateLimitMode: RecallCandidateLimitMode;
};

export type MissType =
  | "no_candidates"
  | "no_relevant_in_top_k"
  | "relevant_beyond_5"
  | "relevant_beyond_k"
  | "failed_criteria";

interface MissClassification {
  type: MissType;
  reasons: string[];
}

const DEFAULT_QUERY_PATH = "data/eval/recall-real-queries.json";
const DEFAULT_JSON_PATH = `${tmpdir()}/xfeel-v3-recall-real.json`;
const DEFAULT_MARKDOWN_PATH = `${tmpdir()}/xfeel-v3-recall-real.md`;

export function runRecallEval(options: RunRecallEvalOptions = {}): EvalOutput {
  const dbPath = resolveDbPath(options.dbPath || process.env.XFEEL_DB_PATH || "data/xfeel.db");
  const queryPath = options.queryPath || DEFAULT_QUERY_PATH;
  const querySet = options.querySet || loadQuerySet(queryPath);
  const readonly = options.readonly ?? dbPath !== ":memory:";
  const k = Math.max(10, Math.floor(options.k || 10));
  const selectedCases = typeof options.limit === "number"
    ? querySet.cases.slice(0, Math.max(0, Math.floor(options.limit)))
    : querySet.cases;

  closeDB();
  const db = getDB(dbPath, readonly ? { readonly: true, create: false } : {});
  try {
    const dbCounts = readDbCounts(db);
    if (dbCounts.memory_events === 0 && !options.allowEmpty) {
      throw new Error(`Refusing to run recall eval against empty DB (${dbPath}); pass --allow-empty to allow this explicitly.`);
    }
    const canonicalLookup = createCanonicalLookup(db);
    const queryExpansion = options.queryExpansion ?? DEFAULT_QUERY_EXPANSION;
    const candidateLimitMode = options.candidateLimitMode || "auto";
    const cases = selectedCases.map(item => evaluateCase(item, k, canonicalLookup, queryExpansion, candidateLimitMode));
    const output: EvalOutput = {
      generated_at: new Date().toISOString(),
      db_path: dbPath,
      readonly,
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
      metrics: computeMetrics(cases),
      failure_summary: summarizeFailures(cases),
      cases,
    };

    if (options.jsonPath) writeText(options.jsonPath, JSON.stringify(output, null, 2));
    if (options.markdownPath) writeText(options.markdownPath, toMarkdown(output));
    return output;
  } finally {
    closeDB();
  }
}

export function loadQuerySet(path: string): RealRecallQuerySet {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as RealRecallQuerySet;
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`Recall query set has no cases: ${path}`);
  }
  return parsed;
}

function evaluateCase(
  item: RealRecallCase,
  k: number,
  canonicalLookup: (id?: string) => string,
  queryExpansion: boolean,
  candidateLimitMode: RecallCandidateLimitMode,
): CaseReport {
  const ownerId = item.owner_id || item.expected.owner_id;
  const recallQuery: RecallQuery = {
    text: item.query,
    owner_id: ownerId,
    limit: k,
  };

  const started = process.hrtime.bigint();
  const result = recall(recallQuery, { expansion: queryExpansion, candidateLimitMode });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const expected = { ...item.expected, owner_id: item.expected.owner_id || item.owner_id };
  const topHits = result.events.slice(0, k).map((event, index) =>
    toHitReport(event, index + 1, expected, canonicalLookup(event.id)));
  const relevantHits = topHits.filter(hit => hit.relevance.relevant);
  const relevantRank = relevantHits[0]?.rank ?? null;
  const missAt5 = classifyMiss(topHits, result.total, relevantRank, 5);
  const missAt10 = classifyMiss(topHits, result.total, relevantRank, 10);
  const ownerLeaks = findOwnerLeaks(topHits, expected.owner_id);

  return {
    id: item.id,
    category: item.category,
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
    relevant_rank: relevantRank,
    hit_at_5: missAt5 === null,
    hit_at_10: missAt10 === null,
    miss_type_at_5: missAt5?.type ?? null,
    miss_type_at_10: missAt10?.type ?? null,
    miss_reasons_at_5: missAt5?.reasons ?? [],
    miss_reasons_at_10: missAt10?.reasons ?? [],
    relevant_hit_ids: relevantHits.map(hit => hit.id).filter(Boolean) as string[],
    owner_leak_count: ownerLeaks.length,
    owner_leaks: ownerLeaks,
    top_hits: topHits,
    failure_reasons: missAt10?.reasons ?? [],
  };
}

function toHitReport(
  event: MemoryEvent,
  rank: number,
  expected: ExpectedRelevance,
  storedCanonicalText: string,
): HitReport {
  const maybeScore = (event as MemoryEvent & { score?: unknown }).score;
  return {
    rank,
    id: event.id,
    owner_id: event.user_id,
    date: event.event_date || event.event_time?.slice(0, 10) || event.created_at?.slice(0, 10),
    type: event.event_type,
    summary_snippet: snippet(event.summary),
    ...(typeof maybeScore === "number" ? { score: maybeScore } : {}),
    relevance: explainRelevance(event, expected, storedCanonicalText),
  };
}

export function explainRelevance(
  event: MemoryEvent,
  expected: ExpectedRelevance,
  storedCanonicalText = "",
): RelevanceExplanation {
  const matched: string[] = [];
  const failed: string[] = [];
  const diagnostics: string[] = [];
  const idMatched = Boolean(event.id && expected.ids?.includes(event.id));
  if (idMatched) {
    return { relevant: true, matched: [`id:${event.id}`], failed: [], diagnostics, id_matched: true };
  }

  const canonicalText = storedCanonicalText || buildCanonicalSearchText(event);
  const haystack = normalizeForMatch([
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

  if (expected.owner_id) {
    if (event.user_id === expected.owner_id) matched.push(`owner:${expected.owner_id}`);
    else failed.push(`owner:${event.user_id || "(none)"}!=${expected.owner_id}`);
  }

  if (expected.event_types?.length) {
    if (expected.event_types.includes(event.event_type)) matched.push(`type:${event.event_type}`);
    else failed.push(`type:${event.event_type} not in ${expected.event_types.join("|")}`);
  }

  if (expected.valence) {
    if (event.emotion?.valence === expected.valence) matched.push(`valence:${expected.valence}`);
    else failed.push(`valence:${event.emotion?.valence || "(none)"}!=${expected.valence}`);
  }

  checkAll("entities_all", expected.entities_all, valueMatchesStructuredOrText(event.entities, haystack), matched, failed);
  checkAny("entities_any", expected.entities_any, valueMatchesStructuredOrText(event.entities, haystack), matched, failed);
  checkAll("tags_all", expected.tags_all, valueMatchesStructuredOrText(event.tags, haystack), matched, failed);
  checkAny("tags_any", expected.tags_any, valueMatchesStructuredOrText(event.tags, haystack), matched, failed);
  checkAll("terms_all", expected.terms_all, valueMatchesText(haystack), matched, failed);
  checkAny("terms_any", expected.terms_any, valueMatchesText(haystack), matched, failed);
  checkDiagnosticAny("weak_terms_any", expected.weak_terms_any, valueMatchesText(haystack), matched, diagnostics);

  if (!expected.terms_all?.length && !expected.terms_any?.length) {
    failed.push("terms:not_configured");
  }

  return { relevant: failed.length === 0, matched, failed, diagnostics, id_matched: false };
}

function checkAll(
  name: string,
  values: string[] | undefined,
  predicate: (value: string) => boolean,
  matched: string[],
  failed: string[],
) {
  if (!values?.length) return;
  const missing = values.filter(value => !predicate(value));
  if (missing.length === 0) matched.push(`${name}:${values.join("|")}`);
  else failed.push(`${name}:missing ${missing.join("|")}`);
}

function checkAny(
  name: string,
  values: string[] | undefined,
  predicate: (value: string) => boolean,
  matched: string[],
  failed: string[],
) {
  if (!values?.length) return;
  const hits = values.filter(value => predicate(value));
  if (hits.length) matched.push(`${name}:${hits.join("|")}`);
  else failed.push(`${name}:none of ${values.join("|")}`);
}

function checkDiagnosticAny(
  name: string,
  values: string[] | undefined,
  predicate: (value: string) => boolean,
  matched: string[],
  diagnostics: string[],
) {
  if (!values?.length) return;
  const hits = values.filter(value => predicate(value));
  if (hits.length) matched.push(`${name}:${hits.join("|")}`);
  else diagnostics.push(`${name}:missed ${values.join("|")}`);
}

function valueMatchesStructuredOrText(values: string[] | undefined, haystack: string): (value: string) => boolean {
  const structuredValues = new Set((values || []).map(normalizeForMatch));
  return value => structuredValues.has(normalizeForMatch(value)) || haystack.includes(normalizeForMatch(value));
}

function valueMatchesText(haystack: string): (value: string) => boolean {
  return value => haystack.includes(normalizeForMatch(value));
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

export function findOwnerLeaks(
  hits: Array<Pick<HitReport, "rank" | "id" | "owner_id">>,
  expectedOwnerId?: string,
): Array<{ rank: number; id?: string; owner_id?: string }> {
  if (!expectedOwnerId) return [];
  return hits
    .filter(hit => hit.owner_id && hit.owner_id !== expectedOwnerId)
    .map(hit => ({ rank: hit.rank, id: hit.id, owner_id: hit.owner_id }));
}

export function computeMetrics(cases: CaseReport[]): RecallMetrics {
  const total = cases.length || 1;
  const latencies = cases.map(item => item.elapsed_ms).sort((a, b) => a - b);
  const ownerScopedCases = cases.filter(item => item.owner_id || item.recall_query.owner_id).length;
  const ownerScopedHitSlots = cases
    .filter(item => item.owner_id || item.recall_query.owner_id)
    .reduce((sum, item) => sum + item.top_hits.length, 0);
  const ownerLeakCount = cases.reduce((sum, item) => sum + item.owner_leak_count, 0);
  const hitAt5 = round4(cases.filter(item => item.relevant_rank !== null && item.relevant_rank <= 5).length / total);
  const hitAt10 = round4(cases.filter(item => item.relevant_rank !== null && item.relevant_rank <= 10).length / total);

  return {
    total_cases: cases.length,
    hit_at_5: hitAt5,
    hit_at_10: hitAt10,
    recall_at_5: hitAt5,
    recall_at_10: hitAt10,
    mrr: round4(cases.reduce((sum, item) => {
      if (item.relevant_rank === null || item.relevant_rank > 10) return sum;
      return sum + (1 / item.relevant_rank);
    }, 0) / total),
    owner_scoped_cases: ownerScopedCases,
    owner_leak_count: ownerLeakCount,
    owner_leak_rate: round4(ownerScopedHitSlots ? ownerLeakCount / ownerScopedHitSlots : 0),
    avg_ms: round2(cases.reduce((sum, item) => sum + item.elapsed_ms, 0) / total),
    p95_ms: round2(latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] || 0),
  };
}

function summarizeFailures(cases: CaseReport[]) {
  const missedByCategory: Record<string, number> = {};
  const missedByTypeAt5: Record<string, number> = {};
  const missedByTypeAt10: Record<string, number> = {};
  const topFailureReasons: Record<string, number> = {};
  for (const item of cases) {
    if (item.miss_type_at_5) {
      missedByTypeAt5[item.miss_type_at_5] = (missedByTypeAt5[item.miss_type_at_5] || 0) + 1;
    }
    if (item.miss_type_at_10) {
      missedByTypeAt10[item.miss_type_at_10] = (missedByTypeAt10[item.miss_type_at_10] || 0) + 1;
      const category = item.category || "uncategorized";
      missedByCategory[category] = (missedByCategory[category] || 0) + 1;
      for (const reason of item.failure_reasons) {
        topFailureReasons[reason] = (topFailureReasons[reason] || 0) + 1;
      }
    }
  }
  return {
    missed_by_category: sortRecord(missedByCategory),
    missed_by_type_at_5: sortRecord(missedByTypeAt5),
    missed_by_type_at_10: sortRecord(missedByTypeAt10),
    top_failure_reasons: sortRecord(topFailureReasons),
  };
}

function classifyMiss(
  topHits: HitReport[],
  totalCandidates: number,
  relevantRank: number | null,
  threshold: 5 | 10,
): MissClassification | null {
  if (relevantRank !== null && relevantRank <= threshold) return null;
  if (totalCandidates === 0 || topHits.length === 0) {
    return { type: "no_candidates", reasons: ["no_candidates"] };
  }
  if (relevantRank !== null && relevantRank > threshold) {
    const type = threshold === 5 ? "relevant_beyond_5" : "relevant_beyond_k";
    return { type, reasons: [`${type}:rank_${relevantRank}`] };
  }
  const failedCriteria = classifyFailedCriteria(topHits);
  if (failedCriteria.length) {
    return { type: "failed_criteria", reasons: ["no_relevant_in_top_k", ...failedCriteria] };
  }
  return { type: "no_relevant_in_top_k", reasons: ["no_relevant_in_top_k"] };
}

function classifyFailedCriteria(topHits: HitReport[]): string[] {
  const counts: Record<string, number> = {};
  for (const hit of topHits.slice(0, 3)) {
    for (const failed of hit.relevance.failed) {
      const key = failed.split(":")[0] || failed;
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return Object.entries(sortRecord(counts)).slice(0, 4).map(([key]) => `failed_criteria:${key}`);
}

function sortRecord(input: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(input).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
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

function snippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 96);
}

function writeText(path: string, text: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, text);
}

function resolveDbPath(input: string): string {
  return input === ":memory:" ? input : resolve(input);
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

export function toMarkdown(output: EvalOutput): string {
  const lines = [
    "# xfeel-v3 real recall ranking eval",
    "",
    `Generated: ${output.generated_at}`,
    `DB: ${output.db_path}`,
    `Read-only: ${output.readonly}`,
    `Query expansion: ${output.query_expansion.enabled ? output.query_expansion.variant : "disabled"}`,
    `Candidate limit: ${output.query_expansion.candidate_limit ?? "n/a"} (${output.query_expansion.candidate_limit_mode})`,
    `Queries: ${output.query_path || "(embedded/test)"}`,
    `Cases: ${output.metrics.total_cases}`,
    "",
    "## Metrics",
    "",
    "Hit@k is binary Success@k. JSON retains recall_at_5/recall_at_10 aliases for compatibility.",
    "",
    "| Hit@5 | Hit@10 | MRR | owner leaks | leak rate | avg ms | p95 ms |",
    "|---:|---:|---:|---:|---:|---:|---:|",
    `| ${pct(output.metrics.hit_at_5)} | ${pct(output.metrics.hit_at_10)} | ${output.metrics.mrr.toFixed(4)} | ${output.metrics.owner_leak_count} | ${pct(output.metrics.owner_leak_rate)} | ${output.metrics.avg_ms} | ${output.metrics.p95_ms} |`,
    "",
    "## DB Counts",
    "",
    `memory_events: ${output.db_counts.memory_events}`,
    `memory_events_fts: ${output.db_counts.memory_events_fts ?? "n/a"}`,
    `date_range: ${output.db_counts.date_range.min_date || "n/a"} to ${output.db_counts.date_range.max_date || "n/a"}`,
    "",
    "| owner | count |",
    "|---|---:|",
    ...output.db_counts.owners.map(row => `| ${row.owner_id} | ${row.count} |`),
    "",
    "## Failure Summary",
    "",
    "missed_by_type_at_5: " + formatRecord(output.failure_summary.missed_by_type_at_5),
    "missed_by_type_at_10: " + formatRecord(output.failure_summary.missed_by_type_at_10),
    "top_failure_reasons: " + formatRecord(output.failure_summary.top_failure_reasons),
    "",
    "## Misses",
    "",
  ];

  const missed = output.cases.filter(item => item.relevant_rank === null);
  if (missed.length === 0) {
    lines.push("No missed cases in top 10.");
  } else {
    for (const item of missed) {
      lines.push(`- ${item.id} (${item.category || "uncategorized"}): ${item.query}`);
      lines.push(`  - type@5: ${item.miss_type_at_5 || "hit"}; type@10: ${item.miss_type_at_10 || "hit"}`);
      lines.push(`  - reasons@10: ${item.failure_reasons.join(", ") || "unknown"}`);
      lines.push(`  - expansion: ${formatExpansion(item.query_expansion)}`);
      lines.push(`  - top hits: ${item.top_hits.slice(0, 3).map(hit => `${hit.rank}.${hit.id || "?"}/${hit.owner_id || "?"}/${hit.type}/${hit.date || "?"}`).join("; ") || "none"}`);
    }
  }

  lines.push("", "## Cases", "");
  for (const item of output.cases) {
    lines.push(`### ${item.id}`);
    lines.push(`query: ${item.query}`);
    lines.push(`rank: ${item.relevant_rank ?? "miss"}; Hit@5: ${item.hit_at_5}; Hit@10: ${item.hit_at_10}; owner_leaks: ${item.owner_leak_count}; elapsed_ms: ${item.elapsed_ms}`);
    lines.push(`expansion: ${formatExpansion(item.query_expansion)}`);
    for (const hit of item.top_hits) {
      lines.push(`- ${hit.rank}. ${hit.id || "?"} owner=${hit.owner_id || "?"} date=${hit.date || "?"} type=${hit.type} relevant=${hit.relevance.relevant}`);
      lines.push(`  - ${hit.summary_snippet}`);
      if (hit.relevance.failed.length) lines.push(`  - failed: ${hit.relevance.failed.join("; ")}`);
      if (hit.relevance.diagnostics.length) lines.push(`  - diagnostics: ${hit.relevance.diagnostics.join("; ")}`);
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
    queries: DEFAULT_QUERY_PATH,
    dbPath: env.XFEEL_DB_PATH || "data/xfeel.db",
    json: DEFAULT_JSON_PATH,
    markdown: DEFAULT_MARKDOWN_PATH,
    k: 10,
    allowEmpty: false,
    queryExpansion: DEFAULT_QUERY_EXPANSION,
    candidateLimitMode: "auto",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--queries") out.queries = argv[++i]!;
    else if (arg === "--db") out.dbPath = argv[++i]!;
    else if (arg === "--json") out.json = argv[++i]!;
    else if (arg === "--markdown") out.markdown = argv[++i]!;
    else if (arg === "--limit") out.limit = parsePositiveInt(argv[++i]!, "--limit");
    else if (arg === "--k") out.k = parsePositiveInt(argv[++i]!, "--k");
    else if (arg === "--allow-empty") out.allowEmpty = true;
    else if (arg === "--expansion") out.queryExpansion = true;
    else if (arg === "--no-expansion") out.queryExpansion = false;
    else if (arg === "--candidate-limit") out.candidateLimitMode = parseCandidateLimitMode(argv[++i]!);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  out.k = Math.max(10, out.k);
  return out;
}

function parseCandidateLimitMode(value: string): RecallCandidateLimitMode {
  if (value === "auto" || value === "baseline" || value === "expanded") return value;
  throw new Error("--candidate-limit must be one of: auto, baseline, expanded");
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function printHelp() {
  console.log([
    "Usage: bun run scripts/eval-recall-real.ts [options]",
    "",
    "Options:",
    "  --queries <path>    Query set JSON path (default: data/eval/recall-real-queries.json)",
    "  --db <path>         SQLite DB path (default: XFEEL_DB_PATH or data/xfeel.db)",
    "  --json <path>       JSON output path (default: /tmp/xfeel-v3-recall-real.json)",
    "  --markdown <path>   Markdown output path (default: /tmp/xfeel-v3-recall-real.md)",
    "  --limit <n>         Evaluate only the first n cases",
    "  --k <n>             Top hits to fetch/report; minimum 10 so recall@10 is always valid",
    "  --allow-empty       Allow running against a DB with zero memory_events",
    "  --expansion         Enable deterministic query expansion",
    "  --no-expansion      Disable deterministic query expansion for baseline comparison",
    "  --candidate-limit <auto|baseline|expanded>",
    "                      Select candidate pool size independently for ablations",
  ].join("\n"));
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const output = runRecallEval({
    dbPath: args.dbPath,
    queryPath: args.queries,
    jsonPath: args.json,
    markdownPath: args.markdown,
    limit: args.limit,
    k: args.k,
    readonly: true,
    allowEmpty: args.allowEmpty,
    queryExpansion: args.queryExpansion,
    candidateLimitMode: args.candidateLimitMode,
  });

  console.log(`[eval-recall-real] DB: ${output.db_path} readonly=${output.readonly}`);
  console.log(`[eval-recall-real] query_expansion: enabled=${output.query_expansion.enabled} variant=${output.query_expansion.variant} candidate_limit=${output.query_expansion.candidate_limit ?? "n/a"} candidate_limit_mode=${output.query_expansion.candidate_limit_mode}`);
  console.log(`[eval-recall-real] counts: memory_events=${output.db_counts.memory_events} fts=${output.db_counts.memory_events_fts ?? "n/a"} owners=${output.db_counts.owners.map(row => `${row.owner_id}:${row.count}`).join(", ")}`);
  console.log(`[eval-recall-real] metrics: Hit@5=${pct(output.metrics.hit_at_5)} Hit@10=${pct(output.metrics.hit_at_10)} mrr=${output.metrics.mrr.toFixed(4)} owner_leak_count=${output.metrics.owner_leak_count} avg_ms=${output.metrics.avg_ms} p95_ms=${output.metrics.p95_ms}`);
  console.log(`[eval-recall-real] wrote: json=${args.json} markdown=${args.markdown}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    closeDB();
    process.exit(1);
  }
}
