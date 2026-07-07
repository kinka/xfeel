import { closeDB, getDB } from "../packages/db/src/database";
import { initSchema, rebuildMemoryEventsFts } from "../packages/db/src/schema";

const db = getDB();

try {
  initSchema(db);
  const status = rebuildMemoryEventsFts(db);

  console.log("memory_events_fts rebuilt");
  console.log(`tokenizer: ${status.tokenizer}`);
  console.log(`memory_events rows: ${status.eventCount}`);
  console.log(`memory_events_fts rows: ${status.ftsCount}`);
  console.log(`canonical rows backfilled: ${status.backfilledCanonicalRows}`);
} finally {
  closeDB();
}
