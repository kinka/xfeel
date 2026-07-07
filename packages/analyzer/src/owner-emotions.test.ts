import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { getDB, closeDB } = await import("../../db/src/database");
const { initSchema } = await import("../../db/src/schema");
const { getOwnerDailyMoods, getOwnerEmotionReview } = await import("./owner-emotions");

function insertEvent(ownerId: string, date: string, emotion: string) {
  getDB().prepare(`
    INSERT INTO memory_events (id, summary, original_text, event_type, emotion, user_id, event_date)
    VALUES (?, ?, ?, 'daily', ?, ?, ?)
  `).run(crypto.randomUUID(), `事件 ${emotion}`, "原文", JSON.stringify({ primary: emotion, intensity: 0.5 }), ownerId, date);
}

describe("owner emotions", () => {
  let dbPath = "";
  const owner = "emo-owner";

  beforeEach(() => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-emo-${crypto.randomUUID()}.db`);
    initSchema(getDB(dbPath));
  });

  afterEach(() => {
    closeDB();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });

  test("daily moods pick the dominant emotion per day with valence", () => {
    insertEvent(owner, "2026-07-01", "开心");
    insertEvent(owner, "2026-07-01", "开心");
    insertEvent(owner, "2026-07-01", "无奈");
    insertEvent(owner, "2026-07-02", "担心");
    insertEvent(owner, "2026-07-03", "矛盾");

    const moods = getOwnerDailyMoods(owner, "2026-07");
    const day1 = moods["2026-07-01"]!;
    expect(day1.emotion).toBe("开心"); // 主导情绪 = 最高频
    expect(day1.valence).toBe("positive");
    expect(day1.positive).toBe(2);
    expect(day1.negative).toBe(1); // 无奈
    expect(day1.total).toBe(3);
    expect(day1.top).toEqual(["开心", "无奈"]);
    expect(moods["2026-07-02"]!.valence).toBe("negative");
    expect(moods["2026-07-03"]!.valence).toBe("neutral"); // 矛盾等复合词归中性
  });

  test("daily moods are owner-scoped", () => {
    insertEvent(owner, "2026-07-01", "开心");
    insertEvent("someone-else", "2026-07-01", "愤怒");
    const moods = getOwnerDailyMoods(owner, "2026-07");
    expect(moods["2026-07-01"]!.emotion).toBe("开心");
    expect(getOwnerDailyMoods("no-such-owner", "2026-07")).toEqual({});
  });

  test("review aggregates totals, valence, top emotions and week buckets", () => {
    // today=2026-07-05，30 天窗口 = 06-06 ~ 07-05
    insertEvent(owner, "2026-07-05", "满足");
    insertEvent(owner, "2026-07-05", "满足");
    insertEvent(owner, "2026-07-04", "无奈");
    insertEvent(owner, "2026-06-20", "开心");
    insertEvent(owner, "2026-06-01", "崩溃"); // 窗口外，不计

    const review = getOwnerEmotionReview(owner, 30, "2026-07-05");
    expect(review.from).toBe("2026-06-06");
    expect(review.to).toBe("2026-07-05");
    expect(review.total).toBe(4);
    expect(review.valence.positive).toBe(3); // 满足×2 + 开心
    expect(review.valence.negative).toBe(1); // 无奈
    expect(review.top[0]).toEqual({ emotion: "满足", valence: "positive", count: 2 });

    // 最后一个桶是最近 7 天（06-29 ~ 07-05），装了满足×2 + 无奈
    const last = review.weeks[review.weeks.length - 1]!;
    expect(last.to).toBe("2026-07-05");
    expect(last.from).toBe("2026-06-29");
    expect(last.total).toBe(3);
    expect(last.positive).toBe(2);
    expect(last.negative).toBe(1);
    // 桶首尾覆盖整个窗口
    expect(review.weeks[0]!.from).toBe("2026-06-06");
  });

  test("review clamps days into [7, 90]", () => {
    expect(getOwnerEmotionReview(owner, 3, "2026-07-05").days).toBe(7);
    expect(getOwnerEmotionReview(owner, 365, "2026-07-05").days).toBe(90);
  });
});
