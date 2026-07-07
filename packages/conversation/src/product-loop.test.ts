import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

mock.module("../../ai-client/src/llm", () => ({
  getLLM() {
    return {
      async chat() {
        throw new Error("LLM unavailable in test");
      },
      async chatJSON() {
        throw new Error("LLM unavailable in test");
      },
    };
  },
}));

const { getDB, closeDB, closeEmbeddingDB } = await import("../../db/src/database");
const { initSchema } = await import("../../db/src/schema");
const { handleProductMessage, parseProductCommand } = await import("./product-loop");
const { getConversationTurns } = await import("./conversation");
const { getDailyArchives } = await import("../../archive/src/daily");

const DAD = "demo-dad-owner";
const DATE = "2026-06-17";
const FAMILY_ALIAS_CONTEXT = {
  familyId: "fam-test",
  speakerProfileId: "speaker-dad",
  selfMemberId: "爸爸",
  selfLabel: "爸爸",
  aliases: [
    { alias: "爸爸", memberId: "爸爸", label: "爸爸", scope: "global" as const },
    { alias: "妈妈", memberId: "妈妈", label: "妈妈", scope: "global" as const },
    { alias: "老婆", memberId: "妈妈", label: "妈妈", scope: "global" as const },
    { alias: "我老婆", memberId: "妈妈", label: "妈妈", scope: "speaker" as const, speakerProfileId: "speaker-dad" },
    { alias: "星星", memberId: "小星", label: "小星", scope: "global" as const },
    { alias: "阿星", memberId: "小星", label: "小星", scope: "global" as const },
    { alias: "禾禾", memberId: "小禾", label: "小禾", scope: "global" as const },
    { alias: "阿禾", memberId: "小禾", label: "小禾", scope: "global" as const },
  ],
  collectiveChildren: ["小禾", "小星"],
};

describe("product loop command entry", () => {
  let dbPath = "";
  let vecDbPath = "";
  const originalVecPath = process.env.XFEEL_VEC_DB_PATH;

  beforeEach(() => {
    closeEmbeddingDB();
    closeDB();
    dbPath = join(tmpdir(), `xfeel-product-loop-${crypto.randomUUID()}.db`);
    vecDbPath = join(tmpdir(), `xfeel-product-loop-${crypto.randomUUID()}.vec.db`);
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

  test("parses minimal product commands", () => {
    expect(parseProductCommand("记：今天星星走了三步")).toEqual({ intent: "log", text: "今天星星走了三步" });
    expect(parseProductCommand("查：夜醒")).toEqual({ intent: "recall", text: "夜醒" });
    expect(parseProductCommand("总结今天").intent).toBe("archive");
    expect(parseProductCommand("刚刚那条别记").intent).toBe("undo");
    expect(parseProductCommand("改：今天是禾禾走了三步")).toEqual({ intent: "correct", text: "今天是禾禾走了三步" });
    expect(parseProductCommand("星星最近夜醒怎么样？").intent).toBe("recall");
  });

  test("supports log -> recall -> archive -> undo product loop", async () => {
    const logResult = await handleProductMessage({
      text: "记：今天星星自己走了三步，爸爸特别开心。",
      owner_id: DAD,
      date: DATE,
    });
    expect(logResult.intent).toBe("log");

    const db = getDB();
    const eventCountAfterLog = (db.prepare("SELECT COUNT(*) AS c FROM memory_events WHERE user_id = ?").get(DAD) as { c: number }).c;
    expect(eventCountAfterLog).toBeGreaterThan(0);

    const recallResult = await handleProductMessage({ text: "查：星星走路", owner_id: DAD, date: DATE });
    expect(recallResult.intent).toBe("recall");
    if (recallResult.intent === "recall") {
      expect(recallResult.events.some(event => event.summary.includes("星星"))).toBe(true);
    }

    const archiveResult = await handleProductMessage({ text: "总结今天", owner_id: DAD, date: DATE });
    expect(archiveResult.intent).toBe("archive");
    expect(getDailyArchives({ owner_id: DAD, date: DATE })).toHaveLength(1);

    const undoResult = await handleProductMessage({ text: "刚刚那条别记", owner_id: DAD, date: DATE });
    expect(undoResult.intent).toBe("undo");
    if (undoResult.intent === "undo") expect(undoResult.result.undone).toBe(true);
    const eventCountAfterUndo = (db.prepare("SELECT COUNT(*) AS c FROM memory_events WHERE user_id = ?").get(DAD) as { c: number }).c;
    expect(eventCountAfterUndo).toBe(0);
    expect(getDailyArchives({ owner_id: DAD, date: DATE })).toHaveLength(0);
  });

  test("corrects latest logged memory by replacing old events in place", async () => {
    await handleProductMessage({ text: "记：今天星星自己走了三步。", owner_id: DAD, date: DATE });
    const correctResult = await handleProductMessage({ text: "改：今天是禾禾自己走了三步。", owner_id: DAD, date: DATE });
    expect(correctResult.intent).toBe("correct");
    if (correctResult.intent === "correct") {
      expect(correctResult.result.corrected).toBe(true);
      expect(correctResult.result.old_text).toContain("星星");
      expect(correctResult.result.new_text).toContain("禾禾");
    }

    const turns = getConversationTurns({ owner_id: DAD, date: DATE, include_archived: true });
    expect(turns.some(turn => turn.content.includes("禾禾"))).toBe(true);
    const rows = getDB().prepare("SELECT summary, original_text FROM memory_events WHERE user_id = ?").all(DAD) as Array<{ summary: string; original_text: string }>;
    expect(rows.some(row => `${row.summary} ${row.original_text}`.includes("禾禾"))).toBe(true);
    expect(rows.some(row => `${row.summary} ${row.original_text}`.includes("星星"))).toBe(false);
  });

  test("uses alias context for product log and correction identity normalization", async () => {
    const logResult = await handleProductMessage({
      text: "记：今天我老婆带阿星出门，阿星很开心。",
      owner_id: DAD,
      date: DATE,
      speaker_id: "speaker-dad",
      speaker_label: "爸爸",
      aliasContext: FAMILY_ALIAS_CONTEXT,
    });
    expect(logResult.intent).toBe("log");

    let rows = getDB().prepare("SELECT entities, canonical_search_text, original_text FROM memory_events WHERE user_id = ?").all(DAD) as Array<{
      entities: string;
      canonical_search_text: string;
      original_text: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    let entitySet = new Set(rows.flatMap(row => JSON.parse(row.entities) as string[]));
    expect(entitySet).toContain("妈妈");
    expect(entitySet).toContain("小星");
    expect(entitySet).not.toContain("小禾");
    expect(rows.some(row => row.canonical_search_text.includes("妈妈") && row.canonical_search_text.includes("小星"))).toBe(true);

    const correctResult = await handleProductMessage({
      text: "改：今天我老婆带阿禾出门，阿禾很开心。",
      owner_id: DAD,
      date: DATE,
      speaker_id: "speaker-dad",
      speaker_label: "爸爸",
      aliasContext: FAMILY_ALIAS_CONTEXT,
    });
    expect(correctResult.intent).toBe("correct");
    if (correctResult.intent === "correct") expect(correctResult.result.corrected).toBe(true);

    rows = getDB().prepare("SELECT entities, canonical_search_text, original_text FROM memory_events WHERE user_id = ?").all(DAD) as Array<{
      entities: string;
      canonical_search_text: string;
      original_text: string;
    }>;
    entitySet = new Set(rows.flatMap(row => JSON.parse(row.entities) as string[]));
    expect(entitySet).toContain("妈妈");
    expect(entitySet).toContain("小禾");
    expect(entitySet).not.toContain("小星");
    expect(rows.some(row => row.canonical_search_text.includes("妈妈") && row.canonical_search_text.includes("小禾"))).toBe(true);
    expect(rows.every(row => !row.original_text.includes("阿星"))).toBe(true);
  });
});
