/**
 * 用 LLM 一次性复核某个 owner 某年的原始日记。
 * 默认只审核并输出 JSON；显式传 --apply 才写库并重建快照。
 *
 * 用法：
 *   bun run scripts/backfill-legacy-milestones.ts --owner=<id> --year=2024
 *   bun run scripts/backfill-legacy-milestones.ts --owner=<id> --year=2024 --apply
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { getLLM } from "../packages/ai-client/src/llm";
import { roleLLMConfig } from "../packages/ai-client/src/roles";
import { getDB, closeDB } from "../packages/db/src/database";
import { getMilestones } from "../packages/analyzer/src/milestone-curation";

export const REVIEW_VERSION = "legacy-milestone-llm-v1";

export interface ReviewRow {
  diaryId: string;
  eventId: string;
  diaryDate: string;
  content: string;
}

interface Pick { i?: number; title?: string; person?: string; reason?: string }
interface Selection extends Pick { diaryId: string; eventId: string; diaryDate: string }

export function loadReviewRows(db: Database, ownerId: string, year: string): ReviewRow[] {
  return (db.prepare(`
    SELECT d.id AS diary_id, d.diary_date, d.content,
      (
        SELECT e.id FROM memory_events e
        WHERE e.raw_message_id = d.id AND e.user_id = d.user_id AND e.source_layer != 'structured'
        ORDER BY CASE WHEN e.id LIKE 'diary:%:rule:%' THEN 0 ELSE 1 END, e.created_at DESC, e.id
        LIMIT 1
      ) AS event_id
    FROM diaries d
    WHERE d.user_id = ? AND substr(d.diary_date, 1, 4) = ?
    ORDER BY d.diary_date, d.id
  `).all(ownerId, year) as Array<{ diary_id: string; event_id: string | null; diary_date: string; content: string }>)
    .filter((row): row is { diary_id: string; event_id: string; diary_date: string; content: string } => Boolean(row.event_id))
    .map(row => ({ diaryId: row.diary_id, eventId: row.event_id, diaryDate: row.diary_date, content: row.content }));
}

export function applyReviewDecisions(
  db: Database,
  ownerId: string,
  year: string,
  selectedEventIds: Iterable<string>,
): { promoted: number; demoted: number } {
  const selected = new Set(selectedEventIds);
  const reviewed = db.prepare(`
    SELECT id FROM memory_events
    WHERE user_id = ? AND substr(event_date, 1, 4) = ? AND extractor_version = ?
  `).all(ownerId, year, REVIEW_VERSION) as Array<{ id: string }>;
  const promote = db.prepare(`
    UPDATE memory_events
    SET event_type = 'milestone', extractor_version = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `);
  const demote = db.prepare(`
    UPDATE memory_events
    SET event_type = 'other', extractor_version = 'legacy', updated_at = datetime('now')
    WHERE id = ? AND user_id = ? AND extractor_version = ?
  `);
  return db.transaction(() => {
    let promoted = 0;
    let demoted = 0;
    for (const row of reviewed) {
      if (!selected.has(row.id)) demoted += Number(demote.run(row.id, ownerId, REVIEW_VERSION).changes > 0);
    }
    for (const eventId of selected) promoted += Number(promote.run(REVIEW_VERSION, eventId, ownerId).changes > 0);
    return { promoted, demoted };
  })();
}

async function main() {
  const ownerId = arg("owner");
  const year = arg("year") || "2024";
  const apply = process.argv.includes("--apply");
  if (!ownerId || !/^\d{4}$/.test(year)) throw new Error("usage: --owner=<id> --year=YYYY [--apply] [--output=path]");

  const db = getDB();
  const rows = loadReviewRows(db, ownerId, year);
  const llm = getLLM(roleLLMConfig("extract"));
  const selections: Selection[] = [];
  const batchSize = 30;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const prompt = batch.map((row, i) =>
      `${i}. [${row.diaryDate.slice(0, 10)}] ${row.content.replace(/\s+/g, " ").slice(0, 900)}`,
    ).join("\n");
    const result = await llm.chatJSON<{ milestones?: Pick[] }>(prompt, REVIEW_SYSTEM);
    for (const item of result.milestones || []) {
      if (!Number.isInteger(item.i) || item.i! < 0 || item.i! >= batch.length || !item.title?.trim()) continue;
      const row = batch[item.i!]!;
      selections.push({ ...item, diaryId: row.diaryId, eventId: row.eventId, diaryDate: row.diaryDate });
    }
    console.log(`[${Math.min(start + batchSize, rows.length)}/${rows.length}] selected_events=${new Set(selections.map(item => item.eventId)).size}`);
  }

  const uniqueEventIds = new Set(selections.map(item => item.eventId));
  const outputPath = resolve(arg("output") || `data/reviews/milestones-${safe(ownerId)}-${year}-${Date.now()}.json`);
  mkdirSync(dirname(outputPath), { recursive: true });
  const report = { ownerId, year, reviewed: rows.length, selectedEvents: uniqueEventIds.size, apply, selections };
  await Bun.write(outputPath, JSON.stringify(report, null, 2));
  console.log(`review_report=${outputPath}`);

  if (!apply) {
    console.log("dry_run=true; pass --apply after reviewing the JSON report");
    closeDB();
    return;
  }
  const changes = applyReviewDecisions(db, ownerId, year, uniqueEventIds);
  console.log(`promoted=${changes.promoted} demoted=${changes.demoted}`);
  const snapshot = await getMilestones(ownerId, { rebuild: true });
  console.log(`snapshot_items=${snapshot.items.length} curated=${snapshot.curated}`);
  closeDB();
}

const REVIEW_SYSTEM = [
  "你是家庭记忆产品的数据策展员。请从原始日记中找出真正的家庭成长里程碑或明确人生节点，只输出 JSON。",
  "入选：孩子首次或明确学会某能力、重要成长突破、出生入园毕业等人生节点；成年人的首次住院等明确人生节点也可入选。",
  "即使没有‘第一次/学会’字样，只要语义明确表示能力首次出现或显著达成，也应入选。",
  "排除：仍在练习、尚未成功、普通日常、纯情绪、工作进展、购物、泛泛感慨，以及无法确定已经达成的猜测。",
  "同一条可包含多个人或多个不同节点；title 要写清人物和达成内容，不要编造名字。",
  '输出格式：{"milestones":[{"i":输入序号,"title":"8-24字标题","person":"原文人物称呼","reason":"简短依据"}]}。没有则返回空数组。',
].join("\n");

function arg(name: string): string {
  return process.argv.slice(2).find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || "";
}

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

if (import.meta.main) await main();
