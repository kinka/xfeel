/**
 * 日终归档脚本
 *
 * 用法：
 *   bun run scripts/daily-archive.ts
 *   bun run scripts/daily-archive.ts --date=2026-05-12 --owner=demo-dad-owner
 *   bun run scripts/daily-archive.ts --dry-run
 */

import { getDB, closeDB } from "../packages/db/src/database";
import { initSchema } from "../packages/db/src/schema";
import { runDailyArchive } from "../packages/archive/src/daily";
import { writeRollingWeeklyContext } from "../packages/conversation/src/session-context";

const args = process.argv.slice(2);
const getArg = (name: string) => {
  const prefix = `--${name}=`;
  return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
};

const date = getArg("date");
const owner = getArg("owner") || getArg("owner_id") || getArg("user_id");
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");
const weeklyOnly = args.includes("--weekly-context-only");

async function main() {
  const db = getDB();
  initSchema(db);

  if (weeklyOnly) {
    const weekly = writeRollingWeeklyContext({ owner_id: owner, date });
    console.log(JSON.stringify({ weekly_context: weekly }, null, 2));
    closeDB();
    return;
  }

  const result = await runDailyArchive({
    date,
    owner_id: owner,
    force,
    dry_run: dryRun,
  });

  console.log(JSON.stringify(result, null, 2));
  closeDB();
}

main().catch(error => {
  console.error(error);
  closeDB();
  process.exit(1);
});
