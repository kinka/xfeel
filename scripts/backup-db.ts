import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface DbBackupOptions {
  source?: string;
  targetDir?: string;
  retentionDays?: number;
  now?: Date;
}

export interface DbBackupResult {
  source: string;
  target: string;
  bytes: number;
  integrity: string;
  tableCount: number;
  removed: string[];
}

const DEFAULT_RETENTION_DAYS = 7;

export function backupXfeelDb(options: DbBackupOptions = {}): DbBackupResult {
  const source = resolve(options.source || process.env.XFEEL_DB_PATH || join(process.cwd(), "data", "xfeel.db"));
  if (!existsSync(source)) {
    throw new Error(`database not found: ${source}`);
  }

  const targetDir = resolve(options.targetDir || defaultBackupDir());
  mkdirSync(targetDir, { recursive: true });

  const target = join(targetDir, `xfeel-${timestamp(options.now || new Date())}.db`);
  runSqlite(source, `.backup '${sqliteQuotePath(target)}'`);

  const integrity = lastOutputLine(runSqlite(target, "pragma journal_mode=delete; pragma integrity_check;"));
  if (integrity !== "ok") {
    throw new Error(`backup integrity_check failed: ${integrity}`);
  }

  const tableCount = Number(runSqlite(target, "select count(*) from sqlite_master where type='table';").trim());
  cleanupSidecars(target);
  const bytes = statSync(target).size;
  const removed = pruneBackups(targetDir, options.retentionDays ?? DEFAULT_RETENTION_DAYS, options.now || new Date());

  return { source, target, bytes, integrity, tableCount, removed };
}

function defaultBackupDir(): string {
  return process.env.XFEEL_BACKUP_DIR
    || join(homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs", "Xfeel", "backups");
}

function runSqlite(dbPath: string, sql: string): string {
  const result = spawnSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `sqlite3 exited with ${result.status}`).trim());
  }
  return result.stdout;
}

function lastOutputLine(output: string): string {
  return output.trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
}

function sqliteQuotePath(path: string): string {
  return path.replace(/'/g, "''");
}

function timestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.TZ || "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}${byType.month}${byType.day}-${byType.hour}${byType.minute}${byType.second}`;
}

function pruneBackups(targetDir: string, retentionDays: number, now: Date): string[] {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) return [];
  const cutoff = timestamp(new Date(now.getTime() - Math.floor(retentionDays) * 86_400_000));
  const backups = readdirSync(targetDir)
    .filter(name => /^xfeel-\d{8}-\d{6}\.db$/.test(name))
    .sort()
    .map(name => join(targetDir, name));
  const stale = backups.filter(path => backupStamp(path) < cutoff);
  for (const path of stale) {
    cleanupSidecars(path);
    unlinkSync(path);
  }
  return stale;
}

function cleanupSidecars(dbPath: string) {
  for (const suffix of ["-wal", "-shm"]) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
}

function backupStamp(path: string): string {
  return path.match(/xfeel-(\d{8}-\d{6})\.db$/)?.[1] || "";
}

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(arg => arg.startsWith(prefix))?.slice(prefix.length);
}

if (import.meta.main) {
  const retentionDaysArg = getArg("retention-days");
  const result = backupXfeelDb({
    source: getArg("source"),
    targetDir: getArg("target-dir"),
    retentionDays: retentionDaysArg ? Number(retentionDaysArg) : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
}
