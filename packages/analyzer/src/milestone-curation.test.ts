import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { getDB, closeDB } = await import("../../db/src/database");
const { initSchema } = await import("../../db/src/schema");
const { getMilestones } = await import("./milestone-curation");

const owner = "ms-owner";

function insertEvent(input: { summary: string; type?: string; date?: string; version?: string }) {
  getDB().prepare(`
    INSERT INTO memory_events (id, summary, original_text, event_type, user_id, event_date, extractor_version)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), input.summary, input.summary, input.type || "milestone", owner, input.date || "2026-07-01", input.version || "extractor-v1");
}

describe("milestone curation", () => {
  let dbPath = "";

  beforeEach(() => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-ms-${crypto.randomUUID()}.db`);
    initSchema(getDB(dbPath));
  });

  afterEach(() => {
    closeDB();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });

  test("curates via LLM: filters negatives, dedupes same skill, keeps earliest", async () => {
    insertEvent({ summary: "阿星如厕训练成功", date: "2026-06-18" });
    insertEvent({ summary: "阿星如厕训练成功，主动尿尿三次", date: "2026-07-04" });
    insertEvent({ summary: "阿禾如厕训练尚未成功，直接尿地上", date: "2026-07-04" });
    const deps = {
      chatJSON: async (prompt: string) => {
        // 候选按时间序：0=6/18 达成，1=7/4 达成（重复），2=未达成
        expect(prompt).toContain("如厕训练");
        return { milestones: [{ i: 0, title: "阿星第一次自主如厕", person: "阿星" }] };
      },
    };
    const snapshot = await getMilestones(owner, {}, deps);
    expect(snapshot.curated).toBe(true);
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]!.title).toBe("阿星第一次自主如厕");
    expect(snapshot.items[0]!.date).toBe("2026-06-18");
  });

  test("reuses snapshot when candidates unchanged, rebuilds when they change", async () => {
    insertEvent({ summary: "星星第一次自己泡奶", date: "2026-07-01" });
    let calls = 0;
    const deps = {
      chatJSON: async () => {
        calls++;
        return { milestones: [{ i: 0, title: "星星第一次自己泡奶", person: "星星" }] };
      },
    };
    await getMilestones(owner, {}, deps);
    await getMilestones(owner, {}, deps); // 指纹未变：读快照
    expect(calls).toBe(1);

    insertEvent({ summary: "禾禾学会用杯子喝水", date: "2026-07-05" });
    const snapshot = await getMilestones(owner, {}, deps); // 候选变了：重建
    expect(calls).toBe(2);
    expect(snapshot.curated).toBe(true);
  });

  test("falls back to deterministic list when LLM fails", async () => {
    insertEvent({ summary: "阿禾第一次翻身", date: "2026-05-01" });
    insertEvent({ summary: "阿禾第一次翻身", date: "2026-05-03" }); // 双写漂移
    const deps = { chatJSON: async () => { throw new Error("LLM down"); } };
    const snapshot = await getMilestones(owner, {}, deps);
    expect(snapshot.curated).toBe(false);
    expect(snapshot.items).toHaveLength(1); // 确定性去重仍生效
    expect(snapshot.items[0]!.title).toContain("翻身");
  });

  test("legacy events only qualify via keyword, not type", async () => {
    insertEvent({ summary: "培训师说我的内容跟广发没啥关系", type: "milestone", version: "legacy", date: "2024-06-20" });
    insertEvent({ summary: "第一次全家骑车兜风", type: "other", version: "legacy", date: "2026-05-15" });
    const deps = { chatJSON: async () => { throw new Error("skip llm"); } };
    const snapshot = await getMilestones(owner, {}, deps);
    const titles = snapshot.items.map(item => item.title).join("|");
    expect(titles).toContain("骑车兜风");
    expect(titles).not.toContain("培训师");
  });

  test("empty candidates yield empty snapshot without LLM", async () => {
    const deps = { chatJSON: async () => { throw new Error("should not be called"); } };
    const snapshot = await getMilestones(owner, {}, deps);
    expect(snapshot.items).toHaveLength(0);
  });
});
