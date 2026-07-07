#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { closeEmbeddingDB, getEmbeddingDB } from "../packages/db/src/database";
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  buildEmbeddingUnits,
  loadEvents,
  upsertEmbeddingsForEvents,
} from "./embedding-common";

interface Args {
  db: string;
  vecDb?: string;
  model: string;
  baseUrl: string;
  limit?: number;
  batchSize: number;
  reset: boolean;
  dryRun: boolean;
}

const args = parseArgs(process.argv.slice(2));
const dbPath = resolveDbPath(args.db);
const vecDbPath = resolveVecDbPath(args.vecDb, dbPath);
const mainDb = new Database(dbPath, { readonly: true, create: false });

try {
  mainDb.exec("PRAGMA query_only = ON");
  const events = loadEvents(mainDb, args.limit);
  const units = events.flatMap(buildEmbeddingUnits);
  const existing = args.reset ? new Set<string>() : readExistingEmbeddingIds(vecDbPath, args.model);
  const pending = args.reset ? units : units.filter(unit => !existing.has(unit.id));

  console.log(JSON.stringify({
    db: dbPath,
    vec_db: vecDbPath,
    model: args.model,
    base_url: args.baseUrl,
    events: events.length,
    units: units.length,
    pending: pending.length,
    reset: args.reset,
    dry_run: args.dryRun,
  }, null, 2));

  if (!args.dryRun && pending.length > 0) {
    const vecDb = getEmbeddingDB(vecDbPath);
    if (args.reset) {
      vecDb.prepare("DELETE FROM memory_embeddings WHERE embedding_model = ?").run(args.model);
    }

    const started = Date.now();
    const result = await upsertEmbeddingsForEvents(vecDb, events, {
      model: args.model,
      baseUrl: args.baseUrl,
      batchSize: args.batchSize,
      reset: false,
    });
    const count = vecDb.prepare("SELECT COUNT(*) as c FROM memory_embeddings WHERE embedding_model = ?").get(args.model) as { c: number };
    console.log(JSON.stringify({
      done: true,
      written: result.written,
      pending: result.pending,
      total_model_rows: count.c,
      elapsed_ms: Date.now() - started,
    }, null, 2));
  }
} finally {
  mainDb.close();
  closeEmbeddingDB();
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: process.env.XFEEL_DB_PATH || "data/xfeel.db",
    vecDb: process.env.XFEEL_VEC_DB_PATH,
    model: DEFAULT_EMBEDDING_MODEL,
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
    batchSize: 32,
    reset: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i] || "";
    if (arg === "--db") args.db = next();
    else if (arg === "--vec-db") args.vecDb = next();
    else if (arg === "--model") args.model = next();
    else if (arg === "--base-url") args.baseUrl = next();
    else if (arg === "--limit") args.limit = Number(next());
    else if (arg === "--batch-size") args.batchSize = Number(next());
    else if (arg === "--reset") args.reset = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else throw new Error(`Unknown arg: ${arg}`);
  }
  return args;
}

function resolveDbPath(path: string): string {
  return path === ":memory:" || path === "" ? ":memory:" : resolve(path);
}

function resolveVecDbPath(path: string | undefined, mainDbPath: string): string {
  if (path) return resolveDbPath(path);
  if (mainDbPath === ":memory:" || mainDbPath === "") return ":memory:";
  return resolve(dirname(mainDbPath), "xfeel.vec.db");
}

function readExistingEmbeddingIds(vecDbPath: string, model: string): Set<string> {
  if (vecDbPath !== ":memory:" && !existsSync(vecDbPath)) return new Set();
  try {
    const db = new Database(vecDbPath, { readonly: true, create: false });
    try {
      db.exec("PRAGMA query_only = ON");
      if (!tableExists(db, "memory_embeddings")) return new Set();
      return new Set((db.prepare("SELECT id FROM memory_embeddings WHERE embedding_model = ?").all(model) as Array<{ id: string }>).map(row => row.id));
    } finally {
      db.close();
    }
  } catch (error) {
    console.warn("[build-memory-embeddings] vec db unavailable for existing-row check:", error instanceof Error ? error.message : String(error));
    return new Set();
  }
}

function tableExists(db: Database, name: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}
