import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// LLM 不可用 → resolveRecallIntent 走规则兜底，测试保持确定性。
mock.module("../../ai-client/src/llm", () => ({
  getLLM() {
    return {
      async chat() { throw new Error("LLM unavailable in test"); },
      async chatJSON() { throw new Error("LLM unavailable in test"); },
    };
  },
}));

const { getDB, closeDB } = await import("../../db/src/database");
const { initSchema } = await import("../../db/src/schema");
const { recallByIntent, ruleBasedRecallIntent } = await import("./recall-intent");

const DAD = "demo-dad-owner";

function seedPressure(id: string, date: string, primary = "压力") {
  getDB().prepare(`
    INSERT INTO memory_events (id, raw_message_id, summary, original_text, event_type, entities, emotion, tags, event_date, event_time, user_id)
    VALUES (?, ?, ?, ?, 'emotion', ?, ?, '[]', ?, ?, ?)
  `).run(
    id, `${id}-msg`, `${date} 我感到${primary}`, `${date} 我感到${primary}`,
    JSON.stringify(["爸爸"]), JSON.stringify({ primary, intensity: 0.8, valence: "negative" }),
    date, `${date}T12:00:00.000Z`, DAD,
  );
}

describe("ruleBasedRecallIntent", () => {
  test("识别情绪+时间方向", () => {
    const a = ruleBasedRecallIntent("爸爸上次压力大是什么时候");
    expect(a.isMemoryQuery).toBe(true);
    expect(a.emotions).toContain("压力");
    expect(a.entities).toContain("爸爸");
    expect(a.direction).toBe("latest");

    const b = ruleBasedRecallIntent("爸爸最早什么时候压力大");
    expect(b.direction).toBe("earliest");
  });

  test("省略句从上一轮继承话题并取锚点日期", () => {
    const intent = ruleBasedRecallIntent("更早之前呢", "用户: 爸爸上次压力大是什么时候\n助手: 上次压力大是在 2026-05-27，强度 0.84。");
    expect(intent.isMemoryQuery).toBe(true);
    expect(intent.emotions).toContain("压力"); // 从上下文继承
    expect(intent.direction).toBe("earlier");
    expect(intent.anchorDate).toBe("2026-05-27");
  });
});

describe("recallByIntent (结构化检索)", () => {
  let dbPath = "";
  beforeEach(() => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-recall-intent-${crypto.randomUUID()}.db`);
    initSchema(getDB(dbPath));
    for (const [id, date] of [
      ["p-2024", "2024-06-17"], ["p-2025", "2025-01-12"],
      ["p-0504", "2026-05-04"], ["p-0527", "2026-05-27"],
    ] as const) seedPressure(id, date);
  });
  afterEach(() => {
    closeDB();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });

  test("“上次压力大”取最近一条", async () => {
    const items = await recallByIntent({ text: "爸爸上次压力大是什么时候", owner_id: DAD, limit: 3 });
    expect(items).not.toBeNull();
    expect(items![0]!.id).toBe("p-0527");
  });

  test("“更早之前呢”锚定 2026-05-27 后取更早的压力记录", async () => {
    const items = await recallByIntent({
      text: "更早之前呢",
      owner_id: DAD,
      recentDialogue: "用户: 爸爸上次压力大是什么时候\n助手: 上次压力大是在 2026-05-27。",
      limit: 5,
    });
    expect(items).not.toBeNull();
    const ids = items!.map(i => i.id);
    expect(ids).not.toContain("p-0527"); // 锚点当天及之后被排除
    expect(ids).toContain("p-0504");
    expect(ids).toContain("p-2025");
    expect(ids).toContain("p-2024"); // 更早的历史确实能召回到
  });

  test("“最早什么时候压力大”取最早一条", async () => {
    const items = await recallByIntent({ text: "爸爸最早什么时候压力大", owner_id: DAD, limit: 3 });
    expect(items![0]!.id).toBe("p-2024");
  });

  test("非记忆提问返回 null（交给模糊召回）", async () => {
    const items = await recallByIntent({ text: "今天天气不错啊", owner_id: DAD });
    expect(items).toBeNull();
  });
});
