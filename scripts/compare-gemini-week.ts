import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

interface SampleTurn { id: string; turn_date: string; content: string; created_at: string; current_event_ids: string[] }

const ROOT = resolve(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "tmp", "gemini-week-eval");
const SOURCE_DB = join(ROOT, "data", "xfeel.db");
const SOURCE_VEC = join(ROOT, "data", "xfeel.vec.db");
const OWNER_ID = process.env.EVAL_OWNER_ID || "gWbuJBlAKI";
// 别名归一依赖正确的 family：从 owner 的成员归属反查，避免硬编码漂移（旧脚本写死 "xf" 实际不存在，
// 导致 aliasContext 为空、任何模型都无法把 阿禾→禾禾 归一）。
const FAMILY_ID = process.env.EVAL_FAMILY_ID || resolveFamilyId(OWNER_ID);
const START_DATE = process.env.EVAL_START_DATE || "2026-06-22";
const END_DATE = process.env.EVAL_END_DATE || "2026-06-25";
const LIMIT = Number(process.env.EVAL_LIMIT || "12");
const RUN_ID = process.env.EVAL_RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(OUT_DIR, { recursive: true });

// 两个模型走同一个 codex 网关端点，仅模型名不同。GPT 上游当前 401（token 失效），
// 故 GPT 侧改用库内已存的生产结果（gpt-5.5 当时跑出的回复 + 抽取事件），gemini 侧实跑。
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-low";
// 可选：把被测模型指向独立端点（非 codex 网关）。设置后会清空 CODEX_HOME 让 resolveLLMConfig 回落到 LLM_*。
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

if (process.env.EVAL_WORKER) {
  await runWorker(process.env.EVAL_WORKER);
} else {
  await runParent();
}

async function runParent() {
  const samples = loadSamples();
  const samplesPath = join(OUT_DIR, `${RUN_ID}-samples.json`);
  writeFileSync(samplesPath, JSON.stringify(samples, null, 2));

  // GPT 侧：直接读库内已存的生产结果（无需访问网关）。
  const gptResult = loadStoredGpt(samples);

  // Gemini 侧：实跑。
  const endpointEnv: Record<string, string> = {};
  if (GEMINI_BASE_URL) {
    const emptyCodex = join(OUT_DIR, "empty-codex");
    mkdirSync(emptyCodex, { recursive: true });
    endpointEnv.CODEX_HOME = emptyCodex;          // 让 readCodexConfig 返回空，回落到 LLM_*
    endpointEnv.LLM_BASE_URL = GEMINI_BASE_URL;
    endpointEnv.LLM_API_KEY = GEMINI_API_KEY;
    endpointEnv.LLM_MODEL = GEMINI_MODEL;
  }
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", import.meta.path],
    cwd: ROOT,
    env: { ...process.env, ...endpointEnv, XFEEL_MODEL_EXTRACT: GEMINI_MODEL, XFEEL_MODEL_INTENT: GEMINI_MODEL, XFEEL_MODEL_REPLY: GEMINI_MODEL, EVAL_WORKER: "gemini", EVAL_RUN_ID: RUN_ID, EVAL_SAMPLES_PATH: samplesPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  let geminiResult: any;
  if (proc.exitCode !== 0) {
    geminiResult = { error: `worker exit ${proc.exitCode}`, stdout, stderr };
  } else {
    const last = stdout.trim().split(/\n/).filter(Boolean).at(-1) || "{}";
    geminiResult = JSON.parse(last);
  }

  const report = { runId: RUN_ID, owner: OWNER_ID, family: FAMILY_ID, range: { start: START_DATE, end: END_DATE }, samples, results: { gpt: gptResult, gemini: geminiResult } };
  const outJson = join(OUT_DIR, `${RUN_ID}-raw.json`);
  const outMd = join(OUT_DIR, `${RUN_ID}-summary.md`);
  writeFileSync(outJson, JSON.stringify(report, null, 2));
  writeFileSync(outMd, renderMarkdown(report));
  console.log(JSON.stringify({ outJson, outMd, samples: samples.length, geminiOk: !geminiResult.error }, null, 2));
}

async function runWorker(label: string) {
  const samples = JSON.parse(await Bun.file(process.env.EVAL_SAMPLES_PATH!).text()) as SampleTurn[];
  const dbPath = join(OUT_DIR, `${RUN_ID}-${label}.db`);
  const vecPath = join(OUT_DIR, `${RUN_ID}-${label}.vec.db`);
  copyFileSync(SOURCE_DB, dbPath);
  if (existsSync(SOURCE_VEC)) copyFileSync(SOURCE_VEC, vecPath);
  process.env.XFEEL_DB_PATH = dbPath;
  process.env.XFEEL_VEC_DB_PATH = vecPath;
  process.env.LLM_TIMEOUT_MS = process.env.LLM_TIMEOUT_MS || "240000";

  const { getFamilySummary } = await import("../packages/db/src/family");
  const { closeDB, closeEmbeddingDB } = await import("../packages/db/src/database");
  const { logWithContextualReply } = await import("../packages/conversation/src/contextual-response");
  const summary = getFamilySummary({ family_id: FAMILY_ID });
  const speaker = summary?.speakers.find(s => s.self_label === "爸爸") || summary?.speakers[0];

  const items: any[] = [];
  for (const sample of samples) {
    const started = Date.now();
    try {
      const result = await logWithContextualReply({ text: sample.content, owner_id: OWNER_ID, date: sample.turn_date, force: true, limit: 6, speaker_id: speaker?.id, speaker_label: speaker?.self_label, aliasContext: summary?.aliasContext });
      items.push({
        sample_id: sample.id, date: sample.turn_date, text: sample.content, ms: Date.now() - started, ok: true,
        reply: result.reply,
        events: result.pipeline.events.map((e: any) => ({ summary: e.summary, event_type: e.event_type, entities: e.entities, emotion: e.emotion, tags: e.tags, open_facts: e.open_facts })),
        stored: result.pipeline.stored, meaningful: result.pipeline.meaningful, skipped: result.pipeline.skipped,
        recalled: result.context.recalled.map((r: any) => ({ summary: r.summary, date: r.event_time?.slice(0, 10), emotion: r.emotion, entities: r.entities })),
      });
    } catch (error) {
      items.push({ sample_id: sample.id, date: sample.turn_date, text: sample.content, ms: Date.now() - started, ok: false, error: String((error as Error)?.message || error) });
    }
  }
  closeEmbeddingDB(); closeDB();
  console.log(JSON.stringify({ label, modelExtract: process.env.XFEEL_MODEL_EXTRACT, modelReply: process.env.XFEEL_MODEL_REPLY, dbPath, vecPath, items }));
}

function loadSamples(): SampleTurn[] {
  const db = new Database(SOURCE_DB, { readonly: true });
  const rows = db.prepare(`
    SELECT id, turn_date, content, created_at, metadata
    FROM conversation_turns
    WHERE turn_date BETWEEN ? AND ? AND role='user' AND source='log' AND owner_id=?
      AND length(trim(content)) >= 18
      AND content NOT IN ('今天的日志','hello','提取字段是什么')
    ORDER BY created_at ASC
  `).all(START_DATE, END_DATE, OWNER_ID) as any[];
  db.close();
  return rows.slice(0, LIMIT).map(r => ({
    id: r.id, turn_date: r.turn_date, content: r.content, created_at: r.created_at,
    current_event_ids: safeJson<string[]>(r.metadata, {})?.current_event_ids || [],
  }));
}

/** 从库内读取 GPT-5.5 当时生产跑出的回复与抽取事件，组装成与 gemini worker 同构的结果。 */
function loadStoredGpt(samples: SampleTurn[]) {
  const db = new Database(SOURCE_DB, { readonly: true });
  const items = samples.map(sample => {
    const reply = (db.prepare(
      `SELECT content FROM conversation_turns WHERE owner_id=? AND role='assistant' AND created_at>? ORDER BY created_at ASC LIMIT 1`,
    ).get(OWNER_ID, sample.created_at) as any)?.content || "";

    const events = sample.current_event_ids.map(id => {
      const e = db.prepare(`SELECT summary, event_type, entities, emotion, tags, open_facts FROM memory_events WHERE id=?`).get(id) as any;
      if (!e) return null;
      return {
        summary: e.summary, event_type: e.event_type,
        entities: safeJson(e.entities, []), emotion: safeJson(e.emotion, null),
        tags: safeJson(e.tags, []), open_facts: safeJson(e.open_facts, []),
      };
    }).filter(Boolean);

    return { sample_id: sample.id, date: sample.turn_date, text: sample.content, ms: null, ok: true, reply, events };
  });
  db.close();
  return { label: "gpt", modelExtract: "gpt-5.4", modelReply: "gpt-5.5", source: "stored_production", items };
}

function resolveFamilyId(ownerId: string): string {
  const db = new Database(SOURCE_DB, { readonly: true });
  const row = db.prepare(`SELECT family_id FROM family_members WHERE id = ? LIMIT 1`).get(ownerId) as any;
  db.close();
  if (!row?.family_id) throw new Error(`无法从 owner_id=${ownerId} 反查 family_id（设 EVAL_FAMILY_ID 覆盖）`);
  return row.family_id;
}

function safeJson<T>(raw: any, fallback: T): T {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function renderMarkdown(rep: any): string {
  const lines: string[] = [];
  lines.push(`# gemini-3.5-flash-low vs gpt-5.5 — xfeel-v3 本周日志回复/提取对比`, ``);
  lines.push(`- 端点：同一 codex 网关（仅模型名不同）`);
  lines.push(`- GPT 侧：库内已存生产结果（gpt-5.5 回复 / gpt-5.4 抽取），非本次实跑`);
  lines.push(`- Gemini 侧：本次实跑 ${GEMINI_MODEL}`);
  lines.push(`- 时间范围：${START_DATE} ~ ${END_DATE}`);
  lines.push(`- 样本数：${rep.samples.length}`, ``);
  lines.push(`## 汇总`, `| 模型 | 成功 | 平均耗时 | 平均事件数 | 失败 |`, `|---|---:|---:|---:|---:|`);
  for (const [label, res] of [["gpt-5.5 (stored)", rep.results.gpt], [GEMINI_MODEL, rep.results.gemini]] as any[]) {
    const items = res?.items || [];
    const ok = items.filter((x: any) => x.ok);
    const withMs = ok.filter((x: any) => typeof x.ms === "number");
    const avgMs = withMs.length ? `${Math.round(withMs.reduce((s: number, x: any) => s + x.ms, 0) / withMs.length)}ms` : "—";
    const avgEvents = ok.length ? (ok.reduce((s: number, x: any) => s + x.events.length, 0) / ok.length).toFixed(1) : "0";
    lines.push(`| ${label} | ${ok.length}/${items.length} | ${avgMs} | ${avgEvents} | ${items.length - ok.length} |`);
  }
  lines.push(``);
  for (const sample of rep.samples) {
    const g = rep.results.gpt?.items?.find((x: any) => x.sample_id === sample.id);
    const m = rep.results.gemini?.items?.find((x: any) => x.sample_id === sample.id);
    lines.push(`## ${sample.turn_date} — ${sample.content}`, ``);
    lines.push(`### gpt-5.5 (stored)`); appendItem(lines, g);
    lines.push(`### ${GEMINI_MODEL}`); appendItem(lines, m);
  }
  return lines.join("\n");
}

function appendItem(lines: string[], item: any) {
  if (!item?.ok) { lines.push(`失败：${item?.error || "unknown"}`, ``); return; }
  if (typeof item.ms === "number") lines.push(`- 耗时：${item.ms}ms`);
  lines.push(`- 回复：${String(item.reply).replace(/\n/g, " / ")}`);
  lines.push(`- 提取：`);
  for (const e of item.events) lines.push(`  - ${e.summary} | type=${e.event_type} | entities=${JSON.stringify(e.entities)} | emotion=${JSON.stringify(e.emotion)} | tags=${JSON.stringify(e.tags)}`);
  if (item.events.length === 0) lines.push(`  - （无）`);
  lines.push("");
}
