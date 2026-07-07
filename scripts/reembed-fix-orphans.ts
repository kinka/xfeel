/**
 * 修复 embedding 向量库与当前事件状态的不一致：
 *  1) 删除孤儿向量：id 不再对应任何现存 unit（历史重抽取/清理累积的陈旧 fact/entity 向量，污染语义召回）
 *  2) 重嵌入 :event 文本已过时的事件：canonical/summary 等变化导致 event 单元向量陈旧
 *
 * embedding 存于独立的 vec 库（data/xfeel.vec.db）。upsert 只覆盖同 id、不回收孤儿，故需显式删除。
 *
 * 用法：
 *   预演： bun run scripts/reembed-fix-orphans.ts --dry
 *   执行： bun run scripts/reembed-fix-orphans.ts          (需 ollama + 嵌入模型；务必先备份 vec 库)
 */
import { Database } from "bun:sqlite";
import { getEmbeddingDB } from "../packages/db/src/database";
import { loadEvents, buildEmbeddingUnits, upsertEmbeddingsForEvents, DEFAULT_EMBEDDING_MODEL } from "./embedding-common";

const DRY = process.argv.includes("--dry");
// 重嵌入陈旧 :event 文本默认关闭：被移除的 canonical 噪声(entity/emotion)在 embedding_text
// 的 entities:/emotion: 行已覆盖，重嵌入向量几乎不变、价值低。需要时显式 --reembed-stale。
const REEMBED_STALE = process.argv.includes("--reembed-stale");
const MODEL = process.env.XFEEL_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
const MAIN = process.env.XFEEL_DB_PATH || "data/xfeel.db";
const VEC = process.env.XFEEL_VEC_DB_PATH || "data/xfeel.vec.db";

const main = new Database(MAIN, { readonly: true });
const events = loadEvents(main);

const validIds = new Set<string>();
const freshEventText = new Map<string, string>();
for (const e of events) {
  const units = buildEmbeddingUnits(e);
  for (const u of units) validIds.add(u.id);
  const ev = units.find(u => u.target_type === "event");
  if (ev && e.id) freshEventText.set(e.id, ev.embedding_text);
}
main.close();

const vecRead = new Database(VEC, { readonly: true });
const rows = vecRead.prepare(
  "SELECT id, target_id, target_type, embedding_text FROM memory_embeddings WHERE embedding_model = ?"
).all(MODEL) as Array<{ id: string; target_id: string; target_type: string; embedding_text: string }>;
vecRead.close();

const orphanIds = rows.filter(r => !validIds.has(r.id)).map(r => r.id);
const staleEventTargets = new Set<string>();
for (const r of rows) {
  if (r.target_type === "event" && validIds.has(r.id)) {
    const fresh = freshEventText.get(r.target_id);
    if (fresh !== undefined && fresh !== r.embedding_text) staleEventTargets.add(r.target_id);
  }
}

console.log(JSON.stringify({
  model: MODEL, vec_rows: rows.length, valid_ids: validIds.size,
  orphan_to_delete: orphanIds.length, stale_event_units: staleEventTargets.size, dry: DRY,
}, null, 2));

if (DRY) process.exit(0);

const vec = getEmbeddingDB(VEC);
const delStmt = vec.prepare("DELETE FROM memory_embeddings WHERE id = ? AND embedding_model = ?");
const delTx = vec.transaction((ids: string[]) => { for (const id of ids) delStmt.run(id, MODEL); });
delTx(orphanIds);
console.log(`已删除孤儿向量: ${orphanIds.length}`);

const staleEvents = REEMBED_STALE ? events.filter(e => e.id && staleEventTargets.has(e.id)) : [];
if (!REEMBED_STALE && staleEventTargets.size > 0) {
  console.log(`跳过重嵌入 ${staleEventTargets.size} 个陈旧 :event 单元（低价值，--reembed-stale 可开启）`);
}
if (staleEvents.length > 0) {
  const res = await upsertEmbeddingsForEvents(vec, staleEvents, { model: MODEL, reset: true, batchSize: 32 });
  console.log(JSON.stringify({ reembedded_events: staleEvents.length, units: res.units, written: res.written, pending: res.pending }, null, 2));
}
