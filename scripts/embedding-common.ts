import { Database } from "bun:sqlite";
import type { MemoryEvent } from "../packages/domain/src/memory-event";
import { buildCanonicalSearchText } from "../packages/domain/src/search-text";
import { normalizeOpenFacts } from "../packages/domain/src/open-facts";

export const DEFAULT_EMBEDDING_MODEL = process.env.XFEEL_EMBEDDING_MODEL || "qwen3-embedding:0.6b";
export const DEFAULT_OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
export const DEFAULT_EMBEDDING_KEEP_ALIVE = parseKeepAlive(process.env.XFEEL_EMBEDDING_KEEP_ALIVE, -1);
export const DEFAULT_EMBEDDING_NUM_CTX = parsePositiveInt(process.env.XFEEL_EMBEDDING_NUM_CTX, 2048) ?? 2048;
export const DEFAULT_EMBEDDING_STARTUP_TIMEOUT_MS = parsePositiveInt(process.env.XFEEL_EMBEDDING_STARTUP_TIMEOUT_MS, 5_000) ?? 5_000;

export type EmbeddingTargetType = "event" | "fact" | "tag" | "entity" | "location";

export interface EmbeddingUnit {
  id: string;
  owner_id: string;
  target_type: EmbeddingTargetType;
  target_id: string;
  fact_kind?: string;
  embedding_text: string;
  event: MemoryEvent;
}

export interface StoredEmbeddingRow {
  id: string;
  owner_id: string;
  target_type: EmbeddingTargetType;
  target_id: string;
  fact_kind?: string | null;
  embedding_model: string;
  embedding_dim: number;
  embedding_text: string;
  embedding_json?: string | null;
  embedding_blob?: Uint8Array | null;
}

/** 向量以 Float32 紧凑二进制存储（4 字节/维），比十进制 JSON 文本（~12.7KB/1024维）小约 3 倍。 */
export function floatsToBlob(vec: number[]): Uint8Array {
  const f32 = new Float32Array(vec);
  return new Uint8Array(f32.buffer.slice(0));
}

export function blobToFloats(blob: Uint8Array | ArrayBuffer): number[] {
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  // 拷贝出对齐的 buffer，避免 byteOffset 不是 4 的倍数时构造 Float32Array 报错。
  const aligned = u8.byteOffset % 4 === 0 && u8.byteLength % 4 === 0
    ? u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
    : new Uint8Array(u8).buffer;
  return Array.from(new Float32Array(aligned));
}

/** 读取一条 embedding 行的向量：优先二进制 blob，回退旧的 JSON 文本。 */
export function readEmbeddingVector(row: { embedding_blob?: Uint8Array | null; embedding_json?: string | null }): number[] {
  if (row.embedding_blob && row.embedding_blob.byteLength > 0) return blobToFloats(row.embedding_blob);
  if (row.embedding_json) {
    try { return JSON.parse(row.embedding_json) as number[]; } catch { return []; }
  }
  return [];
}

export function ensureEmbeddingSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      fact_kind TEXT,
      embedding_model TEXT NOT NULL,
      embedding_dim INTEGER NOT NULL,
      embedding_text TEXT NOT NULL,
      embedding_json TEXT,
      embedding_blob BLOB,
      source_updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_owner_model
      ON memory_embeddings(owner_id, embedding_model);
    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_target
      ON memory_embeddings(target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_fact_kind
      ON memory_embeddings(owner_id, fact_kind);
  `);
  // 旧库迁移：补上二进制列。
  const cols = db.prepare("PRAGMA table_info(memory_embeddings)").all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === "embedding_blob")) {
    db.exec("ALTER TABLE memory_embeddings ADD COLUMN embedding_blob BLOB");
  }
}

export interface UpsertEmbeddingsOptions {
  model?: string;
  baseUrl?: string;
  batchSize?: number;
  keepAlive?: string | number;
  numCtx?: number;
  reset?: boolean;
}

export interface UpsertEmbeddingsResult {
  units: number;
  pending: number;
  written: number;
  model: string;
}

export async function embedTexts(
  texts: string[],
  options: { model?: string; baseUrl?: string; batchSize?: number; keepAlive?: string | number; numCtx?: number } = {},
): Promise<number[][]> {
  const model = options.model || DEFAULT_EMBEDDING_MODEL;
  const baseUrl = (options.baseUrl || DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, "");
  const batchSize = Math.max(1, Math.floor(options.batchSize || 32));
  const keepAlive = options.keepAlive ?? DEFAULT_EMBEDDING_KEEP_ALIVE;
  const numCtx = parsePositiveInt(options.numCtx, DEFAULT_EMBEDDING_NUM_CTX);
  const output: number[][] = [];

  for (let start = 0; start < texts.length; start += batchSize) {
    const input = texts.slice(start, start + batchSize);
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildEmbedRequestBody({ model, input, keepAlive, numCtx })),
    });
    if (!response.ok) {
      throw new Error(`Ollama embed failed ${response.status}: ${await response.text()}`);
    }
    const parsed = await response.json() as { embeddings?: number[][]; embedding?: number[] };
    if (Array.isArray(parsed.embeddings)) output.push(...parsed.embeddings);
    else if (Array.isArray(parsed.embedding)) output.push(parsed.embedding);
    else throw new Error(`Unexpected Ollama embed response: ${JSON.stringify(parsed).slice(0, 200)}`);
  }

  if (output.length !== texts.length) {
    throw new Error(`Ollama returned ${output.length} embeddings for ${texts.length} texts`);
  }
  return output;
}

export interface OllamaEmbeddingWarmupResult {
  ok: boolean;
  model: string;
  baseUrl: string;
  keepAlive?: string | number;
  numCtx?: number;
  version?: string;
  dimension?: number;
  loaded?: boolean;
  expiresAt?: string;
  contextLength?: number;
  sizeVram?: number;
  error?: string;
  elapsedMs: number;
}

export async function warmOllamaEmbedding(
  options: {
    model?: string;
    baseUrl?: string;
    keepAlive?: string | number;
    numCtx?: number;
    input?: string;
    timeoutMs?: number;
  } = {},
): Promise<OllamaEmbeddingWarmupResult> {
  const startedAt = Date.now();
  const model = options.model || DEFAULT_EMBEDDING_MODEL;
  const baseUrl = (options.baseUrl || DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, "");
  const keepAlive = options.keepAlive ?? DEFAULT_EMBEDDING_KEEP_ALIVE;
  const numCtx = parsePositiveInt(options.numCtx, DEFAULT_EMBEDDING_NUM_CTX);
  const timeoutMs = parsePositiveInt(options.timeoutMs, DEFAULT_EMBEDDING_STARTUP_TIMEOUT_MS) ?? DEFAULT_EMBEDDING_STARTUP_TIMEOUT_MS;

  try {
    const versionRes = await fetchWithTimeout(`${baseUrl}/api/version`, { method: "GET" }, timeoutMs);
    if (!versionRes.ok) throw new Error(`Ollama version check failed ${versionRes.status}: ${await versionRes.text()}`);
    const versionBody = await versionRes.json().catch(() => ({})) as { version?: string };

    const embedRes = await fetchWithTimeout(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildEmbedRequestBody({
        model,
        input: options.input || "xfeel embedding startup warmup",
        keepAlive,
        numCtx,
      })),
    }, timeoutMs);
    if (!embedRes.ok) throw new Error(`Ollama embed warmup failed ${embedRes.status}: ${await embedRes.text()}`);
    const embedBody = await embedRes.json() as { embeddings?: number[][]; embedding?: number[] };
    const vector = Array.isArray(embedBody.embeddings?.[0]) ? embedBody.embeddings[0] : embedBody.embedding;
    if (!Array.isArray(vector)) {
      throw new Error(`Unexpected Ollama embed warmup response: ${JSON.stringify(embedBody).slice(0, 200)}`);
    }

    const loaded = await readLoadedOllamaModel(baseUrl, model, timeoutMs);
    return {
      ok: true,
      model,
      baseUrl,
      keepAlive,
      numCtx,
      version: versionBody.version,
      dimension: vector.length,
      loaded: Boolean(loaded),
      expiresAt: loaded?.expires_at,
      contextLength: loaded?.context_length,
      sizeVram: loaded?.size_vram,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      model,
      baseUrl,
      keepAlive,
      numCtx,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    };
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export function parseJsonArray(value?: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function parseEmotion(value?: string | null): MemoryEvent["emotion"] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonValue<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function rowToMemoryEvent(row: Record<string, unknown>): MemoryEvent {
  return {
    id: String(row.id || ""),
    raw_message_id: optionalString(row.raw_message_id),
    summary: String(row.summary || ""),
    original_text: String(row.original_text || ""),
    original_span: optionalString(row.original_span),
    event_type: String(row.event_type || "other") as MemoryEvent["event_type"],
    entities: parseJsonArray(optionalString(row.entities)),
    emotion: parseEmotion(optionalString(row.emotion)) || { primary: "平静", intensity: 0.3, valence: "neutral" },
    tags: parseJsonArray(optionalString(row.tags)),
    open_facts: normalizeOpenFacts(parseJsonValue(optionalString(row.open_facts), []), {
      id: String(row.id || ""),
      summary: String(row.summary || ""),
      original_text: String(row.original_text || ""),
      original_span: optionalString(row.original_span),
      event_type: String(row.event_type || "other") as MemoryEvent["event_type"],
      entities: parseJsonArray(optionalString(row.entities)),
      tags: parseJsonArray(optionalString(row.tags)),
      emotion: parseEmotion(optionalString(row.emotion)) || { primary: "平静", intensity: 0.3, valence: "neutral" },
      location: optionalString(row.location),
    }),
    location: optionalString(row.location),
    event_time: optionalString(row.event_time),
    event_date: optionalString(row.event_date),
    confidence: typeof row.confidence === "number" ? row.confidence : 1,
    source: (optionalString(row.source) || "user") as MemoryEvent["source"],
    source_layer: (optionalString(row.source_layer) || "extracted") as MemoryEvent["source_layer"],
    source_archive_id: optionalString(row.source_archive_id),
    user_id: optionalString(row.user_id),
    event_index: typeof row.event_index === "number" ? row.event_index : undefined,
    extractor_version: optionalString(row.extractor_version),
    vocab_version: optionalString(row.vocab_version),
    search_text_version: optionalString(row.search_text_version),
    created_at: optionalString(row.created_at),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function buildEmbeddingUnits(event: MemoryEvent): EmbeddingUnit[] {
  const id = event.id || "";
  const owner = event.user_id || "";
  if (!id || !owner) return [];

  const canonical = buildCanonicalSearchText(event);
  const base = [
    `summary: ${event.summary}`,
    event.original_span ? `span: ${event.original_span}` : "",
    event.original_text ? `original: ${event.original_text.slice(0, 500)}` : "",
    `type: ${event.event_type}`,
    event.location ? `location: ${event.location}` : "",
    event.entities?.length ? `entities: ${event.entities.join(" ")}` : "",
    event.tags?.length ? `tags: ${event.tags.join(" ")}` : "",
    event.emotion?.primary ? `emotion: ${event.emotion.primary} ${event.emotion.valence}` : "",
    canonical ? `canonical: ${canonical}` : "",
  ].filter(Boolean).join("\n");

  const units: EmbeddingUnit[] = [{
    id: `${id}:event`,
    owner_id: owner,
    target_type: "event",
    target_id: id,
    fact_kind: event.event_type,
    embedding_text: base,
    event,
  }];

  for (const fact of normalizeOpenFacts(event.open_facts || [], event)) {
    units.push({
      id: fact.id || `${id}:fact:${stableKey(`${fact.kind}:${fact.value}:${fact.surface}`)}`,
      owner_id: owner,
      target_type: "fact",
      target_id: id,
      fact_kind: fact.kind,
      embedding_text: [
        `fact_kind: ${fact.kind}`,
        `fact_value: ${fact.value}`,
        `surface: ${fact.surface}`,
        fact.actor_id ? `actor: ${fact.actor_id}` : "",
        fact.experiencer_id ? `experiencer: ${fact.experiencer_id}` : "",
        fact.observer_id ? `observer: ${fact.observer_id}` : "",
        fact.polarity ? `polarity: ${fact.polarity}` : "",
        `summary: ${event.summary}`,
        event.original_span || event.original_text,
      ].filter(Boolean).join("\n"),
      event,
    });
  }

  for (const tag of event.tags || []) {
    units.push({
      id: `${id}:tag:${stableKey(tag)}`,
      owner_id: owner,
      target_type: "tag",
      target_id: id,
      fact_kind: "tag",
      embedding_text: [`tag: ${tag}`, `summary: ${event.summary}`, event.original_span || event.original_text].filter(Boolean).join("\n"),
      event,
    });
  }

  for (const entity of event.entities || []) {
    units.push({
      id: `${id}:entity:${stableKey(entity)}`,
      owner_id: owner,
      target_type: "entity",
      target_id: id,
      fact_kind: "entity",
      embedding_text: [`entity: ${entity}`, `summary: ${event.summary}`, event.original_span || event.original_text].filter(Boolean).join("\n"),
      event,
    });
  }

  if (event.location) {
    units.push({
      id: `${id}:location:${stableKey(event.location)}`,
      owner_id: owner,
      target_type: "location",
      target_id: id,
      fact_kind: "location",
      embedding_text: [`location: ${event.location}`, `summary: ${event.summary}`, event.original_span || event.original_text].filter(Boolean).join("\n"),
      event,
    });
  }

  return units;
}

export async function upsertEmbeddingsForEvents(
  db: Database,
  events: MemoryEvent[],
  options: UpsertEmbeddingsOptions = {},
): Promise<UpsertEmbeddingsResult> {
  ensureEmbeddingSchema(db);
  const model = options.model || DEFAULT_EMBEDDING_MODEL;
  const baseUrl = options.baseUrl || DEFAULT_OLLAMA_BASE_URL;
  const batchSize = Math.max(1, Math.floor(options.batchSize || 32));
  const keepAlive = options.keepAlive ?? DEFAULT_EMBEDDING_KEEP_ALIVE;
  const numCtx = parsePositiveInt(options.numCtx, DEFAULT_EMBEDDING_NUM_CTX);
  const units = events.flatMap(buildEmbeddingUnits);
  const existing = new Set((db.prepare("SELECT id FROM memory_embeddings WHERE embedding_model = ?").all(model) as Array<{ id: string }>).map(row => row.id));
  const pending = options.reset ? units : units.filter(unit => !existing.has(unit.id));

  if (options.reset && pending.length > 0) {
    const ids = pending.map(unit => unit.id);
    const deleteBatch = db.transaction(() => {
      for (const id of ids) db.prepare("DELETE FROM memory_embeddings WHERE id = ? AND embedding_model = ?").run(id, model);
    });
    deleteBatch();
  }

  const upsert = db.prepare(`
    INSERT INTO memory_embeddings (
      id, owner_id, target_type, target_id, fact_kind, embedding_model, embedding_dim,
      embedding_text, embedding_json, embedding_blob, source_updated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      owner_id = excluded.owner_id,
      target_type = excluded.target_type,
      target_id = excluded.target_id,
      fact_kind = excluded.fact_kind,
      embedding_model = excluded.embedding_model,
      embedding_dim = excluded.embedding_dim,
      embedding_text = excluded.embedding_text,
      embedding_json = '',
      embedding_blob = excluded.embedding_blob,
      source_updated_at = excluded.source_updated_at,
      updated_at = datetime('now')
  `);

  let written = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const vectors = await embedTexts(batch.map(unit => unit.embedding_text), { model, baseUrl, batchSize, keepAlive, numCtx });
    const insertBatch = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const unit = batch[j]!;
        const vector = vectors[j]!;
        upsert.run(
          unit.id,
          unit.owner_id,
          unit.target_type,
          unit.target_id,
          unit.fact_kind || null,
          model,
          vector.length,
          unit.embedding_text,
          floatsToBlob(vector),
          unit.event.created_at || null,
        );
        written += 1;
      }
    });
    insertBatch();
  }

  return { units: units.length, pending: pending.length, written, model };
}

function buildEmbedRequestBody(input: {
  model: string;
  input: string | string[];
  keepAlive?: string | number;
  numCtx?: number;
}) {
  const body: Record<string, unknown> = {
    model: input.model,
    input: input.input,
  };
  if (input.keepAlive !== undefined) body.keep_alive = input.keepAlive;
  if (input.numCtx !== undefined) body.options = { num_ctx: input.numCtx };
  return body;
}

function parseKeepAlive(value: string | number | undefined, fallback: string | number): string | number | undefined {
  if (typeof value === "number") return value;
  const raw = value?.trim();
  if (!raw) return fallback;
  if (raw === "default" || raw === "disabled") return undefined;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : raw;
}

function parsePositiveInt(value: string | number | undefined, fallback: number | undefined): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readLoadedOllamaModel(
  baseUrl: string,
  model: string,
  timeoutMs: number,
): Promise<{ model?: string; name?: string; expires_at?: string; context_length?: number; size_vram?: number } | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchWithTimeout(`${baseUrl}/api/ps`, { method: "GET" }, timeoutMs);
    if (!res.ok) return undefined;
    const body = await res.json().catch(() => ({})) as {
      models?: Array<{ model?: string; name?: string; expires_at?: string; context_length?: number; size_vram?: number }>;
    };
    const loaded = body.models?.find(item => item.model === model || item.name === model);
    if (loaded || attempt === 2) return loaded;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return undefined;
}

function stableKey(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function loadEvents(db: Database, limit?: number): MemoryEvent[] {
  const sql = `
    SELECT * FROM memory_events
    WHERE COALESCE(NULLIF(user_id, ''), '') != ''
      AND COALESCE(NULLIF(summary, ''), NULLIF(original_text, '')) IS NOT NULL
    ORDER BY COALESCE(event_date, substr(event_time, 1, 10), substr(created_at, 1, 10), '') DESC, id
    ${typeof limit === "number" ? "LIMIT ?" : ""}
  `;
  const rows = typeof limit === "number"
    ? db.prepare(sql).all(limit)
    : db.prepare(sql).all();
  return (rows as Array<Record<string, unknown>>).map(rowToMemoryEvent);
}

export function eventById(db: Database, id: string): MemoryEvent | null {
  const row = db.prepare("SELECT * FROM memory_events WHERE id = ?").get(id) as Record<string, unknown> | null;
  return row ? rowToMemoryEvent(row) : null;
}
