/**
 * 存量清理：移除 open_facts 两段 legacy 噪声派生留下的存量 fact，并同步重建
 * memory_events.open_facts JSON、canonical_search_text 与 FTS，避免表/全文索引失配。
 *
 * 噪声签名（与 deriveOpenFactsFromLegacy 已删除的两段一一对应、且无角色以保护真·LLM fact）：
 *   - kind=topic         且 value=surface 且 conf≈0.55  ← entities→topic 倾倒
 *   - kind=emotion_signal 且 value=surface 且 conf≈0.70  ← emotion.primary 复制
 *
 * 用法：
 *   只读预演： XFEEL_DB_PATH=data/xfeel.db bun run scripts/cleanup-legacy-open-facts.ts --dry
 *   实际写入： XFEEL_DB_PATH=/tmp/xfeel-copy.db bun run scripts/cleanup-legacy-open-facts.ts
 * 写库前务必先备份（脚本不自动备份）。
 */
import { getDB } from "../packages/db/src/database";
import { buildCanonicalSearchText } from "../packages/domain/src/search-text";
import { rebuildMemoryEventsFts } from "../packages/db/src/schema";

const DRY = process.argv.includes("--dry") || process.env.DRY === "1";

const round2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const noRoles = (f: Record<string, unknown>) => !f.actor_id && !f.experiencer_id && !f.observer_id;

function isNoise(f: Record<string, unknown>): boolean {
  if (!f || typeof f !== "object") return false;
  if (f.value !== f.surface) return false;
  if (!noRoles(f)) return false;
  const c = round2(f.confidence);
  if (f.kind === "topic" && c === 0.55) return true;
  if (f.kind === "emotion_signal" && c === 0.70) return true;
  return false;
}

const parseArr = (s: unknown): string[] => {
  try { const v = JSON.parse((s as string) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
};

const db = getDB();
console.log(`DB: ${db.filename}  ${DRY ? "(DRY — 只读预演)" : "(WRITE — 实际写入)"}`);

const rows = db.prepare(`
  SELECT id, summary, original_text, event_type, entities, tags, emotion, location, open_facts, user_id
  FROM memory_events
`).all() as Array<Record<string, string | null>>;

const updateStmt = db.prepare(
  `UPDATE memory_events SET open_facts=?, canonical_search_text=?, updated_at=datetime('now') WHERE id=?`
);
const deleteFactStmt = db.prepare(`
  DELETE FROM memory_open_facts
  WHERE event_id=? AND value=surface
    AND (actor_id IS NULL OR actor_id='')
    AND (experiencer_id IS NULL OR experiencer_id='')
    AND (observer_id IS NULL OR observer_id='')
    AND ((kind='topic' AND ROUND(confidence,2)=0.55) OR (kind='emotion_signal' AND ROUND(confidence,2)=0.70))
`);

let scanned = 0, modified = 0, removedFacts = 0;
const removedByKind: Record<string, number> = {};

const run = db.transaction(() => {
  for (const row of rows) {
    scanned++;
    let facts: Array<Record<string, unknown>>;
    try { facts = JSON.parse(row.open_facts || "[]"); } catch { continue; }
    if (!Array.isArray(facts) || facts.length === 0) continue;

    const clean = facts.filter(f => {
      if (isNoise(f)) {
        removedFacts++;
        removedByKind[String(f.kind)] = (removedByKind[String(f.kind)] || 0) + 1;
        return false;
      }
      return true;
    });
    if (clean.length === facts.length) continue;
    modified++;
    if (DRY) continue;

    let emotion: Record<string, unknown> = {};
    try { emotion = JSON.parse(row.emotion || "{}"); } catch { /* keep {} */ }

    const cst = buildCanonicalSearchText({
      summary: row.summary || undefined,
      original_text: row.original_text || undefined,
      event_type: row.event_type || undefined,
      entities: parseArr(row.entities),
      tags: parseArr(row.tags),
      emotion: emotion as { primary?: string; secondary?: string; valence?: string },
      location: row.location || undefined,
      open_facts: clean as never,
      user_id: row.user_id || undefined,
    });

    updateStmt.run(JSON.stringify(clean), cst, row.id!);
    deleteFactStmt.run(row.id!);
  }
});
run();

if (!DRY && modified > 0) {
  const fts = rebuildMemoryEventsFts(db);
  console.log(`FTS 重建：events=${fts.eventCount} fts=${fts.ftsCount} tokenizer=${fts.tokenizer}`);
}

console.log({ scanned, modified, removedFacts, removedByKind });
