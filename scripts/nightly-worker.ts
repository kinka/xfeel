import { getDB, closeDB } from "../packages/db/src/database";
import { initSchema } from "../packages/db/src/schema";
import { runDailyArchive } from "../packages/archive/src/daily";
import { buildMemoryProfile, type ProfileBuildMode } from "../packages/conversation/src/memory/profile-builder";
import { backupXfeelDb } from "./backup-db";

const DEFAULT_HOUR = 3;
const DEFAULT_MINUTE = 30;

const args = process.argv.slice(2);
const once = args.includes("--once");
const getArg = (name: string) => {
  const prefix = `--${name}=`;
  return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
};
const owner = getArg("owner") || getArg("owner_id") || getArg("user_id");
const hour = parseBoundedInt(getArg("hour"), 0, 23, DEFAULT_HOUR);
const minute = parseBoundedInt(getArg("minute"), 0, 59, DEFAULT_MINUTE);
const timezone = getArg("tz") || process.env.TZ || "Asia/Shanghai";

async function main() {
  const db = getDB();
  initSchema(db);

  if (once) {
    await runNightlyArchive();
    closeDB();
    return;
  }

  console.log(`[xfeel-nightly] started; schedule=${pad(hour)}:${pad(minute)} tz=${timezone}`);
  scheduleNextRun();
}

function scheduleNextRun() {
  const now = new Date();
  const next = nextLocalRunAt(now, hour, minute, timezone);
  const delay = Math.max(1000, next.getTime() - now.getTime());
  console.log(`[xfeel-nightly] next_run_at=${next.toISOString()} delay_ms=${delay}`);
  setTimeout(async () => {
    await runNightlyArchive().catch(error => {
      console.error("[xfeel-nightly] run failed", error);
    });
    scheduleNextRun();
  }, delay);
}

async function runNightlyArchive() {
  const date = previousLocalDate(new Date(), timezone);
  const startedAt = new Date().toISOString();
  console.log(`[xfeel-nightly] archive start date=${date} owner=${owner || "all"} at=${startedAt}`);
  const result = await runDailyArchive({ date, owner_id: owner });

  // 归档后重建“长期理解(L3)+近期状态(L2)”理解画像，让在线回复读最新快照。
  const profiledOwners = [...new Set(
    result.archives.filter(a => a.archive.status === "done" && a.archive.owner_id).map(a => a.archive.owner_id as string),
  )];
  // 定期更新默认走增量（只读上次水位线后的新日志，无新日志则跳过 L3），控成本；
  // 每周日做一次全量重建做基线校准，纠正增量合并可能的漂移。可用 --profile-mode 覆盖。
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  const profileMode: ProfileBuildMode = (getArg("profile-mode") as ProfileBuildMode)
    || (weekday === 0 ? "full" : "incremental");
  console.log(`[xfeel-nightly] profile mode=${profileMode}`);
  const profiles: Array<Record<string, unknown>> = [];
  for (const ownerId of profiledOwners) {
    try {
      const built = await buildMemoryProfile({ owner_id: ownerId, date, mode: profileMode });
      profiles.push({ owner_id: ownerId, ...built });
    } catch (error) {
      console.error(`[xfeel-nightly] profile build failed owner=${ownerId}`, error);
      profiles.push({ owner_id: ownerId, error: (error as Error).message });
    }
  }

  const finishedAt = new Date().toISOString();
  let backup: Record<string, unknown> | undefined;
  if (process.env.XFEEL_BACKUP_DISABLED !== "1") {
    try {
      const backedUp = backupXfeelDb();
      backup = {
        target: backedUp.target,
        bytes: backedUp.bytes,
        integrity: backedUp.integrity,
        tableCount: backedUp.tableCount,
        removed: backedUp.removed,
      };
      console.log(`[xfeel-nightly] db backup target=${backedUp.target} bytes=${backedUp.bytes}`);
    } catch (error) {
      backup = { error: (error as Error).message };
      console.error("[xfeel-nightly] db backup failed", error);
    }
  }
  console.log(JSON.stringify({ event: "xfeel-nightly-complete", date, owner: owner || "all", finished_at: finishedAt, result, profiles, backup }, null, 2));
}

function previousLocalDate(now: Date, tz: string): string {
  const parts = localDateParts(now, tz);
  const utcDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  utcDate.setUTCDate(utcDate.getUTCDate() - 1);
  return utcDate.toISOString().slice(0, 10);
}

function nextLocalRunAt(now: Date, targetHour: number, targetMinute: number, tz: string): Date {
  const parts = localDateParts(now, tz);
  let candidateLocal = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, targetHour, targetMinute, 0, 0));
  let candidate = zonedLocalToUtc(candidateLocal, tz);
  if (candidate.getTime() <= now.getTime()) {
    candidateLocal.setUTCDate(candidateLocal.getUTCDate() + 1);
    candidate = zonedLocalToUtc(candidateLocal, tz);
  }
  return candidate;
}

function zonedLocalToUtc(localAsUtc: Date, tz: string): Date {
  // Convert a desired wall-clock time in `tz` into an actual UTC Date using Intl offset probing.
  const offsetMs = timeZoneOffsetMs(localAsUtc, tz);
  return new Date(localAsUtc.getTime() - offsetMs);
}

function timeZoneOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value || 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - date.getTime();
}

function localDateParts(date: Date, tz: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function parseBoundedInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

process.on("SIGINT", () => {
  closeDB();
  process.exit(0);
});
process.on("SIGTERM", () => {
  closeDB();
  process.exit(0);
});

main().catch(error => {
  console.error("[xfeel-nightly] fatal", error);
  closeDB();
  process.exit(1);
});
