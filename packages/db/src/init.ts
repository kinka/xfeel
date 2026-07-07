import { getDB, closeDB } from "./database";
import { initSchema } from "./schema";

const db = getDB();
initSchema(db);
console.log("✅ Database initialized");

// 验证
const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{name: string}>;
console.log("Tables:", tables.map(t => t.name).join(", "));

const fts = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts%'").all() as Array<{name: string}>;
console.log("FTS tables:", fts.map(t => t.name).join(", "));

closeDB();
