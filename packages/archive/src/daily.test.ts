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
const { runDailyArchive, getDailyArchives, repairDayIntegrity } = await import("./daily");
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

  test("repairs log turn metadata from existing message events before archive", async () => {
    const ownerId = "demo-mom-owner";
    const date = "2026-05-13";
    const rawMessageId = "raw-existing-log";

    const turn = recordConversationTurn({
      owner_id: ownerId,
      turn_date: date,
      source: "log",
      content: "今天星星主动收玩具，我很惊喜。",
      metadata: {
        mode: "log_with_contextual_reply",
        pipeline_message_id: rawMessageId,
        current_event_ids: ["stale-event-id"],
      },
    });
    getDB().prepare(`
      INSERT INTO memory_events (
        id, raw_message_id, event_index, summary, original_text, event_type,
        entities, emotion, tags, event_date, user_id, source, source_layer
      ) VALUES (?, ?, 0, ?, ?, 'daily', '[]', '{}', '[]', ?, ?, 'user', 'extracted')
    `).run("existing-event-id", rawMessageId, "星星主动收玩具", "今天星星主动收玩具，我很惊喜。", date, ownerId);
    getDB().prepare(`
      INSERT INTO pipeline_status (message_id, stage, status, result)
      VALUES (?, 'indexed', 'done', '{"stored":1}')
    `).run(rawMessageId);

    const report = await repairDayIntegrity({ owner_id: ownerId, date });

    expect(report.metadata_fixed).toBe(1);
    expect(report.reprocessed).toBe(0);
    expect(report.issues[0]).toMatchObject({
      turn_id: turn.id,
      message_id: rawMessageId,
      issue: "invalid_event_ids",
      action: "metadata_fixed",
      event_ids: ["existing-event-id"],
    });

    const row = getDB().prepare("SELECT source, metadata FROM conversation_turns WHERE id = ?")
      .get(turn.id) as { source: string; metadata: string };
    const metadata = JSON.parse(row.metadata) as { current_event_ids: string[]; pipeline_message_id: string };
    expect(row.source).toBe("log");
    expect(metadata.pipeline_message_id).toBe(rawMessageId);
    expect(metadata.current_event_ids).toEqual(["existing-event-id"]);
  });
});
