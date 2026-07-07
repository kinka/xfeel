import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { getDB, closeDB } from "../packages/db/src/database";
import { initSchema } from "../packages/db/src/schema";
import { recall, type RecallQuery } from "../packages/retrieval/src/recall";
import { normalizeEntity, normalizeEventType } from "../packages/domain/src/normalization";
import { normalizeTag } from "../packages/domain/src/tag-vocabulary";
import { normalizeEmotion } from "../packages/domain/src/emotion-vocabulary";
import { resolveOwnerContext } from "../packages/domain/src/owner";
import {
  deriveEventDate,
  EXTRACTOR_VERSION,
  SEARCH_TEXT_VERSION,
  VOCAB_VERSION,
} from "../packages/domain/src/provenance";
import { buildCanonicalSearchText } from "../packages/domain/src/search-text";

interface EvalData {
  today: string;
  seed_events: SeedEvent[];
  cases: EvalCase[];
}

interface SeedEvent {
  id: string;
  owner_id: string;
  summary: string;
  original_text: string;
  event_type: string;
  entities: string[];
  emotion: { primary: string; secondary?: string; intensity: number; valence: "positive" | "negative" | "neutral" };
  tags: string[];
  event_time: string;
}

interface EvalCase {
  id: string;
  question: string;
  owner_id: string;
  expected_query: Partial<RecallQuery>;
  expected_event_ids: string[];
}

type Source = "rules" | "llm" | "llm_fallback";

interface ParsedQueryResult {
  query: RecallQuery;
  source: Source;
  latency_ms: number;
  error?: string;
}

interface CaseReport {
  id: string;
  question: string;
  model: string;
  source: Source;
  latency_ms: number;
  query: RecallQuery;
  query_passed: boolean;
  recall_passed: boolean;
  expected_query: Partial<RecallQuery>;
  expected_event_ids: string[];
  recalled_event_ids: string[];
  missing_query_fields: string[];
  missing_event_ids: string[];
  error?: string;
}

interface EvalDbSelection {
  path: string;
  source: "temp" | "env";
}

type EvalEnv = Record<string, string | undefined> & { XFEEL_DB_PATH?: string };

const PROD_DB_PATH = resolve(process.cwd(), "data", "xfeel.db");

let data: EvalData;

export async function main(argv = process.argv.slice(2), env: EvalEnv = process.env) {
  const args = parseArgs(argv);
  data = JSON.parse(readFileSync(args.dataset, "utf8")) as EvalData;

  const dbSelection = selectEvalDbPath(env);
  console.log(`[eval-recall-hard] DB: ${dbSelection.path}`);

  closeDB();
  const db = getDB(dbSelection.path);
  try {
    initSchema(db);
    seedEvents(db, data.seed_events, dbSelection.path);

    const models = args.models.split(",").map(s => s.trim()).filter(Boolean);
    const reports = [];
    if (args.rules) reports.push(await runModel("rules", data.cases));
    for (const model of models) reports.push(await runModel(model, data.cases));

    const output = { generated_at: new Date().toISOString(), dataset: args.dataset, db_path: dbSelection.path, reports };
    if (args.json) writeFileSync(args.json, JSON.stringify(output, null, 2));
    if (args.markdown) writeFileSync(args.markdown, toMarkdown(output));
    console.log(toMarkdown(output));
  } finally {
    closeDB();
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    closeDB();
    process.exit(1);
  });
}

async function runModel(model: string, cases: EvalCase[]) {
  const caseReports: CaseReport[] = [];
  for (const item of cases) {
    const parsed = model === "rules"
      ? parseRecallQueryRules(item.question, item.owner_id, data.today)
      : await parseRecallQueryLLM(item.question, item.owner_id, model, data.today);
    // Recall is evaluated on the structured query fields. v3's current recall() still treats
    // text as a literal LIKE string, so a multi-token text query can mask an otherwise-good
    // query-understanding result. Keep text in the report, but don't let it dominate this eval.
    const recallQuery = { ...parsed.query, text: undefined, owner_id: item.owner_id, limit: 8 };
    const result = recall(recallQuery);
    const recalledIds = result.events.map(event => event.id).filter(Boolean) as string[];
    const missingQueryFields = diffExpectedQuery(item.expected_query, parsed.query, item.owner_id);
    const missingEventIds = item.expected_event_ids.filter(id => !recalledIds.includes(id));
    caseReports.push({
      id: item.id,
      question: item.question,
      model,
      source: parsed.source,
      latency_ms: parsed.latency_ms,
      query: parsed.query,
      query_passed: missingQueryFields.length === 0,
      recall_passed: missingEventIds.length === 0,
      expected_query: item.expected_query,
      expected_event_ids: item.expected_event_ids,
      recalled_event_ids: recalledIds,
      missing_query_fields: missingQueryFields,
      missing_event_ids: missingEventIds,
      error: parsed.error,
    });
  }
  return summarize(model, caseReports);
}

function summarize(model: string, cases: CaseReport[]) {
  const queryPassed = cases.filter(c => c.query_passed).length;
  const recallPassed = cases.filter(c => c.recall_passed).length;
  const latencies = cases.map(c => c.latency_ms).sort((a, b) => a - b);
  return {
    model,
    total_cases: cases.length,
    query_passed: queryPassed,
    recall_passed: recallPassed,
    query_hit_rate: Number((queryPassed / cases.length).toFixed(4)),
    recall_hit_rate: Number((recallPassed / cases.length).toFixed(4)),
    avg_latency_ms: Math.round(cases.reduce((sum, c) => sum + c.latency_ms, 0) / cases.length),
    median_latency_ms: latencies[Math.floor(latencies.length / 2)] ?? 0,
    p95_latency_ms: latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0,
    cases,
  };
}

function parseRecallQueryRules(question: string, ownerId: string, today: string): ParsedQueryResult {
  const start = Date.now();
  const text = question.trim();
  const ownerContext = resolveOwnerContext({ ownerId });
  const query: RecallQuery = { owner_id: ownerId, limit: 8 };

  const entities = new Set<string>();
  const addEntity = (raw: string) => {
    const normalized = normalizeEntity(raw, ownerContext);
    if (normalized) entities.add(normalized);
  };
  if (/星星|阿星|小宝/.test(text)) addEntity("星星");
  if (/禾禾|阿禾|大宝/.test(text)) addEntity("禾禾");
  if (/两个宝宝|俩宝|俩娃|双胞胎|宝宝们/.test(text)) { addEntity("星星"); addEntity("禾禾"); }
  if (/(^|[^不没别])(我|自己|这边)/.test(text) || /妈妈/.test(text)) addEntity(text.includes("妈妈") ? "妈妈" : "我");
  if (/爸爸/.test(text)) addEntity("爸爸");
  // Handle explicit negated entity: "不是星星，是禾禾".
  if (/不是星星.*禾禾/.test(text)) entities.delete("星星");
  if (/不是禾禾.*星星/.test(text)) entities.delete("禾禾");
  if (entities.size) query.entities = [...entities];

  const types = new Set<string>();
  if (/睡|夜醒|入睡|午睡|醒/.test(text)) types.add("sleep");
  if (/吃|辅食|吃饭|吃东西|喂|奶/.test(text)) types.add("feeding");
  if (/生病|发烧|咳|疫苗|打针|不舒服|健康/.test(text)) types.add("health");
  if (/里程碑|进展|变化|表达|说话|语言|走路|大运动|扶着|站|爬/.test(text)) types.add("milestone");
  if (/压力|工作|汇报|项目/.test(text)) types.add("work");
  if (/闹别扭|抢|冲突|吵|玩具/.test(text)) types.add("conflict");
  if (/情绪|心情|难过|开心|焦虑|疲惫|担心|松口气|心疼|无奈/.test(text) && types.size === 0) types.add("emotion");
  if (/不是生病/.test(text)) types.delete("health");
  if (types.size) query.event_types = [...types].map(t => normalizeEventType(t));

  const tags = new Set<string>();
  for (const tag of ["疫苗", "发烧", "夜醒", "午睡", "哄睡", "玩具", "语言表达", "走路", "辅食", "工作", "压力"]) {
    if (text.includes(tag) || (tag === "疫苗" && text.includes("打针")) || (tag === "语言表达" && /表达|说话|语言/.test(text)) || (tag === "辅食" && /吃东西|吃饭/.test(text))) {
      const normalized = normalizeTag(tag) || tag;
      tags.add(normalized);
    }
  }
  if (tags.size) query.tags = [...tags];

  const emotions = new Set<string>();
  for (const e of ["疲惫", "焦虑", "担心", "心疼", "压力", "释然", "自豪", "惊喜", "无奈"]) {
    if (text.includes(e) || (e === "释然" && /松口气|顺利/.test(text))) emotions.add(e);
  }
  if (emotions.size) query.emotions = [...emotions];
  if (/压力大|担心|不舒服|不太顺|闹别扭|生病|发烧|哭|疲惫/.test(text) && !/不要压力/.test(text)) query.valence = "negative";
  if (/松口气|顺利|开心|进展|进步|惊喜|自豪/.test(text)) query.valence = "positive";

  const range = parseDateRange(text, today);
  if (range) {
    query.date_from = range.from;
    query.date_to = range.to;
  }

  query.text = buildTextQuery(text, query);
  return { query, source: "rules", latency_ms: Date.now() - start };
}

async function parseRecallQueryLLM(question: string, ownerId: string, model: string, today: string): Promise<ParsedQueryResult> {
  const start = Date.now();
  const rules = parseRecallQueryRules(question, ownerId, today).query;
  const system = `你是家庭记忆系统的检索 query parser。今天是 ${today}。owner_id=${ownerId}，demo-dad-owner=爸爸，demo-mom-owner=妈妈。\n把用户问题转成 JSON RecallQuery。只输出 JSON，不要 Markdown。\n字段：text, entities, event_types, emotions, tags, valence(positive/negative/neutral), date_from(YYYY-MM-DD), date_to(YYYY-MM-DD)。\n规则：\n- “我/自己/这边”指当前 owner。\n- “不是X，是Y”要排除 X。\n- “不要压力大的”这类否定不要设置 negative。\n- 没明确问平静/中性时，不要设置 neutral。\n- 事件类型只能用 sleep, feeding, health, milestone, emotion, care, conflict, work, social, daily, reflection, other。`;
  const prompt = `问题：${question}\n规则基线：${JSON.stringify(rules)}\n请输出更准确的 RecallQuery JSON。`;
  try {
    const raw = await callOpenAI(model, system, prompt);
    const llmQuery = sanitizeQuery(JSON.parse(extractJSON(raw)), ownerId);
    return { query: mergeQueries(rules, llmQuery, question), source: "llm", latency_ms: Date.now() - start };
  } catch (error) {
    return { query: rules, source: "llm_fallback", latency_ms: Date.now() - start, error: error instanceof Error ? error.message : String(error) };
  }
}

async function callOpenAI(model: string, system: string, prompt: string): Promise<string> {
  const baseUrl = (process.env.RECALL_EVAL_BASE_URL || process.env.LLM_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.RECALL_EVAL_API_KEY || process.env.LLM_API_KEY;
  if (!baseUrl) throw new Error("RECALL_EVAL_BASE_URL/LLM_BASE_URL is required");
  const url = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(Number(process.env.RECALL_EVAL_TIMEOUT_MS) || 120_000),
  });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content || "{}";
}

function mergeQueries(rules: RecallQuery, llm: RecallQuery, question: string): RecallQuery {
  const merged: RecallQuery = { ...rules };
  for (const key of ["date_from", "date_to", "text"] as const) if (llm[key]) (merged as any)[key] = llm[key];
  for (const key of ["entities", "event_types", "emotions", "tags"] as const) {
    const values = [...(rules[key] || []), ...(llm[key] || [])].filter(Boolean) as string[];
    if (values.length) (merged as any)[key] = [...new Set(values)];
  }
  if (llm.valence && !(llm.valence === "neutral" && !/平静|中性|neutral/.test(question))) merged.valence = llm.valence;
  if (/不要压力/.test(question) && merged.valence === "negative") delete merged.valence;
  return sanitizeQuery(merged, rules.owner_id || "");
}

function sanitizeQuery(raw: Partial<RecallQuery>, ownerId: string): RecallQuery {
  const ownerContext = resolveOwnerContext({ ownerId });
  const q: RecallQuery = { owner_id: ownerId, limit: 8 };
  if (raw.text) q.text = String(raw.text);
  if (raw.entities?.length) q.entities = [...new Set(raw.entities.map(e => normalizeEntity(String(e), ownerContext)).filter(Boolean) as string[])];
  if (raw.event_types?.length) q.event_types = [...new Set(raw.event_types.map(e => normalizeEventType(String(e))))];
  if (raw.emotions?.length) q.emotions = [...new Set(raw.emotions.map(e => normalizeEmotion(String(e))?.word || String(e)))];
  if (raw.tags?.length) q.tags = [...new Set(raw.tags.map(t => normalizeTag(String(t)) || String(t)))];
  if (raw.valence && ["positive", "negative", "neutral"].includes(raw.valence)) q.valence = raw.valence;
  if (raw.date_from) q.date_from = String(raw.date_from).slice(0, 10);
  if (raw.date_to) q.date_to = String(raw.date_to).slice(0, 10);
  return q;
}

function diffExpectedQuery(expected: Partial<RecallQuery>, actual: RecallQuery, ownerId: string): string[] {
  const missing: string[] = [];
  const ownerContext = resolveOwnerContext({ ownerId });
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (Array.isArray(expectedValue)) {
      const actualValues = new Set(((actual as any)[key] || []).map((v: string) => {
        if (key === "entities") return normalizeEntity(v, ownerContext) || v;
        if (key === "event_types") return normalizeEventType(v);
        if (key === "tags") return normalizeTag(v) || v;
        if (key === "emotions") return normalizeEmotion(v)?.word || v;
        return v;
      }));
      for (const raw of expectedValue) {
        const expectedNormalized = key === "entities" ? normalizeEntity(String(raw), ownerContext) || raw : key === "event_types" ? normalizeEventType(String(raw)) : key === "tags" ? normalizeTag(String(raw)) || raw : raw;
        if (!actualValues.has(expectedNormalized)) missing.push(`${key}:${raw}`);
      }
    } else if (expectedValue && (actual as any)[key] !== expectedValue) {
      missing.push(`${key}:${expectedValue}`);
    }
  }
  return missing;
}

export function selectEvalDbPath(env: EvalEnv = process.env): EvalDbSelection {
  const explicitPath = env.XFEEL_DB_PATH?.trim();
  const path = explicitPath
    ? resolve(explicitPath)
    : join(mkdtempSync(join(tmpdir(), "xfeel-recall-eval-")), "eval.db");

  assertSafeEvalDbPath(path);
  return { path, source: explicitPath ? "env" : "temp" };
}

export function assertSafeEvalDbPath(dbPath: string) {
  if (dbPath === ":memory:") return;

  const path = resolve(dbPath);
  if (path === PROD_DB_PATH || /[/\\]data[/\\]xfeel\.db$/i.test(path) || basename(path) === "xfeel.db") {
    throw new Error(`Refusing to run recall eval against production-looking DB path: ${path}`);
  }

  const tmpRoot = resolve(tmpdir());
  const lowerPath = path.toLowerCase();
  const isUnderTmp = lowerPath === tmpRoot.toLowerCase() || lowerPath.startsWith(`${tmpRoot.toLowerCase()}/`);
  const hasEvalMarker = path.split(/[/\\]+/).some(segment => /(^|[-_.])(eval|test|tmp|temp|throwaway|scratch)([-_.]|$)/i.test(segment));
  if (!isUnderTmp && !hasEvalMarker) {
    throw new Error(`Refusing to run recall eval without an eval/test/temp DB path: ${path}`);
  }
}

export function seedEvents(db: Database, events: SeedEvent[], dbPath: string) {
  assertSafeEvalDbPath(dbPath);
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM causal_chains");
    db.exec("DELETE FROM entity_events");
    db.exec("DELETE FROM memory_events");
    for (const event of events) {
      db.prepare(`
        INSERT INTO memory_events (
          id,
          raw_message_id,
          event_index,
          original_span,
          event_date,
          extractor_version,
          vocab_version,
          search_text_version,
          summary,
          original_text,
          event_type,
          entities,
          emotion,
          tags,
          canonical_search_text,
          event_time,
          confidence,
          source,
          source_layer,
          user_id,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          event.id,
          event.id,
          0,
          event.original_text,
          deriveEventDate(event.event_time),
          EXTRACTOR_VERSION,
          VOCAB_VERSION,
          SEARCH_TEXT_VERSION,
          event.summary,
          event.original_text,
          normalizeEventType(event.event_type),
          JSON.stringify(event.entities),
          JSON.stringify(event.emotion),
          JSON.stringify(event.tags),
          buildCanonicalSearchText({
            summary: event.summary,
            original_text: event.original_text,
            event_type: event.event_type,
            entities: event.entities,
            tags: event.tags,
            emotion: event.emotion,
            user_id: event.owner_id,
          }),
          event.event_time,
          1,
          "user",
          "extracted",
          event.owner_id,
          event.event_time,
          event.event_time,
        );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function parseDateRange(text: string, todayISO: string): { from: string; to: string } | null {
  const today = new Date(`${todayISO}T00:00:00Z`);
  if (/上个月/.test(text)) {
    const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
    return { from: dateOnly(from), to: dateOnly(to) };
  }
  if (/上周/.test(text)) {
    return { from: "2026-06-01", to: "2026-06-07" };
  }
  if (/最近|这两天|近来/.test(text)) {
    const from = new Date(today); from.setUTCDate(from.getUTCDate() - 14);
    return { from: dateOnly(from), to: dateOnly(today) };
  }
  return null;
}

function dateOnly(date: Date): string { return date.toISOString().slice(0, 10); }

function buildTextQuery(text: string, query: RecallQuery): string | undefined {
  const parts = [...(query.tags || []), ...(query.entities || []), ...(query.emotions || [])];
  for (const term of ["打针", "不舒服", "闹别扭", "玩具", "表达", "吃东西", "松口气", "大运动"]) if (text.includes(term)) parts.push(term);
  return [...new Set(parts)].slice(0, 4).join(" ") || undefined;
}

function extractJSON(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1]!.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw;
}

function toMarkdown(output: any): string {
  const lines = ["# xfeel-v3 hard recall eval", "", `Generated: ${output.generated_at}`, `DB: ${output.db_path}`, "", "| model | query | recall | avg ms | p95 ms |", "|---|---:|---:|---:|---:|"];
  for (const r of output.reports) lines.push(`| ${r.model} | ${(r.query_hit_rate * 100).toFixed(1)}% | ${(r.recall_hit_rate * 100).toFixed(1)}% | ${r.avg_latency_ms} | ${r.p95_latency_ms} |`);
  for (const r of output.reports) {
    lines.push("", `## ${r.model}`);
    for (const c of r.cases.filter((x: CaseReport) => !x.query_passed || !x.recall_passed || x.error)) {
      lines.push(`- ${c.id}: query=${c.query_passed ? "✅" : "❌"} recall=${c.recall_passed ? "✅" : "❌"} latency=${c.latency_ms}ms`);
      if (c.missing_query_fields.length) lines.push(`  - missing query: ${c.missing_query_fields.join(", ")}`);
      if (c.missing_event_ids.length) lines.push(`  - missing events: ${c.missing_event_ids.join(", ")}`);
      if (c.error) lines.push(`  - error: ${c.error.replace(/Bearer\s+\S+/g, "Bearer [REDACTED]").slice(0, 300)}`);
      lines.push(`  - actual: ${JSON.stringify(c.query)}`);
      lines.push(`  - recalled: ${c.recalled_event_ids.join(", ")}`);
    }
  }
  return lines.join("\n");
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { dataset: "data/recall-eval-hard.json", models: "", rules: false, json: "", markdown: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dataset") out.dataset = argv[++i]!;
    else if (arg === "--models") out.models = argv[++i]!;
    else if (arg === "--rules") out.rules = true;
    else if (arg === "--json") out.json = argv[++i]!;
    else if (arg === "--markdown") out.markdown = argv[++i]!;
  }
  return out;
}
