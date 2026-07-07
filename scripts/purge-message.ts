/**
 * 干净删除错误记录——以 pipeline message_id 为单位，连带清掉它在所有表里的痕迹
 * （memory_events + FTS、entity_events、open_facts、causal_chains、向量、
 *  pipeline_status、conversation_turns 含助手回复气泡）。
 *
 * 怎么拿 message_id：
 *   - 面板/卡片上的 “msg xxxxxxxx” 短码，或 memory_events.raw_message_id，
 *     或 conversation_turns.metadata.pipeline_message_id。
 *
 * 用法：
 *   DRY_RUN=1 bun run scripts/purge-message.ts <msgId> [msgId...]   # 仅预览将删什么
 *   bun run scripts/purge-message.ts <msgId> [msgId...]             # 实际删除
 *   OWNER=gWbuJBlAKI bun run scripts/purge-message.ts <msgId>       # 限定 owner（可选）
 *
 * 短码（如 40c8f681）也支持：会按前缀解析为完整 message_id。
 */
import { getDB } from "../packages/db/src/database";
import { planPurge, purgeMessage } from "../packages/db/src/purge";

const DRY = process.env.DRY_RUN === "1";
const OWNER = process.env.OWNER || undefined;
const args = process.argv.slice(2).filter(a => !a.startsWith("-"));

if (args.length === 0) {
  console.error("用法：DRY_RUN=1 bun run scripts/purge-message.ts <messageId> [messageId...]");
  process.exit(1);
}

function resolveId(db: ReturnType<typeof getDB>, raw: string): string | null {
  // 已是完整 id？直接用。
  const exact = db.query("SELECT 1 FROM memory_events WHERE raw_message_id = ? LIMIT 1").get(raw)
    || db.query("SELECT 1 FROM pipeline_status WHERE message_id = ? LIMIT 1").get(raw)
    || db.query("SELECT 1 FROM conversation_turns WHERE id = ? OR json_extract(metadata,'$.pipeline_message_id') = ? LIMIT 1").get(raw, raw);
  if (exact) return raw;
  // 按前缀（短码）解析
  const hits = new Set<string>();
  for (const r of db.query("SELECT DISTINCT raw_message_id AS id FROM memory_events WHERE raw_message_id LIKE ?").all(`${raw}%`) as Array<{ id: string }>) hits.add(r.id);
  for (const r of db.query("SELECT DISTINCT message_id AS id FROM pipeline_status WHERE message_id LIKE ?").all(`${raw}%`) as Array<{ id: string }>) hits.add(r.id);
  if (hits.size === 1) return [...hits][0];
  if (hits.size > 1) {
    console.error(`短码 ${raw} 命中多条：${[...hits].join(", ")}，请用完整 id`);
    return null;
  }
  return null;
}

const db = getDB();
console.log(`目标库：${db.filename}  ${DRY ? "(DRY RUN — 不会改动)" : ""}\n`);

let failed = false;
for (const raw of args) {
  const id = resolveId(db, raw);
  if (!id) {
    console.error(`✗ 未找到记录：${raw}`);
    failed = true;
    continue;
  }
  const plan = DRY
    ? planPurge(id, { ownerId: OWNER })
    : purgeMessage(id, { ownerId: OWNER });

  console.log(`${DRY ? "将删除" : "已删除"}  msg=${id.slice(0, 8)}`);
  console.log(`  事件 id：${plan.eventIds.map(e => e.slice(0, 8)).join(", ") || "(无)"}`);
  console.log(`  会话 turn：${plan.turnIds.map(t => t.slice(0, 8)).join(", ") || "(无)"}`);
  for (const [table, n] of Object.entries(plan.counts)) {
    if (n > 0) console.log(`    ${table}: ${n}`);
  }
  console.log("");
}

if (failed) process.exit(1);
console.log(DRY ? "预览结束。去掉 DRY_RUN=1 即执行。" : "完成。");
