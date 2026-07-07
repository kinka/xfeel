import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureMemoryEventsFts, initSchema, rebuildMemoryEventsFts } from "./schema";
import { prepareRawMessageEventDeletion } from "./memory-events";

describe("memory_events FTS schema", () => {
  test("migrates legacy unicode61 FTS without canonical_search_text and rebuilds safely", () => {
    const db = new Database(":memory:");
    createLegacyMemoryEventsSchema(db);
    db.prepare(`
      INSERT INTO memory_events (
        id, summary, original_text, event_type, entities, emotion, tags, event_time, user_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-health",
      "星星接种记录",
      "今天去社区医院接种，回来后状态还可以。",
      "health",
      JSON.stringify(["星星"]),
      JSON.stringify({ primary: "担心", valence: "negative", intensity: 0.5 }),
      JSON.stringify(["疫苗"]),
      "2026-06-10T09:00:00.000Z",
      "demo-dad-owner",
    );
    db.exec("INSERT INTO memory_events_fts(memory_events_fts) VALUES('rebuild')");

    const status = initSchema(db);

    expect(status.recreated).toBe(true);
    expect(status.rebuilt).toBe(true);
    expect(status.backfilledCanonicalRows).toBe(1);
    expect(status.eventCount).toBe(1);
    expect(status.ftsCount).toBe(1);

    const columns = db.prepare("PRAGMA table_info(memory_events)").all() as Array<{ name: string }>;
    const columnNames = columns.map(column => column.name);
    expect(columnNames).toContain("canonical_search_text");
    expect(columnNames).toContain("event_index");
    expect(columnNames).toContain("original_span");
    expect(columnNames).toContain("event_date");
    expect(columnNames).toContain("extractor_version");
    expect(columnNames).toContain("vocab_version");
    expect(columnNames).toContain("search_text_version");
    expect(columnNames).toContain("source_archive_id");

    const row = db.prepare(`
      SELECT canonical_search_text, original_span, event_date, extractor_version, vocab_version, search_text_version
      FROM memory_events
      WHERE id = ?
    `).get("legacy-health") as {
      canonical_search_text: string;
      original_span: string;
      event_date: string;
      extractor_version: string;
      vocab_version: string;
      search_text_version: string;
    };
    expect(row.canonical_search_text).toContain("疫苗");
    expect(row.canonical_search_text).toContain("打针");
    expect(row.original_span).toBe("今天去社区医院接种，回来后状态还可以。");
    expect(row.event_date).toBe("2026-06-10");
    expect(row.extractor_version).toBe("legacy");
    expect(row.vocab_version).toBe("legacy");
    expect(row.search_text_version).toBe("legacy");

    const indexes = db.prepare("PRAGMA index_list(memory_events)").all() as Array<{ name: string }>;
    expect(indexes.map(index => index.name)).toContain("idx_events_raw_index");
    expect(indexes.map(index => index.name)).toContain("idx_events_user_date");

    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_events_fts'")
      .get() as { sql: string }).sql;
    expect(sql).toContain(`tokenize='${status.tokenizer}'`);

    const matchTerm = status.tokenizer === "trigram" ? "不舒服" : "疫苗";
    const match = db.prepare("SELECT COUNT(*) as count FROM memory_events_fts WHERE memory_events_fts MATCH ?")
      .get(matchTerm) as { count: number };
    expect(match.count).toBe(1);

    const triggers = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN ('memory_events_ai', 'memory_events_ad', 'memory_events_au')
    `).all() as Array<{ sql: string }>;
    expect(triggers).toHaveLength(3);
    expect(triggers.every(trigger => trigger.sql.includes("canonical_search_text"))).toBe(true);

    const secondPass = ensureMemoryEventsFts(db);
    expect(secondPass.recreated).toBe(false);
    expect(secondPass.rebuilt).toBe(false);

    db.close();
  });

  test("rebuildMemoryEventsFts preserves memory_events rows", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      insertMemoryEvent(db, {
        id: "health-1",
        summary: "星星不舒服，准备去打针",
        canonical_search_text: "星星 health 疫苗 打针 不舒服",
      });
      insertMemoryEvent(db, {
        id: "sleep-1",
        summary: "禾禾夜醒后重新入睡",
        canonical_search_text: "禾禾 sleep 夜醒 自主入睡",
      });

      const beforeCount = countMemoryEvents(db);
      const beforeIds = memoryEventIds(db);

      const status = rebuildMemoryEventsFts(db);

      expect(countMemoryEvents(db)).toBe(beforeCount);
      expect(memoryEventIds(db)).toEqual(beforeIds);
      expect(status.eventCount).toBe(beforeCount);
      expect(status.ftsCount).toBe(beforeCount);

      const matchTerm = status.tokenizer === "trigram" ? "不舒服" : "疫苗";
      const match = db.prepare("SELECT COUNT(*) as count FROM memory_events_fts WHERE memory_events_fts MATCH ?")
        .get(matchTerm) as { count: number };
      expect(match.count).toBe(1);
    } finally {
      db.close();
    }
  });

  test("raw-message replacement deletes causal chains before scoped memory events", () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      initSchema(db);
      insertMemoryEvent(db, {
        id: "raw-cause",
        summary: "星星夜醒",
        canonical_search_text: "星星 sleep 夜醒",
        raw_message_id: "raw-replace",
        user_id: "owner-1",
      });
      insertMemoryEvent(db, {
        id: "external-effect",
        summary: "爸爸疲惫",
        canonical_search_text: "爸爸 fatigue 疲惫",
        user_id: "owner-1",
      });
      db.prepare(`
        INSERT INTO causal_chains (id, cause_event_id, effect_event_id, relation_type, strength, description)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run("chain-raw", "raw-cause", "external-effect", "triggers", 0.8, "raw replacement chain");

      const deleteRawMessageEvents = prepareRawMessageEventDeletion(db);
      const replace = db.transaction(() => {
        deleteRawMessageEvents("raw-replace", "owner-1");
        insertMemoryEvent(db, {
          id: "raw-cause-v2",
          summary: "星星重新入睡",
          canonical_search_text: "星星 sleep 重新入睡",
          raw_message_id: "raw-replace",
          user_id: "owner-1",
        });
      });

      expect(() => replace()).not.toThrow();
      expect(hasMemoryEvent(db, "raw-cause")).toBe(false);
      expect(hasMemoryEvent(db, "raw-cause-v2")).toBe(true);
      expect(hasMemoryEvent(db, "external-effect")).toBe(true);
      expect(countCausalChains(db)).toBe(0);
    } finally {
      db.close();
    }
  });
});

function insertMemoryEvent(db: Database, input: {
  id: string;
  summary: string;
  canonical_search_text: string;
  raw_message_id?: string;
  source_layer?: string;
  user_id?: string;
}) {
  db.prepare(`
    INSERT INTO memory_events (
      id,
      raw_message_id,
      summary,
      original_text,
      event_type,
      entities,
      emotion,
      tags,
      canonical_search_text,
      event_time,
      source_layer,
      user_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.raw_message_id || null,
    input.summary,
    input.summary,
    "daily",
    JSON.stringify(["星星"]),
    JSON.stringify({ primary: "平静", valence: "neutral", intensity: 0.2 }),
    JSON.stringify([]),
    input.canonical_search_text,
    "2026-06-10T09:00:00.000Z",
    input.source_layer || "extracted",
    input.user_id || "demo-dad-owner",
  );
}

function countMemoryEvents(db: Database): number {
  return (db.prepare("SELECT COUNT(*) as count FROM memory_events").get() as { count: number }).count;
}

function memoryEventIds(db: Database): string[] {
  return (db.prepare("SELECT id FROM memory_events ORDER BY id").all() as Array<{ id: string }>).map(row => row.id);
}

function hasMemoryEvent(db: Database, id: string): boolean {
  return Boolean(db.prepare("SELECT id FROM memory_events WHERE id = ?").get(id));
}

function countCausalChains(db: Database): number {
  return (db.prepare("SELECT COUNT(*) as count FROM causal_chains").get() as { count: number }).count;
}

function createLegacyMemoryEventsSchema(db: Database) {
  db.exec(`
    CREATE TABLE memory_events (
      id TEXT PRIMARY KEY,
      raw_message_id TEXT,
      summary TEXT NOT NULL,
      original_text TEXT NOT NULL,
      event_type TEXT NOT NULL,
      entities TEXT NOT NULL DEFAULT '[]',
      emotion TEXT NOT NULL DEFAULT '{}',
      tags TEXT NOT NULL DEFAULT '[]',
      location TEXT,
      event_time TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      source TEXT NOT NULL DEFAULT 'user',
      source_layer TEXT NOT NULL DEFAULT 'extracted',
      user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE VIRTUAL TABLE memory_events_fts USING fts5(
      summary,
      original_text,
      tags,
      content=memory_events,
      content_rowid=rowid,
      tokenize="unicode61"
    );

    CREATE TRIGGER memory_events_ai AFTER INSERT ON memory_events BEGIN
      INSERT INTO memory_events_fts(rowid, summary, original_text, tags)
      VALUES (new.rowid, new.summary, new.original_text, new.tags);
    END;

    CREATE TRIGGER memory_events_ad AFTER DELETE ON memory_events BEGIN
      INSERT INTO memory_events_fts(memory_events_fts, rowid, summary, original_text, tags)
      VALUES ('delete', old.rowid, old.summary, old.original_text, old.tags);
    END;

    CREATE TRIGGER memory_events_au AFTER UPDATE ON memory_events BEGIN
      INSERT INTO memory_events_fts(memory_events_fts, rowid, summary, original_text, tags)
      VALUES ('delete', old.rowid, old.summary, old.original_text, old.tags);
      INSERT INTO memory_events_fts(rowid, summary, original_text, tags)
      VALUES (new.rowid, new.summary, new.original_text, new.tags);
    END;
  `);
}
