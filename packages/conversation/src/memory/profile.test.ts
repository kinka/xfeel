import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { closeDB, getDB } = await import("../../../db/src/database");
const { initSchema } = await import("../../../db/src/schema");
const { getLongTermProfile, getRecentProfile, upsertProfile } = await import("./profile-repository");
const { loadUnderstandingContext } = await import("./profile-context");
const { listUnderstandingFeedback, saveUnderstandingFeedback, understandingKey } = await import("./understanding-feedback");
import type { LongTermProfileContent, RecentProfileContent } from "./profile-types";

const longTermContent: LongTermProfileContent = {
  narrative: "爸爸很在乎孩子的成长，也在意自己被看见。",
  understandings: [
    {
      category: "comfort_strategy",
      subject: "记录者",
      statement: "先承认带娃辛苦，再帮他看见小进展。",
      kind: "inferred",
      status: "active",
      confidence: 0.8,
      support: { evidenceCount: 4, recencyDays: 10, consistency: 1, userConfirmed: false },
      supportDates: ["2025-01-01", "2025-06-01", "2026-01-01", "2026-06-01"],
    },
    {
      category: "sensitivity",
      subject: "记录者",
      statement: "孩子生病是高敏感话题，需要轻拿轻放。",
      kind: "observed",
      status: "active",
      confidence: 0.4,
      support: { evidenceCount: 2, consistency: 1, userConfirmed: false },
      supportDates: ["2025-02-11", "2025-04-06"],
    },
    {
      category: "values",
      subject: "记录者",
      statement: "这条已被推翻，不应注入。",
      kind: "observed",
      status: "retracted",
      confidence: 0.5,
      support: { evidenceCount: 2, consistency: 1, userConfirmed: false },
      supportDates: ["2024-01-01", "2024-02-01"],
    },
  ],
  addressBook: [
    { member: "老婆", preferredAddress: "伴侣昵称", aliases: ["妈妈"], relation: "配偶" },
  ],
  openQuestions: [{ topic: "他最想被怎样看见", why: "影响如何回应", priority: 1 }],
};

const recentContent: RecentProfileContent = {
  windowDays: 21,
  stateSummary: "最近围绕两个孩子的成长和照料，整体温暖但带娃疲惫。",
  emotionalTrend: "以喜悦为主，夹杂育儿疲惫。",
  openThreads: [{ topic: "阿星咳嗽", status: "watching", lastMentionedAt: "2026-06-18" }],
  notableEvents: [{ date: "2026-06-18", summary: "项目被领导表扬" }],
};

describe("memory profile repository + context", () => {
  let dbPath = "";

  beforeEach(() => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-profile-${crypto.randomUUID()}.db`);
    initSchema(getDB(dbPath));
    delete process.env.XFEEL_UNDERSTANDING_DISABLED;
  });

  afterEach(() => {
    closeDB();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    delete process.env.XFEEL_UNDERSTANDING_DISABLED;
  });

  test("upsert round-trips and bumps version on re-write", () => {
    const first = upsertProfile({ ownerId: "dad", layer: "long_term", content: longTermContent, evidenceCount: 60 });
    expect(first.version).toBe(1);
    const loaded = getLongTermProfile("dad");
    expect(loaded?.content.narrative).toContain("被看见");
    expect(loaded?.evidenceCount).toBe(60);

    const second = upsertProfile({ ownerId: "dad", layer: "long_term", content: longTermContent });
    expect(second.version).toBe(2);
    // 同 (owner, layer) 只保留一条最新快照
    const count = (getDB().prepare("SELECT COUNT(*) c FROM memory_profiles WHERE owner_id='dad' AND layer='long_term'").get() as { c: number }).c;
    expect(count).toBe(1);
  });

  test("profiles are isolated per owner (防串台)", () => {
    upsertProfile({ ownerId: "dad", layer: "long_term", content: longTermContent });
    expect(getLongTermProfile("mom")).toBeNull();
    expect(getRecentProfile("dad")).toBeNull();
  });

  test("context injects active understandings, recent state, address book, and discipline", () => {
    upsertProfile({ ownerId: "dad", layer: "long_term", content: longTermContent });
    upsertProfile({ ownerId: "dad", layer: "recent", content: recentContent });

    const ctx = loadUnderstandingContext({ owner_id: "dad" });
    expect(ctx.hasLongTerm).toBe(true);
    expect(ctx.hasRecent).toBe(true);
    // active 注入，retracted 不注入
    expect(ctx.text).toContain("先承认带娃辛苦");
    expect(ctx.text).not.toContain("已被推翻");
    // 低置信度标注“暂不确定”
    expect(ctx.text).toContain("暂不确定");
    // 近期状态
    expect(ctx.text).toContain("带娃疲惫");
    expect(ctx.text).toContain("阿星咳嗽");
    // 称呼一致
    expect(ctx.text).toContain("老婆→伴侣昵称");
    expect(ctx.addressBook).toEqual([{ member: "老婆", preferredAddress: "伴侣昵称" }]);
    // 事实纪律：理解是假设、以当下为准
    expect(ctx.text).toContain("假设");
    expect(ctx.text).toContain("以用户当下这句为准");
  });

  test("feature flag disables understanding injection", () => {
    upsertProfile({ ownerId: "dad", layer: "long_term", content: longTermContent });
    process.env.XFEEL_UNDERSTANDING_DISABLED = "1";
    const ctx = loadUnderstandingContext({ owner_id: "dad" });
    expect(ctx.hasLongTerm).toBe(false);
    expect(ctx.text).toBe("");
  });

  test("no profile returns empty context", () => {
    expect(loadUnderstandingContext({ owner_id: "ghost" }).text).toBe("");
    expect(loadUnderstandingContext({}).text).toBe("");
  });

  test("user feedback confirms, corrects, and retracts understandings without crossing owners", () => {
    upsertProfile({ ownerId: "dad", layer: "long_term", content: longTermContent });
    const comfort = longTermContent.understandings[0]!;
    const sensitivity = longTermContent.understandings[1]!;

    saveUnderstandingFeedback({ ownerId: "dad", item: comfort, action: "correct", replacementStatement: "先听我说完，再问我要不要一起想办法。" });
    saveUnderstandingFeedback({ ownerId: "dad", item: sensitivity, action: "retract" });

    const ctx = loadUnderstandingContext({ owner_id: "dad" });
    expect(ctx.text).toContain("先听我说完");
    expect(ctx.text).not.toContain("孩子生病是高敏感话题");
    expect(listUnderstandingFeedback("dad")).toHaveLength(2);
    expect(listUnderstandingFeedback("mom")).toHaveLength(0);
    expect(understandingKey(comfort)).toHaveLength(24);
  });
});
