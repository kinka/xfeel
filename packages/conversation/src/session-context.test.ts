import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { closeDB, getDB } = await import("../../db/src/database");
const { initSchema } = await import("../../db/src/schema");
const { recordConversationTurn } = await import("./conversation");
const { loadAmbientContext, loadSessionContext, summarizeRecentTurns, writeRollingWeeklyContext } = await import("./session-context");

describe("session context", () => {
  let dbPath = "";

  beforeEach(() => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-session-context-${crypto.randomUUID()}.db`);
    const db = getDB(dbPath);
    initSchema(db);
  });

  afterEach(() => {
    closeDB();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });

  test("keeps recent turns scoped to the requested owner", () => {
    recordConversationTurn({
      content: "爸爸这边刚聊到星星走路。",
      owner_id: "dad-owner",
      turn_date: "2026-06-18",
      role: "user",
    });
    recordConversationTurn({
      content: "妈妈这边刚聊到私密安排。",
      owner_id: "mom-owner",
      turn_date: "2026-06-18",
      role: "user",
    });

    const ctx = loadSessionContext({ owner_id: "dad-owner", date: "2026-06-18", maxTurns: 10 });
    const summary = summarizeRecentTurns(ctx) || "";

    expect(ctx.recentTurns.map(turn => turn.content)).toEqual(["爸爸这边刚聊到星星走路。"]);
    expect(summary).toContain("星星走路");
    expect(summary).not.toContain("私密安排");
  });

  test("returns empty context instead of cross-owner turns when owner is missing", () => {
    recordConversationTurn({
      content: "不应该被无 owner 的 recap 看到。",
      owner_id: "dad-owner",
      turn_date: "2026-06-18",
      role: "user",
    });

    const ctx = loadSessionContext({ date: "2026-06-18", maxTurns: 10 });

    expect(ctx.hasRecent).toBe(false);
    expect(ctx.recentTurns).toEqual([]);
    expect(summarizeRecentTurns(ctx)).toBeNull();
  });

  test("ambient context accumulates same-day conversation turns", () => {
    recordConversationTurn({ content: "hello", owner_id: "dad-owner", turn_date: "2026-06-18", role: "user" });
    recordConversationTurn({ content: "hello，我在。", owner_id: "dad-owner", turn_date: "2026-06-18", role: "assistant" });
    recordConversationTurn({ content: "结果呢？", owner_id: "dad-owner", turn_date: "2026-06-18", role: "user" });

    const ambient = loadAmbientContext({ owner_id: "dad-owner", date: "2026-06-18" });

    expect(ambient.text).toContain("今日持续对话");
    expect(ambient.text).toContain("hello");
    expect(ambient.text).toContain("结果呢");
  });

  test("writes fixed-location rolling weekly context from daily archives", () => {
    const db = getDB();
    db.prepare(`
      INSERT INTO daily_archives (id, owner_id, archive_date, summary, source_turn_ids, event_ids, status)
      VALUES (?, ?, ?, ?, '[]', '[]', 'done')
    `).run("archive-1", "dad-owner", "2026-06-17", "昨天聊到接娃和星星跑来找爸爸。礼貌点说：没有 token。非礼貌：别泄露 token。" );

    const result = writeRollingWeeklyContext({ owner_id: "dad-owner", date: "2026-06-18" });
    const ambient = loadAmbientContext({ owner_id: "dad-owner", date: "2026-06-18" });

    expect(result.path).toContain("data/context/rolling-7d-dad-owner.md");
    expect(result.text).toContain("近7天日终摘要");
    expect(result.text).toContain("接娃");
    expect(ambient.weeklyContextPath).toBe(result.path);
    expect(ambient.text).toContain("rolling 7-day context");
  });

  test("oversized rolling weekly context is truncated, not dropped entirely", () => {
    // 回归：clampSections 曾经在第一段单独就超 maxChars 时直接 break，导致 ambient.text
    // 整体变成空字符串——当天注入回复的近期上下文（周报+今日对话+开放事实）全部消失。
    recordConversationTurn({ content: "今天怎么样", owner_id: "dad-owner", turn_date: "2026-06-18", role: "user" });
    writeRollingWeeklyContext({ owner_id: "dad-owner", date: "2026-06-18", maxChars: 6000 }); // 先写一份足够长的周报文件
    const longSummary = "很长的一段".repeat(500); // 远超默认 maxChars=1800
    const db = getDB();
    db.prepare(`
      INSERT INTO daily_archives (id, owner_id, archive_date, summary, source_turn_ids, event_ids, status)
      VALUES (?, ?, ?, ?, '[]', '[]', 'done')
    `).run("archive-oversized", "dad-owner", "2026-06-18", longSummary);
    writeRollingWeeklyContext({ owner_id: "dad-owner", date: "2026-06-18", maxChars: 6000 });

    const ambient = loadAmbientContext({ owner_id: "dad-owner", date: "2026-06-18", maxChars: 1800 });

    expect(ambient.text.length).toBeGreaterThan(0);
    expect(ambient.text).toContain("rolling 7-day context");
  });
});
