import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { initSchema } from "../packages/db/src/schema";
import { assertSafeEvalDbPath, seedEvents, selectEvalDbPath } from "./eval-recall-hard";

describe("eval-recall-hard DB safety", () => {
  test("uses a temp eval DB by default", () => {
    const selected = selectEvalDbPath({});
    try {
      expect(selected.source).toBe("temp");
      expect(selected.path).toContain("xfeel-recall-eval-");
      expect(() => assertSafeEvalDbPath(selected.path)).not.toThrow();
    } finally {
      rmSync(dirname(selected.path), { recursive: true, force: true });
    }
  });

  test("rejects production-looking DB paths", () => {
    expect(() => assertSafeEvalDbPath(join(process.cwd(), "data", "xfeel.db"))).toThrow(/production-looking DB path/);
    expect(() => assertSafeEvalDbPath(join(process.cwd(), "tmp", "xfeel.db"))).toThrow(/production-looking DB path/);
  });

  test("seedEvents refuses unsafe DB paths before deleting base rows", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      insertExistingEvent(db);

      expect(() => seedEvents(db, [seedEvent()], join(process.cwd(), "data", "xfeel.db"))).toThrow(/production-looking DB path/);
      expect(countMemoryEvents(db)).toBe(1);
      expect(memoryEventIds(db)).toEqual(["existing"]);
    } finally {
      db.close();
    }
  });
});

function insertExistingEvent(db: Database) {
  db.prepare(`
    INSERT INTO memory_events (
      id,
      summary,
      original_text,
      event_type,
      entities,
      emotion,
      tags,
      canonical_search_text,
      event_time,
      user_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "existing",
    "现有记录",
    "现有记录",
    "daily",
    JSON.stringify(["星星"]),
    JSON.stringify({ primary: "平静", valence: "neutral", intensity: 0.2 }),
    JSON.stringify([]),
    "现有记录",
    "2026-06-10T09:00:00.000Z",
    "demo-dad-owner",
  );
}

function seedEvent() {
  return {
    id: "eval-new",
    owner_id: "demo-dad-owner",
    summary: "评测种子事件",
    original_text: "评测种子事件",
    event_type: "daily",
    entities: ["星星"],
    emotion: { primary: "平静", valence: "neutral" as const, intensity: 0.2 },
    tags: [],
    event_time: "2026-06-11T09:00:00.000Z",
  };
}

function countMemoryEvents(db: Database): number {
  return (db.prepare("SELECT COUNT(*) as count FROM memory_events").get() as { count: number }).count;
}

function memoryEventIds(db: Database): string[] {
  return (db.prepare("SELECT id FROM memory_events ORDER BY id").all() as Array<{ id: string }>).map(row => row.id);
}
