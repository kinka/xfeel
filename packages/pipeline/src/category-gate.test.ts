import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MemoryEvent } from "../../domain/src/memory-event";

// 受控 combined 抽取：分类器对「对话延续」短句返回 is_meaningful=true 但 category=chat
// （模拟模型偶发的误判 meaningful），并仍吐出一个事件——验证 pipeline 的类别闸门会拦下它。
function buildEvent(summary: string): Record<string, unknown> {
  return {
    summary,
    original_span: summary,
    event_type: "emotion",
    entities: ["爸爸"],
    emotion: { primary: "崩溃", intensity: 0.8, valence: "negative" },
    tags: [],
    open_facts: [],
    event_time: null,
    confidence: 0.8,
  };
}

mock.module("../../ai-client/src/llm", () => ({
  getLLM() {
    return {
      async chatJSON(prompt: string) {
        if (prompt.includes("溜到地上")) {
          // 闲聊延续：模型误标 meaningful，但 category=chat。
          return { classification: { is_meaningful: true, category: "chat", reason: "continuation reply" }, events: [buildEvent("某人/物溜到地上")] };
        }
        // 真日记。
        return { classification: { is_meaningful: true, category: "diary", reason: "records an event" }, events: [buildEvent("阿星今天发烧了")] };
      },
    };
  },
}));

mock.module("../../../scripts/embedding-common", () => ({
  DEFAULT_EMBEDDING_MODEL: "test-embedding",
  DEFAULT_OLLAMA_BASE_URL: "http://127.0.0.1:9",
  cosine() { return 0; },
  async embedTexts() { return []; },
  readEmbeddingVector() { return []; },
  async upsertEmbeddingsForEvents(_db: unknown, events: MemoryEvent[]) {
    return { units: events.length, pending: events.length, written: events.length, model: "test-embedding" };
  },
}));

const { getDB, closeDB, closeEmbeddingDB } = await import("../../db/src/database");
const { initSchema } = await import("../../db/src/schema");
const { processMessage } = await import("./pipeline");

const DAD = "demo-dad-owner";

describe("pipeline category gate", () => {
  let dbPath = "";
  let vecDbPath = "";
  const originalVecPath = process.env.XFEEL_VEC_DB_PATH;

  beforeEach(() => {
    closeEmbeddingDB();
    closeDB();
    dbPath = join(tmpdir(), `xfeel-cat-gate-${crypto.randomUUID()}.db`);
    vecDbPath = join(tmpdir(), `xfeel-cat-gate-${crypto.randomUUID()}.vec.db`);
    process.env.XFEEL_VEC_DB_PATH = vecDbPath;
    initSchema(getDB(dbPath));
  });

  afterEach(() => {
    closeEmbeddingDB();
    closeDB();
    if (originalVecPath === undefined) delete process.env.XFEEL_VEC_DB_PATH;
    else process.env.XFEEL_VEC_DB_PATH = originalVecPath;
    for (const p of [dbPath, vecDbPath]) {
      rmSync(p, { force: true });
      rmSync(`${p}-shm`, { force: true });
      rmSync(`${p}-wal`, { force: true });
    }
  });

  test("continuation reply tagged category=chat is not stored even if meaningful slipped true", async () => {
    const result = await processMessage("溜到地上", { ownerId: DAD, combinedExtract: true, embedNewEvents: false });

    expect(result.skipped).toBe(true);
    expect(result.stored).toBe(0);
    expect(result.events).toHaveLength(0);
    expect(result.category).toBe("chat");
  });

  test("a genuine diary message still stores its events", async () => {
    const result = await processMessage("阿星今天发烧了", { ownerId: DAD, combinedExtract: true, embedNewEvents: false });

    expect(result.skipped).toBe(false);
    expect(result.stored).toBe(1);
    expect(result.category).toBe("diary");
  });

  test("explicit force bypasses the category gate (manual log always records)", async () => {
    const result = await processMessage("溜到地上", { ownerId: DAD, combinedExtract: true, embedNewEvents: false, force: true });

    expect(result.skipped).toBe(false);
    expect(result.stored).toBe(1);
  });
});
