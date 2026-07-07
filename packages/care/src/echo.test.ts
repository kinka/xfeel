import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 依赖注入而非 mock.module：bun 的模块 mock 是进程级的，会泄漏进其他测试文件。
const { getDB, closeDB } = await import("../../db/src/database");
const { initSchema } = await import("../../db/src/schema");
const { maybeCreateEchoCare } = await import("./echo");
const { listDeliverableCare } = await import("./care-queue");

let recallResult: unknown = null;
let recallShouldThrow = false;
let llmEcho: string | null = null;

const deps = {
  recall: async () => {
    if (recallShouldThrow) throw new Error("embedding down");
    return recallResult as never;
  },
  chatJSON: async () => {
    if (llmEcho == null) throw new Error("LLM unavailable in test");
    return { echo: llmEcho } as never;
  },
};

function newEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    summary: "星星又发烧了，38.9度，我很担心",
    original_text: "星星又发烧了，38.9度，我很担心",
    event_type: "health",
    entities: ["星星"],
    emotion: { primary: "担心", intensity: 0.7 },
    tags: [],
    ...overrides,
  } as never;
}

function oldHit(overrides: Record<string, unknown> = {}) {
  return {
    id: "old-evt-1",
    summary: "星星发烧39度，物理降温后第三天退烧",
    original_text: "星星发烧39度，物理降温后第三天退烧",
    event_type: "health",
    entities: ["星星"],
    emotion: { primary: "担心" },
    tags: [],
    event_date: "2026-01-10",
    ...overrides,
  };
}

function recallResultWith(event: Record<string, unknown>, similarity: number) {
  return {
    events: [event],
    total: 1,
    query: {},
    diagnostics: {
      query_expansion: { enabled: true, variant: "deterministic_v1", candidate_limit: 80, candidate_limit_mode: "auto", search_terms: [] },
      hybrid: {
        enabled: true, embedding_model: "m", embedding_threshold: 0.42, lexical_candidates: 0, embedding_candidates: 1,
        hits: [{ event_id: event.id, rank: 1, source: "embedding", score: similarity * 100, semantic_score: similarity }],
      },
    },
  };
}

describe("echo care", () => {
  let dbPath = "";
  const owner = "echo-owner";

  beforeEach(() => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-echo-${crypto.randomUUID()}.db`);
    initSchema(getDB(dbPath));
    recallResult = null;
    recallShouldThrow = false;
    llmEcho = null;
  });

  afterEach(() => {
    closeDB();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });

  test("creates an echo from a semantically similar old event", async () => {
    recallResult = recallResultWith(oldHit(), 0.72);
    llmEcho = "一月那会儿星星也烧到39度，三天就退了，别太慌。";
    const item = await maybeCreateEchoCare({ owner_id: owner, events: [newEvent()], date: "2026-07-05" }, deps);
    expect(item).not.toBeNull();
    expect(item!.kind).toBe("echo");
    expect(item!.content).toContain("一月");
    expect(item!.related_event_ids).toEqual(["old-evt-1"]);
    // 立即可投递
    expect(listDeliverableCare({ owner_id: owner })).toHaveLength(1);
  });

  test("falls back to deterministic template when LLM fails", async () => {
    recallResult = recallResultWith(oldHit(), 0.72);
    llmEcho = null; // LLM 抛错
    const item = await maybeCreateEchoCare({ owner_id: owner, events: [newEvent()], date: "2026-07-05" }, deps);
    expect(item).not.toBeNull();
    expect(item!.content).toContain("星星发烧39度");
  });

  test("skips when similarity is below threshold", async () => {
    recallResult = recallResultWith(oldHit(), 0.4);
    llmEcho = "不该被用到";
    const item = await maybeCreateEchoCare({ owner_id: owner, events: [newEvent()], date: "2026-07-05" }, deps);
    expect(item).toBeNull();
  });

  test("skips recent events (echo needs age)", async () => {
    recallResult = recallResultWith(oldHit({ event_date: "2026-07-03" }), 0.8);
    const item = await maybeCreateEchoCare({ owner_id: owner, events: [newEvent()], date: "2026-07-05" }, deps);
    expect(item).toBeNull();
  });

  test("skips when new or old event is sensitive", async () => {
    recallResult = recallResultWith(oldHit(), 0.8);
    llmEcho = "不该出现";
    const sensitiveNew = await maybeCreateEchoCare({
      owner_id: owner,
      events: [newEvent({ summary: "婆婆去世了，这几天在办后事", original_text: "婆婆去世了" })],
      date: "2026-07-05",
    }, deps);
    expect(sensitiveNew).toBeNull();

    recallResult = recallResultWith(oldHit({ summary: "上次流产后的复查", original_text: "上次流产后的复查" }), 0.8);
    const sensitiveOld = await maybeCreateEchoCare({ owner_id: owner, events: [newEvent()], date: "2026-07-05" }, deps);
    expect(sensitiveOld).toBeNull();
  });

  test("caps one echo per owner per day", async () => {
    recallResult = recallResultWith(oldHit(), 0.72);
    llmEcho = "回声句";
    const first = await maybeCreateEchoCare({ owner_id: owner, events: [newEvent()], date: "2026-07-05" }, deps);
    expect(first).not.toBeNull();
    const second = await maybeCreateEchoCare({ owner_id: owner, events: [newEvent()], date: "2026-07-05" }, deps);
    expect(second).toBeNull();
  });

  test("recall failure degrades to no echo, never throws", async () => {
    recallShouldThrow = true;
    const item = await maybeCreateEchoCare({ owner_id: owner, events: [newEvent()], date: "2026-07-05" }, deps);
    expect(item).toBeNull();
  });
});
