import { Database, type DatabaseOptions } from "bun:sqlite";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

let db: Database | null = null;
let vecDb: Database | null = null;
let mainDbPath: string | null = null;

export function getDB(dbPath?: string, options: DatabaseOptions = {}): Database {
  if (db) return db;
  
  const path = dbPath || process.env.XFEEL_DB_PATH || resolve(process.cwd(), "data", "xfeel.db");
  const isMemory = path === ":memory:" || path === "";
  const readonly = Boolean(options.readonly);
  
  if (!isMemory && !readonly) {
    const dir = resolve(path, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  
  const databaseOptions = Object.keys(options).length ? options : undefined;
  db = new Database(path, databaseOptions);
  mainDbPath = isMemory ? ":memory:" : resolve(path);
  
  db.exec("PRAGMA foreign_keys = ON");
  if (readonly) {
    db.exec("PRAGMA query_only = ON");
  } else {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }
  
  return db;
}

export function getEmbeddingDB(dbPath?: string, options: DatabaseOptions = {}): Database {
  if (vecDb) return vecDb;

  const path = resolveEmbeddingDBPath(dbPath);
  const isMemory = path === ":memory:" || path === "";
  const readonly = Boolean(options.readonly);

  if (!isMemory && !readonly) {
    const dir = resolve(path, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const databaseOptions = Object.keys(options).length ? options : undefined;
  vecDb = new Database(isMemory ? ":memory:" : path, databaseOptions);

  vecDb.exec("PRAGMA foreign_keys = ON");
  if (readonly) {
    vecDb.exec("PRAGMA query_only = ON");
  } else {
    vecDb.exec("PRAGMA journal_mode = WAL");
    vecDb.exec("PRAGMA synchronous = NORMAL");
    ensureVecSchema(vecDb);
  }

  return vecDb;
}

export function closeDB() {
  if (db) {
    db.close();
    db = null;
  }
  mainDbPath = null;
}

export function closeEmbeddingDB() {
  if (vecDb) {
    vecDb.close();
    vecDb = null;
  }
}

function resolveEmbeddingDBPath(dbPath?: string): string {
  if (dbPath !== undefined) return dbPath;
  if (process.env.XFEEL_VEC_DB_PATH) return process.env.XFEEL_VEC_DB_PATH;

  const derived = deriveVecPathFromMain();
  if (derived) return derived;

  return resolve(process.cwd(), "data", "xfeel.vec.db");
}

function deriveVecPathFromMain(): string | null {
  const path = db?.filename || mainDbPath || process.env.XFEEL_DB_PATH;
  if (path === undefined || path === null) return null;
  if (path === ":memory:" || path === "") return ":memory:";
  return resolve(dirname(resolve(path)), "xfeel.vec.db");
}

function ensureVecSchema(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      fact_kind TEXT,
      embedding_model TEXT NOT NULL,
      embedding_dim INTEGER NOT NULL,
      embedding_text TEXT NOT NULL,
      embedding_json TEXT,
      embedding_blob BLOB,
      source_updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_owner_model
      ON memory_embeddings(owner_id, embedding_model);
    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_target
      ON memory_embeddings(target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_fact_kind
      ON memory_embeddings(owner_id, fact_kind);
  `);

  const cols = database.prepare("PRAGMA table_info(memory_embeddings)").all() as Array<{ name: string }>;
  if (!cols.some(column => column.name === "embedding_blob")) {
    database.exec("ALTER TABLE memory_embeddings ADD COLUMN embedding_blob BLOB");
  }
}
