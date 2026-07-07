import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

mock.module("../../ai-client/src/llm", () => ({
  getLLM() {
    return {
      async chatJSON() {
        throw new Error("LLM unavailable in test");
      },
      async chat() {
        throw new Error("LLM unavailable in test");
      },
    };
  },
}));

const { getDB, closeDB } = await import("../../db/src/database");
const { initSchema } = await import("../../db/src/schema");
const { recordConversationTurn, getConversationTurns } = await import("../../conversation/src/conversation");
const { runDailyArchive, getDailyArchives } = await import("./daily");
const { recall } = await import("../../retrieval/src/recall");

describe("daily archive", () => {
  let dbPath = "";

  beforeEach(() => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-archive-${crypto.randomUUID()}.db`);
    const db = getDB(dbPath);
    initSchema(db);
  });

  afterEach(() => {
    closeDB();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });

  test("archives daily conversation into diary and memory events", async () => {
    const ownerId = "demo-mom-owner";
    const date = "2026-05-12";

    recordConversationTurn({
      owner_id: ownerId,
      turn_date: date,
      content: "今天星星第一次自己走了三步，我特别开心。",
    });
    recordConversationTurn({
      owner_id: ownerId,
      turn_date: date,
      content: "晚上禾禾又夜醒两次，我有点疲惫。",
    });

    const result = await runDailyArchive({ owner_id: ownerId, date });

    expect(result.archives).toHaveLength(1);
    expect(result.archives[0]!.skipped).toBe(false);
    expect(result.archives[0]!.turns).toBe(2);
    expect(result.archives[0]!.events_stored).toBeGreaterThan(0);

    const archivedTurns = getConversationTurns({ owner_id: ownerId, date, include_archived: true });
    expect(archivedTurns.every(turn => Boolean(turn.archive_id))).toBe(true);

    const archives = getDailyArchives({ owner_id: ownerId, date });
    expect(archives).toHaveLength(1);
    expect(archives[0]!.source_turn_ids).toHaveLength(2);

    expect(recall({ owner_id: ownerId }).total).toBeGreaterThan(0);
  });

  test("does not archive the same day twice by default", async () => {
    const ownerId = "demo-dad-owner";
    const date = "2026-05-12";

    recordConversationTurn({
      owner_id: ownerId,
      turn_date: date,
      content: "我今天工作压力很大，但看到宝宝笑了又觉得释然。",
    });

    const first = await runDailyArchive({ owner_id: ownerId, date });
    const second = await runDailyArchive({ owner_id: ownerId, date });

    expect(first.archives[0]!.skipped).toBe(false);
    expect(second.archives[0]!.skipped).toBe(true);
    expect(second.archives[0]!.reason).toBe("already archived");
    expect(getDailyArchives({ owner_id: ownerId, date })).toHaveLength(1);
  });
});
