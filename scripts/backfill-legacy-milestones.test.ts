import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDB, getDB } from "../packages/db/src/database";
import { initSchema } from "../packages/db/src/schema";
import { applyReviewDecisions, loadReviewRows, REVIEW_VERSION } from "./backfill-legacy-milestones";

describe("legacy milestone backfill", () => {
  let dbPath = "";
  beforeEach(() => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-milestone-backfill-${crypto.randomUUID()}.db`);
    initSchema(getDB(dbPath));
  });
  afterEach(() => {
    closeDB();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  });

  test("reviews and updates only the canonical event for a multi-event diary", () => {
    const db = getDB();
    db.prepare("INSERT INTO diaries (id,user_id,content,diary_date) VALUES ('d1','o1','学会走路','2024-01-02')").run();
    db.prepare("INSERT INTO memory_events (id,raw_message_id,summary,original_text,event_type,user_id,source_layer,event_date) VALUES (?,?,?,?,?,?,?,?)")
      .run("diary:d1:rule:main", "d1", "主事件", "主事件", "other", "o1", "extracted", "2024-01-02");
    db.prepare("INSERT INTO memory_events (id,raw_message_id,summary,original_text,event_type,user_id,source_layer,event_date) VALUES (?,?,?,?,?,?,?,?)")
      .run("secondary", "d1", "另一个事件", "另一个事件", "other", "o1", "extracted", "2024-01-02");
    const rows = loadReviewRows(db, "o1", "2024");
    expect(rows.map(row => row.eventId)).toEqual(["diary:d1:rule:main"]);
    applyReviewDecisions(db, "o1", "2024", [rows[0]!.eventId]);
    expect((db.prepare("SELECT event_type FROM memory_events WHERE id='diary:d1:rule:main'").get() as any).event_type).toBe("milestone");
    expect((db.prepare("SELECT event_type FROM memory_events WHERE id='secondary'").get() as any).event_type).toBe("other");
  });

  test("is idempotent and demotes a previously selected event after an LLM reversal", () => {
    const db = getDB();
    db.prepare("INSERT INTO memory_events (id,summary,original_text,event_type,user_id,event_date,extractor_version) VALUES ('e1','首次走路','首次走路','other','o1','2024-01-02','legacy')").run();
    expect(applyReviewDecisions(db, "o1", "2024", ["e1"])).toEqual({ promoted: 1, demoted: 0 });
    expect(applyReviewDecisions(db, "o1", "2024", ["e1"])).toEqual({ promoted: 1, demoted: 0 });
    expect(applyReviewDecisions(db, "o1", "2024", [])).toEqual({ promoted: 0, demoted: 1 });
    const row = db.prepare("SELECT event_type,extractor_version FROM memory_events WHERE id='e1'").get() as any;
    expect(row).toEqual({ event_type: "other", extractor_version: "legacy" });
    expect(REVIEW_VERSION).toContain("milestone-llm");
  });
});
