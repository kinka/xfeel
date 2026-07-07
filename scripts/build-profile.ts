/**
 * 手动重建某个 owner 的长期理解(L3)+近期状态(L2)理解画像，并打印结果。
 *
 * 用法：
 *   bun run scripts/build-profile.ts --owner=demo-dad-owner [--date=2026-06-18]
 *   XFEEL_DB_PATH=/tmp/xfeel-replay.db bun run scripts/build-profile.ts --owner=demo-dad-owner
 *   不带 --owner 时，对所有有归档的 owner 重建。
 */
import { getDB, closeDB } from "../packages/db/src/database";
import { initSchema } from "../packages/db/src/schema";
import { normalizeLocalDate } from "../packages/domain/src/local-date";
import { resolveOwnerLabel } from "../packages/domain/src/owner";
import { buildMemoryProfile } from "../packages/conversation/src/memory/profile-builder";
import { getLongTermProfile, getRecentProfile } from "../packages/conversation/src/memory/profile-repository";

const args = process.argv.slice(2);
const getArg = (name: string) => {
  const prefix = `--${name}=`;
  return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
};

async function main() {
  const db = getDB();
  initSchema(db);
  const date = normalizeLocalDate(getArg("date"));
  const owner = getArg("owner") || getArg("owner_id");
  const owners = owner ? [owner] : ownersWithArchives(date);
  if (owners.length === 0) {
    console.log("没有可归纳的 owner（缺少 daily_archives）。");
    closeDB();
    return;
  }

  // 手动脚本默认 full（基线校准）；加 --incremental 走增量（只读上次水位线后的新日志）。
  const mode = args.includes("--incremental") ? "incremental" as const : "full" as const;
  console.log(`库：${db.filename}  日期：${date}  模式：${mode}\n${"=".repeat(64)}`);
  for (const ownerId of owners) {
    const label = resolveOwnerLabel(ownerId) || ownerId;
    console.log(`\n▶ 归纳 ${label} (${ownerId})`);
    const result = await buildMemoryProfile({ owner_id: ownerId, date, mode });
    console.log(`  近期(L2): built=${result.recent.built}${result.recent.reason ? ` (${result.recent.reason})` : ""}`);
    console.log(`  长期(L3): built=${result.longTerm.built} mode=${result.longTerm.mode ?? mode} understandings=${result.longTerm.understandings ?? 0}${result.longTerm.reason ? ` (${result.longTerm.reason})` : ""}`);

    const recent = getRecentProfile(ownerId);
    if (recent?.content?.stateSummary) {
      console.log(`\n  【近期状态】\n  ${recent.content.stateSummary}`);
      if (recent.content.emotionalTrend) console.log(`  情绪走向：${recent.content.emotionalTrend}`);
      for (const t of recent.content.openThreads || []) console.log(`  · 仍在关注：${t.topic}`);
    }
    const lt = getLongTermProfile(ownerId);
    if (lt?.content) {
      if (lt.content.narrative) console.log(`\n  【长期画像】\n  ${lt.content.narrative}`);
      for (const u of lt.content.understandings || []) {
        console.log(`  · [${u.category}/${u.kind} c=${u.confidence}] ${u.subject}: ${u.statement}  ⟵ ${u.supportDates.join(",")}`);
      }
      for (const q of lt.content.openQuestions || []) console.log(`  ? 想了解：${q.topic}（${q.why}）`);
      if (lt.content.addressBook?.length) {
        console.log(`  称呼：${lt.content.addressBook.map(a => `${a.member}→${a.preferredAddress}`).join("，")}`);
      }
    }
  }
  console.log(`\n${"=".repeat(64)}\n完成。`);
  closeDB();
}

function ownersWithArchives(date: string): string[] {
  const rows = getDB().prepare(`
    SELECT DISTINCT owner_id FROM daily_archives
    WHERE owner_id IS NOT NULL AND status = 'done' AND archive_date <= ?
    ORDER BY owner_id ASC
  `).all(date) as Array<{ owner_id: string }>;
  return rows.map(r => r.owner_id);
}

main().catch(e => { console.error("归纳失败：", e); closeDB(); process.exit(1); });
