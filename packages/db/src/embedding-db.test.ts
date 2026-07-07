import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDB, closeEmbeddingDB, getDB, getEmbeddingDB } from "./database";
import { initSchema } from "./schema";
import { recall, recallHybrid } from "../../retrieval/src/recall";

const OWNER = "owner-embedding-db";

describe("embedding vector DB", () => {
  const originalVecPath = process.env.XFEEL_VEC_DB_PATH;

  beforeEach(() => {
    closeEmbeddingDB();
    closeDB();
    delete process.env.XFEEL_VEC_DB_PATH;
  });

  afterEach(() => {
    closeEmbeddingDB();
    closeDB();
    if (originalVecPath === undefined) delete process.env.XFEEL_VEC_DB_PATH;
    else process.env.XFEEL_VEC_DB_PATH = originalVecPath;
  });

  test("main initSchema does not create memory_embeddings", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_embeddings'").get();
      expect(Boolean(table)).toBe(false);
    } finally {
      db.close();
    }
  });

  test("getEmbeddingDB creates schema, reuses singleton, and close resets it", () => {
    const first = getEmbeddingDB(":memory:");
    expect(first.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_embeddings'").get()).toBeTruthy();
    const indexes = first.prepare("PRAGMA index_list(memory_embeddings)").all() as Array<{ name: string }>;
    expect(indexes.map(index => index.name)).toContain("idx_memory_embeddings_fact_kind");

    expect(getEmbeddingDB(":memory:")).toBe(first);
    closeEmbeddingDB();

    const second = getEmbeddingDB(":memory:");
    expect(second).not.toBe(first);
  });

  test("stores Float32 blobs and reads them back with blob priority", async () => {
    const { floatsToBlob, readEmbeddingVector } = await loadActualEmbeddingCommon();
    const db = getEmbeddingDB(":memory:");
    const vector = [0.125, -0.25, 0.5];
    db.prepare(`
      INSERT INTO memory_embeddings (
        id, owner_id, target_type, target_id, fact_kind, embedding_model,
        embedding_dim, embedding_text, embedding_json, embedding_blob
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?)
    `).run("event-1:event", OWNER, "event", "event-1", "daily", "test-model", vector.length, "hello", floatsToBlob(vector));

    const row = db.prepare("SELECT embedding_json, embedding_blob FROM memory_embeddings WHERE id = ?")
      .get("event-1:event") as { embedding_json: string; embedding_blob: Uint8Array };
    expect(row.embedding_json).toBe("");
    const back = readEmbeddingVector(row);
    expect(back).toHaveLength(vector.length);
    expect(back[0]!).toBeCloseTo(vector[0]!, 6);
  });

  test("upsertEmbeddingsForEvents writes blob and empty legacy json", async () => {
    const { readEmbeddingVector, upsertEmbeddingsForEvents } = await loadActualEmbeddingCommon();
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ embeddings: [[0.125, -0.25, 0.5]] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const db = getEmbeddingDB(":memory:");
      const result = await upsertEmbeddingsForEvents(db, [{
        id: "upsert-event",
        summary: "upsert summary",
        original_text: "upsert original",
        event_type: "daily",
        entities: [],
        emotion: { primary: "平静", valence: "neutral", intensity: 0.3 },
        tags: [],
        open_facts: [],
        user_id: OWNER,
        confidence: 1,
        source: "user",
        source_layer: "extracted",
        created_at: "2026-06-18T08:00:00.000Z",
      }], {
        model: "test-model",
        baseUrl: "http://embedding.test",
        batchSize: 1,
        keepAlive: "24h",
        numCtx: 512,
      });

      expect(result.written).toBe(1);
      expect(requests[0]).toMatchObject({
        model: "test-model",
        keep_alive: "24h",
        options: { num_ctx: 512 },
      });
      const row = db.prepare(`
        SELECT embedding_json, embedding_blob
        FROM memory_embeddings
        WHERE id = ?
      `).get("upsert-event:event") as { embedding_json: string; embedding_blob: Uint8Array };
      expect(row.embedding_json).toBe("");
      expect(row.embedding_blob.byteLength).toBe(12);
      expect(readEmbeddingVector(row)[1]!).toBeCloseTo(-0.25, 6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("warmOllamaEmbedding validates and keeps the embedding model loaded", async () => {
    const { warmOllamaEmbedding } = await loadActualEmbeddingCommon();
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
      });
      if (url.endsWith("/api/version")) {
        return new Response(JSON.stringify({ version: "0.30.7" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/embed")) {
        return new Response(JSON.stringify({ embeddings: [[0.125, -0.25, 0.5]] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/ps")) {
        return new Response(JSON.stringify({
          models: [{
            model: "test-model",
            expires_at: "2318-09-30T16:11:04+08:00",
            context_length: 512,
            size_vram: 123456,
          }],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const result = await warmOllamaEmbedding({
        model: "test-model",
        baseUrl: "http://embedding.test",
        keepAlive: -1,
        numCtx: 512,
        timeoutMs: 1_000,
      });

      expect(result).toMatchObject({
        ok: true,
        model: "test-model",
        version: "0.30.7",
        dimension: 3,
        loaded: true,
        contextLength: 512,
        sizeVram: 123456,
      });
      expect(requests.map(request => request.url)).toEqual([
        "http://embedding.test/api/version",
        "http://embedding.test/api/embed",
        "http://embedding.test/api/ps",
      ]);
      expect(requests[1]?.body).toMatchObject({
        model: "test-model",
        keep_alive: -1,
        options: { num_ctx: 512 },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("recallHybrid falls back to lexical when vec db cannot be opened", async () => {
    const root = join(tmpdir(), `xfeel-embedding-db-${crypto.randomUUID()}`);
    const dbPath = join(root, "main.db");
    const badVecPath = join(root, "vec-dir");
    mkdirSync(badVecPath, { recursive: true });
    process.env.XFEEL_VEC_DB_PATH = badVecPath;

    try {
      const db = getDB(dbPath);
      initSchema(db);
      seedEvent("lexical-hit");

      const lexical = recall({ owner_id: OWNER, text: "unique lexical token", limit: 5 });
      const hybrid = await recallHybrid({
        owner_id: OWNER,
        text: "unique lexical token",
        limit: 5,
      }, {
        embeddingBaseUrl: "http://127.0.0.1:9",
      });

      expect(hybrid.events.map(event => event.id)).toEqual(lexical.events.map(event => event.id));
      expect(hybrid.total).toBe(lexical.total);
    } finally {
      closeEmbeddingDB();
      closeDB();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function seedEvent(id: string) {
  getDB().prepare(`
    INSERT INTO memory_events (
      id, summary, original_text, event_type, entities, emotion, tags,
      canonical_search_text, event_time, user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    "unique lexical token summary",
    "unique lexical token original",
    "daily",
    JSON.stringify(["爸爸"]),
    JSON.stringify({ primary: "平静", valence: "neutral", intensity: 0.3 }),
    JSON.stringify(["token"]),
    "unique lexical token",
    "2026-06-18T08:00:00.000Z",
    OWNER,
  );
}

async function loadActualEmbeddingCommon() {
  return await import(`../../../scripts/embedding-common.ts?actual=${crypto.randomUUID()}`) as typeof import("../../../scripts/embedding-common");
}
