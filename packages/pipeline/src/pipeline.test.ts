import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MemoryEvent } from "../../domain/src/memory-event";

mock.module("../../ai-client/src/llm", () => ({
  getLLM() {
    return {
      async chatJSON() {
        throw new Error("LLM unavailable in test");
      },
    };
  },
}));

mock.module("../../../scripts/embedding-common", () => ({
  DEFAULT_EMBEDDING_MODEL: "test-embedding",
  DEFAULT_OLLAMA_BASE_URL: "http://127.0.0.1:9",
  cosine() {
    return 0;
  },
  async embedTexts() {
    return [];
  },
  readEmbeddingVector() {
    return [];
  },
  async upsertEmbeddingsForEvents(_db: unknown, events: MemoryEvent[]) {
    return { units: events.length, pending: events.length, written: events.length, model: "test-embedding" };
  },
}));

const { getDB, closeDB, closeEmbeddingDB } = await import("../../db/src/database");
const { initSchema } = await import("../../db/src/schema");
const { EXTRACTOR_VERSION, SEARCH_TEXT_VERSION, VOCAB_VERSION } = await import("../../domain/src/provenance");
const { processMessage } = await import("./pipeline");
const { recall } = await import("../../retrieval/src/recall");
const { buildAliasContext } = await import("../../domain/src/family");

// 家庭词典 fixture：具体家人名不再内置在产品代码里，规则兜底靠 aliasContext
const FIXTURE_ALIAS_CONTEXT = buildAliasContext({
  familyId: "fam-fixture",
  childLabels: ["星星", "禾禾"],
  aliases: [
    { alias: "星星", memberId: "child-star", label: "星星", scope: "global" },
    { alias: "阿星", memberId: "child-star", label: "星星", scope: "global" },
    { alias: "禾禾", memberId: "child-he", label: "禾禾", scope: "global" },
    { alias: "爸爸", memberId: "demo-dad-owner", label: "爸爸", scope: "global" },
    { alias: "妈妈", memberId: "demo-mom-owner", label: "妈妈", scope: "global" },
  ],
});

describe("memory pipeline", () => {
  let dbPath = "";
  let vecDbPath = "";
  const originalVecPath = process.env.XFEEL_VEC_DB_PATH;

  beforeEach(() => {
    closeEmbeddingDB();
    closeDB();
    dbPath = join(tmpdir(), `xfeel-pipeline-${crypto.randomUUID()}.db`);
    vecDbPath = join(tmpdir(), `xfeel-pipeline-${crypto.randomUUID()}.vec.db`);
    process.env.XFEEL_VEC_DB_PATH = vecDbPath;
    const db = getDB(dbPath);
    initSchema(db);
  });

  afterEach(() => {
    closeEmbeddingDB();
    closeDB();
    if (originalVecPath === undefined) delete process.env.XFEEL_VEC_DB_PATH;
    else process.env.XFEEL_VEC_DB_PATH = originalVecPath;
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(vecDbPath, { force: true });
    rmSync(`${vecDbPath}-shm`, { force: true });
    rmSync(`${vecDbPath}-wal`, { force: true });
  });

  test("propagates owner id through fallback extraction and recall", async () => {
    const dadId = "demo-dad-owner";
    const result = await processMessage("我昨晚累坏了，星星夜醒三次。", { ownerId: dadId, aliasContext: FIXTURE_ALIAS_CONTEXT });

    expect(result.skipped).toBe(false);
    expect(result.events).toHaveLength(1);

    const event = result.events[0]!;
    expect(event.user_id).toBe(dadId);
    expect(event.entities).toContain("爸爸");
    expect(event.entities).toContain("星星");
    expect(event.tags).toContain("夜醒");
    expect(event.event_type).toBe("sleep");

    expect(result.embedding?.written).toBeGreaterThan(0);
    expect(result.embedding?.model).toBe("test-embedding");

    expect(recall({ owner_id: dadId }).total).toBe(1);
    expect(recall({ user_id: dadId }).total).toBe(1);
    expect(recall({ entities: ["我"], owner_id: dadId }).total).toBe(1);
  });

  test("uses owner context when rule fallback sees first-person text", async () => {
    const momId = "demo-mom-owner";
    const result = await processMessage("我今天工作压力特别大，加班到很晚。", { ownerId: momId });

    expect(result.skipped).toBe(false);
    expect(result.events).toHaveLength(1);

    const event = result.events[0]!;
    expect(event.user_id).toBe(momId);
    expect(event.entities).toContain("妈妈");
    expect(event.tags).toContain("工作压力");
    expect(event.emotion.primary).toBe("压力");
    expect(event.event_type).toBe("work");
  });

  test("reprocesses a fixed raw message without duplicating memory_events or FTS rows", async () => {
    const dadId = "demo-dad-owner";
    const messageId = "raw-idempotent-message";

    const first = await processMessage("昨晚星星夜醒三次，我累坏了。", { ownerId: dadId, messageId });
    const second = await processMessage("昨晚星星夜醒三次，我累坏了。", { ownerId: dadId, messageId });

    expect(first.events.map(event => event.id)).toEqual(second.events.map(event => event.id));
    expect(first.events[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    expect(countRows("memory_events")).toBe(1);
    expect(countRows("memory_events_fts")).toBe(1);

    const row = getDB().prepare(`
      SELECT raw_message_id, user_id, event_index, original_span, event_date, extractor_version, vocab_version, search_text_version
      FROM memory_events
      WHERE raw_message_id = ?
    `).get(messageId) as {
      raw_message_id: string;
      user_id: string;
      event_index: number;
      original_span: string;
      event_date: string;
      extractor_version: string;
      vocab_version: string;
      search_text_version: string;
    };

    expect(row.raw_message_id).toBe(messageId);
    expect(row.user_id).toBe(dadId);
    expect(row.event_index).toBe(0);
    expect(row.original_span).toContain("星星夜醒三次");
    expect(row.event_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.extractor_version).toBe(EXTRACTOR_VERSION);
    expect(row.vocab_version).toBe(VOCAB_VERSION);
    expect(row.search_text_version).toBe(SEARCH_TEXT_VERSION);
  });

  test("populates event_date from message-level fallback when event_time is absent", async () => {
    const dadId = "demo-dad-owner";
    const messageId = "raw-event-date-fallback";

    await processMessage("星星最近特别开心，看到爸爸就笑得很大声。", {
      ownerId: dadId,
      messageId,
      eventDate: "2026-06-01",
    });

    const row = getDB().prepare("SELECT event_time, event_date FROM memory_events WHERE raw_message_id = ?")
      .get(messageId) as { event_time: string | null; event_date: string };

    expect(row.event_time).toBeNull();
    expect(row.event_date).toBe("2026-06-01");
  });

  test("stores events even when embedding db write is unavailable", async () => {
    const badVecPath = join(tmpdir(), `xfeel-pipeline-vec-dir-${crypto.randomUUID()}`);
    mkdirSync(badVecPath, { recursive: true });
    process.env.XFEEL_VEC_DB_PATH = badVecPath;
    closeEmbeddingDB();

    try {
      const result = await processMessage("今天星星走了三步，爸爸特别开心。", {
        ownerId: "demo-dad-owner",
        messageId: "raw-embedding-db-unavailable",
      });

      expect(result.stored).toBeGreaterThan(0);
      expect(result.embedding).toBeUndefined();
      expect(countEventsByRawMessage("raw-embedding-db-unavailable")).toBeGreaterThan(0);
    } finally {
      closeEmbeddingDB();
      process.env.XFEEL_VEC_DB_PATH = vecDbPath;
      rmSync(badVecPath, { recursive: true, force: true });
    }
  });

  test("reprocess preserves causal_chains that reference stable event ids", async () => {
    const dadId = "demo-dad-owner";
    const messageId = "raw-causal-reprocess";

    const first = await processMessage("昨晚星星夜醒三次，我累坏了。", { ownerId: dadId, messageId });
    const causeId = first.events[0]?.id;
    if (!causeId) throw new Error("expected processMessage to return an event id");
    insertMemoryEvent("external-effect", dadId);
    getDB().prepare(`
      INSERT INTO causal_chains (id, cause_event_id, effect_event_id, relation_type, strength, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("chain-stable", causeId!, "external-effect", "triggers", 0.8, "stable chain");

    const second = await processMessage("昨晚星星夜醒三次，我累坏了。", { ownerId: dadId, messageId });
    expect(second.events[0]?.id).toBe(causeId);

    const chain = getDB().prepare("SELECT cause_event_id, effect_event_id FROM causal_chains WHERE id = ?")
      .get("chain-stable") as { cause_event_id: string; effect_event_id: string } | undefined;
    expect(chain).toEqual({ cause_event_id: causeId, effect_event_id: "external-effect" });
    expect(countRows("memory_events")).toBe(2);
  });

  test("processMessage preserves structured events and causal_chains sharing the raw message", async () => {
    const dadId = "demo-dad-owner";
    const messageId = "raw-shared-structured";
    const structuredId = "external:structured:activity-1";

    insertMemoryEvent(structuredId, dadId, {
      rawMessageId: messageId,
      source: "external:structured",
      sourceLayer: "structured",
      summary: "星星练习爬行",
    });
    insertMemoryEvent("external-effect", dadId);
    insertCausalChain("chain-structured", structuredId, "external-effect");

    await processMessage("星星今天状态很好，看到爸爸就笑。", {
      ownerId: dadId,
      messageId,
      force: true,
      extractEvents: async text => [extractedEvent(text, 0, "星星状态很好")],
    });

    const structured = getDB().prepare("SELECT source, source_layer FROM memory_events WHERE id = ?")
      .get(structuredId) as { source: string; source_layer: string } | undefined;
    expect(structured).toEqual({ source: "external:structured", source_layer: "structured" });

    const chain = getDB().prepare("SELECT cause_event_id, effect_event_id FROM causal_chains WHERE id = ?")
      .get("chain-structured") as { cause_event_id: string; effect_event_id: string } | undefined;
    expect(chain).toEqual({ cause_event_id: structuredId, effect_event_id: "external-effect" });
  });

  test("reprocess removes stale extracted events when extraction count shrinks", async () => {
    const dadId = "demo-dad-owner";
    const messageId = "raw-shrinks";
    let extractedCount = 2;
    const extractEvents = async (text: string): Promise<MemoryEvent[]> =>
      Array.from({ length: extractedCount }, (_, index) => extractedEvent(text, index, `星星状态事件 ${index + 1}`));

    const first = await processMessage("星星今天状态很好，看到爸爸就笑。", {
      ownerId: dadId,
      messageId,
      force: true,
      extractEvents,
    });
    const staleId = first.events[1]?.id;
    if (!staleId) throw new Error("expected second extracted event id");
    insertMemoryEvent("external-effect", dadId);
    insertCausalChain("chain-stale", staleId, "external-effect");

    extractedCount = 1;
    const second = await processMessage("星星今天状态很好，看到爸爸就笑。", {
      ownerId: dadId,
      messageId,
      force: true,
      extractEvents,
    });

    expect(second.events).toHaveLength(1);
    expect(countEventsByRawMessage(messageId)).toBe(1);
    expect(hasMemoryEvent(staleId)).toBe(false);
    expect(hasCausalChain("chain-stale")).toBe(false);
  });

  test("normalizes extractor user_id to process owner on reprocess", async () => {
    const dadId = "demo-dad-owner";
    const momId = "demo-mom-owner";
    const messageId = "raw-owner-mismatch";

    const extractEvents = async (text: string) => [{
      id: crypto.randomUUID(),
      summary: "星星状态很好",
      original_text: text,
      original_span: text,
      event_type: "daily" as const,
      entities: ["星星"],
      emotion: { primary: "开心" as const, intensity: 0.6, valence: "positive" as const },
      tags: ["亲子互动"],
      confidence: 0.9,
      source: "user" as const,
      source_layer: "extracted" as const,
      user_id: momId,
      created_at: "2026-06-01T00:00:00.000Z",
    }];

    const first = await processMessage("星星今天状态很好，看到爸爸就笑。", { ownerId: dadId, messageId, extractEvents });
    const second = await processMessage("星星今天状态很好，看到爸爸就笑。", { ownerId: dadId, messageId, extractEvents });
    const firstEventId = first.events[0]?.id;
    if (!firstEventId) throw new Error("expected processMessage to return an event id");

    expect(second.events.map(event => event.id)).toEqual(first.events.map(event => event.id));
    expect(countEventsByRawMessage(messageId)).toBe(1);
    const row = getDB().prepare("SELECT id, user_id FROM memory_events WHERE raw_message_id = ?")
      .get(messageId) as { id: string; user_id: string };
    expect(row.id).toBe(firstEventId);
    expect(row.user_id).toBe(dadId);
  });
});

function countRows(table: "memory_events" | "memory_events_fts"): number {
  return (getDB().prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number }).count;
}

function countEventsByRawMessage(rawMessageId: string): number {
  return (getDB().prepare("SELECT COUNT(*) as count FROM memory_events WHERE raw_message_id = ?")
    .get(rawMessageId) as { count: number }).count;
}

function hasMemoryEvent(id: string): boolean {
  return Boolean(getDB().prepare("SELECT id FROM memory_events WHERE id = ?").get(id));
}

function hasCausalChain(id: string): boolean {
  return Boolean(getDB().prepare("SELECT id FROM causal_chains WHERE id = ?").get(id));
}

function insertCausalChain(id: string, causeId: string, effectId: string) {
  getDB().prepare(`
    INSERT INTO causal_chains (id, cause_event_id, effect_event_id, relation_type, strength, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, causeId, effectId, "triggers", 0.8, id);
}

function extractedEvent(text: string, eventIndex: number, summary: string): MemoryEvent {
  return {
    summary,
    original_text: text,
    original_span: text,
    event_index: eventIndex,
    event_type: "daily",
    entities: ["星星"],
    emotion: { primary: "开心", intensity: 0.6, valence: "positive" },
    tags: ["亲子互动"],
    confidence: 0.9,
    source: "user",
    source_layer: "extracted",
    created_at: "2026-06-01T00:00:00.000Z",
  };
}

function insertMemoryEvent(id: string, userId: string, options: {
  rawMessageId?: string;
  source?: string;
  sourceLayer?: string;
  summary?: string;
} = {}) {
  getDB().prepare(`
    INSERT INTO memory_events (
      id,
      raw_message_id,
      summary,
      original_text,
      event_type,
      entities,
      emotion,
      tags,
      canonical_search_text,
      event_time,
      source,
      source_layer,
      user_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    options.rawMessageId || null,
    options.summary || "外部事件",
    options.summary || "外部事件",
    "daily",
    JSON.stringify(["星星"]),
    JSON.stringify({ primary: "平静", valence: "neutral", intensity: 0.2 }),
    JSON.stringify([]),
    options.summary || "外部事件",
    "2026-06-02T00:00:00.000Z",
    options.source || "user",
    options.sourceLayer || "extracted",
    userId,
  );
}
