import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 依赖注入而非 mock.module：bun 的模块 mock 是进程级的，会泄漏进其他测试文件。
const { getDB, closeDB } = await import("../../db/src/database");
const { initSchema } = await import("../../db/src/schema");
const { detectCareThreads } = await import("./threads");
const { createCareItem, listDeliverableCare, getCareItem } = await import("./care-queue");

let llmResponse: unknown = null;
let llmShouldThrow = false;

const deps = {
  chatJSON: async () => {
    if (llmShouldThrow) throw new Error("LLM unavailable in test");
    return llmResponse;
  },
};

describe("care thread detection", () => {
  let dbPath = "";
  const owner = "thread-owner";
  const date = "2026-07-05";

  beforeEach(() => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-threads-${crypto.randomUUID()}.db`);
    initSchema(getDB(dbPath));
    llmResponse = null;
    llmShouldThrow = false;
  });

  afterEach(() => {
    closeDB();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });

  const turns = [
    { role: "user", content: "星星今天烧到38.5，喂了退烧药还是反复" },
    { role: "user", content: "下周三我要去新公司面试，有点紧张" },
    { role: "assistant", content: "辛苦了，退烧药隔4-6小时再看看" },
  ];

  test("creates concern and anticipation threads with proper trigger dates", async () => {
    llmResponse = {
      threads: [
        { type: "concern", topic: "星星发烧", question: "星星这两天退烧了吗？", sensitive: false },
        { type: "anticipation", topic: "新公司面试", target_date: "2026-07-08", question: "面试感觉怎么样？", sensitive: false },
      ],
      resolved_topics: [],
    };
    const result = await detectCareThreads({ owner_id: owner, date, turns }, deps);
    expect(result.created).toHaveLength(2);

    const concern = result.created.find(item => item.kind === "concern")!;
    expect(concern.trigger_after).toBe("2026-07-07"); // date + 2
    const anticipation = result.created.find(item => item.kind === "anticipation")!;
    expect(anticipation.trigger_after).toBe("2026-07-09"); // target_date + 1
    expect(anticipation.expires_at).toContain("2026-07-16");
  });

  test("drops sensitive threads (flagged or caught by guard)", async () => {
    llmResponse = {
      threads: [
        { type: "concern", topic: "外婆病危", question: "外婆怎么样了？", sensitive: true },
        { type: "concern", topic: "闹离婚", question: "和他谈得怎么样？", sensitive: false },
      ],
      resolved_topics: [],
    };
    // sensitive 标记的丢弃；"离婚"被护栏拦下 → 一条都不建
    const result = await detectCareThreads({ owner_id: owner, date, turns }, deps);
    expect(result.created).toHaveLength(0);
  });

  test("caps threads at two per day", async () => {
    llmResponse = {
      threads: [
        { type: "concern", topic: "失眠", question: "昨晚睡得好点了吗？", sensitive: false },
        { type: "concern", topic: "腰疼", question: "腰还疼吗？", sensitive: false },
        { type: "concern", topic: "咳嗽", question: "咳嗽好点了吗？", sensitive: false },
      ],
      resolved_topics: [],
    };
    const result = await detectCareThreads({ owner_id: owner, date, turns }, deps);
    expect(result.created).toHaveLength(2);
    expect(result.created.map(item => item.topic)).toEqual(["失眠", "腰疼"]);
  });

  test("closes threads the day's conversation already resolved", async () => {
    createCareItem({ owner_id: owner, kind: "concern", topic: "星星发烧", content: "退烧了吗？", trigger_after: "2026-07-01" });
    llmResponse = { threads: [], resolved_topics: ["星星发烧", "无关话题"] };
    const result = await detectCareThreads({ owner_id: owner, date, turns }, deps);
    expect(result.closed).toBe(1);
    expect(listDeliverableCare({ owner_id: owner })).toHaveLength(0);
  });

  test("LLM failure yields empty result without touching queue", async () => {
    llmShouldThrow = true;
    const existing = createCareItem({ owner_id: owner, kind: "concern", topic: "失眠", content: "睡得好点了吗", trigger_after: "2026-07-01" })!;
    const result = await detectCareThreads({ owner_id: owner, date, turns }, deps);
    expect(result.created).toHaveLength(0);
    expect(result.closed).toBe(0);
    expect(getCareItem(existing.id)?.status).toBe("pending");
  });

  test("no user turns short-circuits without LLM", async () => {
    llmShouldThrow = true; // 即使 LLM 会炸也不该被调用
    const result = await detectCareThreads({ owner_id: owner, date, turns: [{ role: "assistant", content: "你好" }] }, deps);
    expect(result.created).toHaveLength(0);
  });
});
