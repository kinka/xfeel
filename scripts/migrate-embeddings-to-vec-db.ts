#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ensureEmbeddingSchema, floatsToBlob, readEmbeddingVector, type StoredEmbeddingRow } from "./embedding-common";

interface Args {
  db: string;
  vecDb?: string;
  apply: boolean;
  dropSource: boolean;
  batchSize: number;
}

interface SourceEmbeddingRow extends StoredEmbeddingRow {
  source_updated_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

const args = parseArgs(process.argv.slice(2));
const sourcePath = resolveDbPath(args.db);
const vecPath = resolveVecDbPath(args.vecDb, sourcePath);
const sourceReadonly = !args.apply || !args.dropSource;
const sourceDb = new Database(sourcePath, sourceReadonly ? { readonly: true, create: false } : { readwrite: true, create: false });
let vecDb: Database | undefined;

try {
  if (sourceReadonly) sourceDb.exec("PRAGMA query_only = ON");
  const sourceHasTable = tableExists(sourceDb, "memory_embeddings");
  const sourceRows = sourceHasTable ? countRows(sourceDb, "memory_embeddings") : 0;
  const vecRowsBefore = readVecRowCount(vecPath);
  const pendingRows = sourceHasTable ? countPendingRows(sourceDb, vecPath, args.batchSize) : 0;
  const sourceSizeMb = fileMB(sourcePath);

  console.log(JSON.stringify({
    db: sourcePath,
    vec_db: vecPath,
    source_has_table: sourceHasTable,
    source_rows: sourceRows,
    vec_rows_before: vecRowsBefore,
    pending_rows: pendingRows,
    source_size_mb: sourceSizeMb,
    apply: args.apply,
    drop_source: args.dropSource,
    dry_run: !args.apply,
  }, null, 2));

  if (args.dropSource && !args.apply) {
    throw new Error("--drop-source requires --apply");
  }
  if (!args.apply || !sourceHasTable || sourceRows === 0) {
    if (!args.apply) console.log("dry-run only; no changes written.");
    else if (!sourceHasTable) console.log("source memory_embeddings table is missing; nothing to migrate.");
    else console.log("source memory_embeddings table is empty; nothing to migrate.");
    process.exitCode = 0;
  } else {
    if (vecPath !== ":memory:" && !existsSync(dirname(vecPath))) mkdirSync(dirname(vecPath), { recursive: true });
    vecDb = new Database(vecPath, { readwrite: true, create: true });
    vecDb.exec("PRAGMA journal_mode = WAL");
    vecDb.exec("PRAGMA synchronous = NORMAL");
    ensureEmbeddingSchema(vecDb);

    const migrated = migrateRows(sourceDb, vecDb, args.batchSize);
    const vecRowsAfter = countRows(vecDb, "memory_embeddings");
    console.log(JSON.stringify({
      migrated,
      vec_rows_after: vecRowsAfter,
    }, null, 2));

    if (args.dropSource) {
      if (vecRowsAfter < sourceRows) {
        throw new Error(`Refusing to drop source: vec rows (${vecRowsAfter}) < source rows (${sourceRows})`);
      }
      console.log(`DROP/VACUUM source table requested for ${sourcePath}; vec rows ${vecRowsAfter} >= source rows ${sourceRows}.`);
      sourceDb.exec("DROP TABLE memory_embeddings");
      sourceDb.exec("VACUUM");
      console.log(JSON.stringify({
        dropped_source: true,
        source_size_mb_after: fileMB(sourcePath),
      }, null, 2));
    } else {
      console.log("source table left intact; pass --apply --drop-source to remove it after verification.");
    }
  }
} finally {
  vecDb?.close();
  sourceDb.close();
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: process.env.XFEEL_DB_PATH || "data/xfeel.db",
    vecDb: process.env.XFEEL_VEC_DB_PATH,
    apply: process.env.CONFIRM === "1",
    dropSource: false,
    batchSize: 1000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i] || "";
    if (arg === "--db") args.db = next();
    else if (arg === "--vec-db") args.vecDb = next();
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--drop-source") args.dropSource = true;
    else if (arg === "--batch-size") args.batchSize = Math.max(1, Number(next()) || args.batchSize);
    else throw new Error(`Unknown arg: ${arg}`);
  }
  return args;
}

function migrateRows(sourceDb: Database, vecDb: Database, batchSize: number): number {
  const select = sourceDb.prepare("SELECT * FROM memory_embeddings ORDER BY id LIMIT ? OFFSET ?");
  const upsert = vecDb.prepare(`
    INSERT INTO memory_embeddings (
      id, owner_id, target_type, target_id, fact_kind, embedding_model, embedding_dim,
      embedding_text, embedding_json, embedding_blob, source_updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
    ON CONFLICT(id) DO UPDATE SET
      owner_id = excluded.owner_id,
      target_type = excluded.target_type,
      target_id = excluded.target_id,
      fact_kind = excluded.fact_kind,
      embedding_model = excluded.embedding_model,
      embedding_dim = excluded.embedding_dim,
      embedding_text = excluded.embedding_text,
      embedding_json = '',
      embedding_blob = excluded.embedding_blob,
      source_updated_at = excluded.source_updated_at,
      updated_at = datetime('now')
  `);

  let migrated = 0;
  for (let offset = 0;; offset += batchSize) {
    const rows = select.all(batchSize, offset) as SourceEmbeddingRow[];
    if (rows.length === 0) break;
    const tx = vecDb.transaction(() => {
      for (const row of rows) {
        const vector = readEmbeddingVector(row);
        if (vector.length === 0) continue;
        upsert.run(
          row.id,
          row.owner_id,
          row.target_type,
          row.target_id,
          row.fact_kind || null,
          row.embedding_model,
          row.embedding_dim || vector.length,
          row.embedding_text,
          row.embedding_blob && row.embedding_blob.byteLength > 0 ? row.embedding_blob : floatsToBlob(vector),
          row.source_updated_at || null,
          row.created_at || null,
          row.updated_at || null,
        );
        migrated++;
      }
    });
    tx();
    process.stdout.write(`\r迁移 ${migrated} rows`);
  }
  process.stdout.write(migrated > 0 ? "\n" : "");
  return migrated;
}

function countPendingRows(sourceDb: Database, vecPath: string, batchSize: number): number {
  if (vecPath !== ":memory:" && !existsSync(vecPath)) {
    return countRows(sourceDb, "memory_embeddings");
  }

  let vecDb: Database | undefined;
  try {
    vecDb = new Database(vecPath, { readonly: true, create: false });
    vecDb.exec("PRAGMA query_only = ON");
    if (!tableExists(vecDb, "memory_embeddings")) return countRows(sourceDb, "memory_embeddings");
    const hasVecRow = vecDb.prepare("SELECT 1 FROM memory_embeddings WHERE id = ? LIMIT 1");
    const select = sourceDb.prepare("SELECT id FROM memory_embeddings ORDER BY id LIMIT ? OFFSET ?");
    let pending = 0;
    for (let offset = 0;; offset += batchSize) {
      const rows = select.all(batchSize, offset) as Array<{ id: string }>;
      if (rows.length === 0) break;
      for (const row of rows) if (!hasVecRow.get(row.id)) pending++;
    }
    return pending;
  } catch {
    return countRows(sourceDb, "memory_embeddings");
  } finally {
    vecDb?.close();
  }
}

function readVecRowCount(vecPath: string): number {
  if (vecPath !== ":memory:" && !existsSync(vecPath)) return 0;
  let db: Database | undefined;
  try {
    db = new Database(vecPath, { readonly: true, create: false });
    db.exec("PRAGMA query_only = ON");
    return tableExists(db, "memory_embeddings") ? countRows(db, "memory_embeddings") : 0;
  } catch {
    return 0;
  } finally {
    db?.close();
  }
}

function tableExists(db: Database, name: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function countRows(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

function fileMB(path: string): number | null {
  if (path === ":memory:" || !existsSync(path)) return null;
  return Math.round((statSync(path).size / 1024 / 1024) * 10) / 10;
}

function resolveDbPath(path: string): string {
  return path === ":memory:" || path === "" ? ":memory:" : resolve(path);
}

function resolveVecDbPath(path: string | undefined, sourcePath: string): string {
  if (path) return resolveDbPath(path);
  if (sourcePath === ":memory:" || sourcePath === "") return ":memory:";
  return resolve(dirname(sourcePath), "xfeel.vec.db");
}
