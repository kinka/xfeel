#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { closeDB, getDB } from "../packages/db/src/database";
import type { MemoryEvent } from "../packages/domain/src/memory-event";
import { recall } from "../packages/retrieval/src/recall";
import {
  computeMetrics,
  explainRelevance,
  findOwnerLeaks,
  loadQuerySet,
  type CaseReport,
  type EvalOutput,
  type HitReport,
  type RealRecallCase,
  type RealRecallQuerySet,
  type RecallMetrics,
} from "./eval-recall-real";
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  cosine,
  embedTexts,
  eventById,
  readEmbeddingVector,
  type StoredEmbeddingRow,
} from "./embedding-common";

interface Args {
  db: string;
  vecDb: string;
  queries: string;
  json: string;
  markdown: string;
  model: string;
  baseUrl: string;
  mode: "embedding" | "hybrid";
  limit?: number;
  k: number;
  candidateLimit: number;
  threshold: number;
}

interface EmbeddingHit {
  event: MemoryEvent;
  score: number;
  semantic_score: number;
  best_embedding_id: string;
  best_target_type: string;
  best_fact_kind?: string | null;
  best_embedding_text: string;
}

interface EmbeddingCaseReport extends CaseReport {
  mode: "embedding" | "hybrid";
  threshold: number;
}

interface EmbeddingEvalOutput extends Omit<EvalOutput, "query_expansion" | "cases" | "metrics"> {
  embedding: {
    mode: "embedding" | "hybrid";
    model: string;
    vec_db_path: string;
    candidate_limit: number;
    threshold: number;
  };
  metrics: RecallMetrics;
  cases: EmbeddingCaseReport[];
}

const DEFAULT_QUERIES = "data/eval/recall-real-queries.json";
const DEFAULT_JSON = `${tmpdir()}/xfeel-v3-embedding-recall.json`;
const DEFAULT_MARKDOWN = `${tmpdir()}/xfeel-v3-embedding-recall.md`;

export async function runEmbeddingRecallEval(args: Partial<Args> = {}): Promise<EmbeddingEvalOutput> {
  const full: Args = {
    db: args.db || process.env.XFEEL_DB_PATH || "data/xfeel.db",
    vecDb: args.vecDb || process.env.XFEEL_VEC_DB_PATH || "",
    queries: args.queries || DEFAULT_QUERIES,
    json: args.json || DEFAULT_JSON,
    markdown: args.markdown || DEFAULT_MARKDOWN,
    model: args.model || DEFAULT_EMBEDDING_MODEL,
    baseUrl: args.baseUrl || DEFAULT_OLLAMA_BASE_URL,
    mode: args.mode || "hybrid",
    limit: args.limit,
    k: Math.max(10, args.k || 10),
    candidateLimit: args.candidateLimit || 80,
    threshold: args.threshold ?? 0.42,
  };
  const dbPath = resolveDbPath(full.db);
  const vecDbPath = resolveVecDbPath(full.vecDb, dbPath);
  const querySet = loadQuerySet(full.queries);
  const selected = typeof full.limit === "number" ? querySet.cases.slice(0, full.limit) : querySet.cases;
  closeDB();
  const db = getDB(dbPath, { readonly: true, create: false });
  let vecDb: Database | undefined;
  try {
    if (vecDbPath !== ":memory:" && !existsSync(vecDbPath)) {
      throw new Error(`Vec db is missing (${vecDbPath}). Run scripts/build-memory-embeddings.ts first.`);
    }
    vecDb = new Database(vecDbPath, { readonly: true, create: false });
    vecDb.exec("PRAGMA query_only = ON");
    if (!tableExists(vecDb, "memory_embeddings")) {
      throw new Error(`memory_embeddings table is missing in vec db (${vecDbPath}). Run scripts/build-memory-embeddings.ts first.`);
    }
    const embeddingCount = (vecDb.prepare("SELECT COUNT(*) as c FROM memory_embeddings WHERE embedding_model = ?").get(full.model) as { c: number }).c;
    if (embeddingCount === 0) {
      throw new Error(`No embeddings found for model ${full.model} in vec db (${vecDbPath}). Run scripts/build-memory-embeddings.ts first.`);
    }
    const startedAll = Date.now();
    const cases: EmbeddingCaseReport[] = [];
    for (const item of selected) {
      cases.push(await evaluateCase(db, vecDb, item, full, querySet));
    }
    const output: EmbeddingEvalOutput = {
      generated_at: new Date().toISOString(),
      db_path: dbPath,
      readonly: true,
      embedding: {
        mode: full.mode,
        model: full.model,
        vec_db_path: vecDbPath,
        candidate_limit: full.candidateLimit,
        threshold: full.threshold,
      },
      query_path: resolve(full.queries),
      k: full.k,
      limit: full.limit,
      db_counts: readDbCounts(db),
      metrics: computeMetrics(cases),
      failure_summary: summarizeFailures(cases),
      cases,
    };
    writeText(full.json, JSON.stringify(output, null, 2));
    writeText(full.markdown, toMarkdown(output, Date.now() - startedAll));
    return output;
  } finally {
    vecDb?.close();
    closeDB();
  }
}

async function evaluateCase(
  db: Database,
  vecDb: Database,
  item: RealRecallCase,
  args: Args,
  _querySet: RealRecallQuerySet,
): Promise<EmbeddingCaseReport> {
  const ownerId = item.owner_id || item.expected.owner_id;
  const started = performance.now();
  const embeddingHits = await searchEmbedding(db, vecDb, item.query, ownerId, args);
  const hits = args.mode === "hybrid"
    ? mergeHybrid(db, item.query, ownerId, embeddingHits, args)
    : embeddingHits;
  const elapsedMs = performance.now() - started;
  const expected = { ...item.expected, owner_id: item.expected.owner_id || item.owner_id };
  const topHits = hits.slice(0, args.k).map((hit, index) => toHitReport(hit, index + 1, expected));
  const relevantHits = topHits.filter(hit => hit.relevance.relevant);
  const relevantRank = relevantHits[0]?.rank ?? null;
  const ownerLeaks = findOwnerLeaks(topHits, expected.owner_id);
  const missAt5 = classifyMiss(topHits, hits.length, relevantRank, 5);
  const missAt10 = classifyMiss(topHits, hits.length, relevantRank, 10);
  return {
    id: item.id,
    category: item.category,
    query: item.query,
    owner_id: ownerId,
    recall_query: { text: item.query, owner_id: ownerId, limit: args.k },
    query_expansion: { enabled: false, variant: "baseline", search_terms: [], candidate_limit: args.candidateLimit, candidate_limit_mode: "baseline" },
    elapsed_ms: Number(elapsedMs.toFixed(2)),
    total_candidates: hits.length,
    relevant_rank: relevantRank,
    hit_at_5: relevantRank !== null && relevantRank <= 5,
    hit_at_10: relevantRank !== null && relevantRank <= 10,
    miss_type_at_5: missAt5.type,
    miss_type_at_10: missAt10.type,
    miss_reasons_at_5: missAt5.reasons,
    miss_reasons_at_10: missAt10.reasons,
    relevant_hit_ids: relevantHits.map(hit => hit.id || "").filter(Boolean),
    owner_leak_count: ownerLeaks.length,
    owner_leaks: ownerLeaks,
    top_hits: topHits,
    failure_reasons: missAt10.reasons,
    mode: args.mode,
    threshold: args.threshold,
  };
}

async function searchEmbedding(db: Database, vecDb: Database, query: string, ownerId: string | undefined, args: Args): Promise<EmbeddingHit[]> {
  const q = (await embedTexts([query], { model: args.model, baseUrl: args.baseUrl }))[0]!;
  const rows = vecDb.prepare(`
    SELECT * FROM memory_embeddings
    WHERE embedding_model = ?
      AND (? IS NULL OR owner_id = ?)
  `).all(args.model, ownerId || null, ownerId || null) as StoredEmbeddingRow[];

  const bestByEvent = new Map<string, EmbeddingHit>();
  for (const row of rows) {
    const vector = readEmbeddingVector(row);
    if (vector.length === 0) continue;
    const semantic = cosine(q, vector);
    if (semantic < args.threshold) continue;
    const event = eventById(db, row.target_id);
    if (!event) continue;
    const typeBoost = row.target_type === "event" ? 0 : 0.015;
    const score = semantic + typeBoost;
    const existing = bestByEvent.get(row.target_id);
    if (!existing || score > existing.score) {
      bestByEvent.set(row.target_id, {
        event,
        score,
        semantic_score: semantic,
        best_embedding_id: row.id,
        best_target_type: row.target_type,
        best_fact_kind: row.fact_kind,
        best_embedding_text: row.embedding_text,
      });
    }
  }
  return [...bestByEvent.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, args.candidateLimit);
}

function mergeHybrid(db: Database, query: string, ownerId: string | undefined, embeddingHits: EmbeddingHit[], args: Args): EmbeddingHit[] {
  const byId = new Map<string, EmbeddingHit>();
  for (const hit of embeddingHits) byId.set(hit.event.id || "", hit);
  const lexical = recall({ text: query, owner_id: ownerId, limit: Math.max(args.k, 20) }, { expansion: true, candidateLimitMode: "auto" });
  lexical.events.forEach((event, index) => {
    const id = event.id || "";
    const existing = byId.get(id);
    const lexicalScore = 0.46 - index * 0.006;
    if (existing) {
      existing.score = Math.max(existing.score, existing.semantic_score + lexicalScore);
    } else if (id) {
      byId.set(id, {
        event,
        score: lexicalScore,
        semantic_score: 0,
        best_embedding_id: "lexical",
        best_target_type: "lexical",
        best_fact_kind: event.event_type,
        best_embedding_text: event.summary || event.original_text || "",
      });
    }
  });
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, args.candidateLimit);
}

function toHitReport(hit: EmbeddingHit, rank: number, expected: RealRecallCase["expected"]): HitReport {
  const event = hit.event;
  const relevance = explainRelevance(event, expected);
  return {
    rank,
    id: event.id,
    owner_id: event.user_id,
    date: event.event_date || event.event_time?.slice(0, 10) || event.created_at?.slice(0, 10),
    type: event.event_type,
    summary_snippet: `${snippet(event.summary || event.original_text)} [emb:${hit.semantic_score.toFixed(4)} ${hit.best_target_type}/${hit.best_fact_kind || ""}]`,
    score: Number(hit.score.toFixed(4)),
    relevance,
  };
}

function classifyMiss(topHits: HitReport[], totalCandidates: number, relevantRank: number | null, threshold: 5 | 10) {
  if (relevantRank !== null && relevantRank <= threshold) return { type: null, reasons: [] };
  if (totalCandidates === 0 || topHits.length === 0) return { type: "no_candidates" as const, reasons: ["no_candidates"] };
  if (relevantRank !== null && relevantRank > threshold) return { type: threshold === 5 ? "relevant_beyond_5" as const : "relevant_beyond_k" as const, reasons: [`rank_${relevantRank}`] };
  const reasons = new Set<string>(["no_relevant_in_top_k"]);
  for (const hit of topHits.slice(0, 3)) for (const failed of hit.relevance.failed) reasons.add(`failed_criteria:${failed.split(":")[0]}`);
  return { type: "failed_criteria" as const, reasons: [...reasons] };
}

function tableExists(db: Database, name: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name));
}

function readDbCounts(db: Database) {
  const count = (name: string) => tableExists(db, name) ? (db.prepare(`SELECT COUNT(*) as c FROM ${name}`).get() as { c: number }).c : null;
  return {
    memory_events: count("memory_events") || 0,
    memory_events_fts: count("memory_events_fts"),
    owners: db.prepare(`SELECT COALESCE(NULLIF(user_id,''),'(none)') as owner_id, COUNT(*) as count FROM memory_events GROUP BY owner_id ORDER BY count DESC`).all() as Array<{ owner_id: string; count: number }>,
    event_types: db.prepare(`SELECT event_type, COUNT(*) as count FROM memory_events GROUP BY event_type ORDER BY count DESC`).all() as Array<{ event_type: string; count: number }>,
    date_range: db.prepare(`SELECT MIN(COALESCE(event_date, substr(event_time,1,10), substr(created_at,1,10))) as min_date, MAX(COALESCE(event_date, substr(event_time,1,10), substr(created_at,1,10))) as max_date FROM memory_events`).get() as { min_date: string | null; max_date: string | null },
  };
}

function summarizeFailures(cases: EmbeddingCaseReport[]) {
  const missed_by_category: Record<string, number> = {};
  const missed_by_type_at_5: Record<string, number> = {};
  const missed_by_type_at_10: Record<string, number> = {};
  const top_failure_reasons: Record<string, number> = {};
  for (const item of cases) {
    if (item.miss_type_at_5) missed_by_type_at_5[item.miss_type_at_5] = (missed_by_type_at_5[item.miss_type_at_5] || 0) + 1;
    if (item.miss_type_at_10) {
      missed_by_type_at_10[item.miss_type_at_10] = (missed_by_type_at_10[item.miss_type_at_10] || 0) + 1;
      missed_by_category[item.category || "uncategorized"] = (missed_by_category[item.category || "uncategorized"] || 0) + 1;
      for (const reason of item.failure_reasons) top_failure_reasons[reason] = (top_failure_reasons[reason] || 0) + 1;
    }
  }
  return { missed_by_category, missed_by_type_at_5, missed_by_type_at_10, top_failure_reasons };
}

function toMarkdown(output: EmbeddingEvalOutput, elapsedMs: number): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    "# xfeel-v3 embedding recall eval",
    "",
    `Generated: ${output.generated_at}`,
    `DB: ${output.db_path}`,
    `Vec DB: ${output.embedding.vec_db_path}`,
    `Mode: ${output.embedding.mode}`,
    `Model: ${output.embedding.model}`,
    `Candidate limit: ${output.embedding.candidate_limit}`,
    `Threshold: ${output.embedding.threshold}`,
    `Elapsed: ${elapsedMs}ms`,
    "",
    "| Hit@5 | Hit@10 | MRR | owner leaks | avg ms | p95 ms |",
    "|---:|---:|---:|---:|---:|---:|",
    `| ${pct(output.metrics.hit_at_5)} | ${pct(output.metrics.hit_at_10)} | ${output.metrics.mrr.toFixed(4)} | ${output.metrics.owner_leak_count} | ${output.metrics.avg_ms} | ${output.metrics.p95_ms} |`,
    "",
    "## Misses",
    "",
  ];
  const misses = output.cases.filter(c => !c.hit_at_10);
  if (!misses.length) lines.push("No missed cases in top 10.");
  for (const item of misses) {
    lines.push(`- ${item.id}: rank=${item.relevant_rank ?? "miss"}; ${item.query}`);
    lines.push(`  - top: ${item.top_hits.slice(0, 3).map(hit => `${hit.rank}.${hit.id}/${hit.score}`).join("; ")}`);
    lines.push(`  - reasons: ${item.failure_reasons.join(", ")}`);
  }
  lines.push("", "## Cases", "");
  for (const item of output.cases) {
    lines.push(`### ${item.id}`);
    lines.push(`query: ${item.query}`);
    lines.push(`rank: ${item.relevant_rank ?? "miss"}; Hit@5=${item.hit_at_5}; Hit@10=${item.hit_at_10}; elapsed=${item.elapsed_ms}ms`);
    for (const hit of item.top_hits.slice(0, 10)) {
      lines.push(`- ${hit.rank}. ${hit.id} owner=${hit.owner_id} type=${hit.type} score=${hit.score} relevant=${hit.relevance.relevant}`);
      lines.push(`  - ${hit.summary_snippet}`);
      if (hit.relevance.failed.length) lines.push(`  - failed: ${hit.relevance.failed.join("; ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function snippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 96);
}

function writeText(path: string, text: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, text);
}

function resolveVecDbPath(path: string | undefined, mainDbPath: string): string {
  if (path) return resolveDbPath(path);
  if (mainDbPath === ":memory:" || mainDbPath === "") return ":memory:";
  return resolve(dirname(mainDbPath), "xfeel.vec.db");
}

function resolveDbPath(path: string): string {
  return path === ":memory:" || path === "" ? ":memory:" : resolve(path);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: process.env.XFEEL_DB_PATH || "data/xfeel.db",
    vecDb: process.env.XFEEL_VEC_DB_PATH || "",
    queries: DEFAULT_QUERIES,
    json: DEFAULT_JSON,
    markdown: DEFAULT_MARKDOWN,
    model: DEFAULT_EMBEDDING_MODEL,
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
    mode: "hybrid",
    k: 10,
    candidateLimit: 80,
    threshold: 0.42,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i] || "";
    if (arg === "--db") args.db = next();
    else if (arg === "--vec-db") args.vecDb = next();
    else if (arg === "--queries") args.queries = next();
    else if (arg === "--json") args.json = next();
    else if (arg === "--markdown") args.markdown = next();
    else if (arg === "--model") args.model = next();
    else if (arg === "--base-url") args.baseUrl = next();
    else if (arg === "--mode") args.mode = next() as Args["mode"];
    else if (arg === "--limit") args.limit = Number(next());
    else if (arg === "--k") args.k = Math.max(10, Number(next()));
    else if (arg === "--candidate-limit") args.candidateLimit = Number(next());
    else if (arg === "--threshold") args.threshold = Number(next());
    else throw new Error(`Unknown arg: ${arg}`);
  }
  if (args.mode !== "embedding" && args.mode !== "hybrid") throw new Error("--mode must be embedding or hybrid");
  return args;
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const output = await runEmbeddingRecallEval(args);
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
    console.log(`[eval-embedding-recall] DB: ${output.db_path}`);
    console.log(`[eval-embedding-recall] Vec DB: ${output.embedding.vec_db_path}`);
    console.log(`[eval-embedding-recall] mode=${output.embedding.mode} model=${output.embedding.model} threshold=${output.embedding.threshold}`);
    console.log(`[eval-embedding-recall] metrics: Hit@5=${pct(output.metrics.hit_at_5)} Hit@10=${pct(output.metrics.hit_at_10)} mrr=${output.metrics.mrr.toFixed(4)} owner_leak_count=${output.metrics.owner_leak_count} avg_ms=${output.metrics.avg_ms} p95_ms=${output.metrics.p95_ms}`);
    console.log(`[eval-embedding-recall] wrote: json=${args.json} markdown=${args.markdown}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
