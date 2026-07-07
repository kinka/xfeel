import { Database } from "bun:sqlite";

const db = new Database("data/xfeel.db");
db.exec("PRAGMA journal_mode = WAL");

// Test insert
const stmt = db.prepare(
  "INSERT INTO memory_events (id, summary, original_text, event_type, entities, emotion, tags, confidence, source, source_layer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
);
stmt.run(
  "test-1",
  "星星夜醒三次",
  "星星昨晚又醒了三次，我快崩溃了",
  'sleep',
  '["星星"]',
  '{"primary":"崩溃","intensity":0.9,"valence":"negative"}',
  '["夜醒"]',
  0.9,
  "user",
  "extracted"
);

// Test query
const row = db.query("SELECT * FROM memory_events WHERE id = ?").get("test-1");
console.log("✅ Insert OK:", row.summary, "|", row.event_type);

// Test FTS
try {
  const fts = db.query("SELECT * FROM memory_events_fts WHERE memory_events_fts MATCH ?").all("夜醒");
  console.log("✅ FTS OK:", fts.length, "results");
} catch (e) {
  console.log("⚠️ FTS needs rebuild after insert:", e.message);
  // Rebuild FTS
  db.exec("INSERT INTO memory_events_fts(memory_events_fts) VALUES('rebuild')");
  const fts = db.query("SELECT * FROM memory_events_fts WHERE memory_events_fts MATCH ?").all("夜醒");
  console.log("✅ FTS OK after rebuild:", fts.length, "results");
}

// Test structured query
const rows = db.query("SELECT * FROM memory_events WHERE event_type = ?").all("sleep");
console.log("✅ Structured query OK:", rows.length, "sleep events");

// Cleanup
db.exec("DELETE FROM memory_events WHERE id = 'test-1'");
db.exec("DELETE FROM memory_events_fts WHERE memory_events_fts MATCH '夜醒'");
console.log("✅ Cleanup OK");

db.close();
console.log("\n✅ All DB tests passed");
