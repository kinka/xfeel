import type { Database } from "bun:sqlite";
import { getDB, getEmbeddingDB } from "./database";
import { countMediaForTurns, deleteMediaForTurns } from "./media-assets";

/**
 * 干净删除一条「记录」——以 pipeline message_id 为单位，连带清掉它散落在各表的所有痕迹：
 *   memory_events（+ FTS 经触发器自动同步）、entity_events、memory_open_facts、
 *   causal_chains、向量库 memory_embeddings、pipeline_status、
 *   以及对应的 conversation_turns（日记 turn + 紧随其后的助手回复气泡）。
 *
 * 设计原则：只删硬关联得到的行；助手回复在 log 流里没有外键，按「同 owner、
 * 紧跟该 user turn 且早于下一条 user turn 的 assistant turn」定位。dryRun 会把
 * 每张表将删的行数与命中 id 全部列出，确认无误再执行。
 *
 * 用法见 scripts/purge-message.ts。
 */
export interface PurgePlan {
  messageId: string;
  eventIds: string[];
  turnIds: string[];
  counts: {
    memory_events: number;
    entity_events: number;
    memory_open_facts: number;
    causal_chains: number;
    memory_embeddings: number;
    pipeline_status: number;
    conversation_turns: number;
    media_assets: number;
  };
}

function planMessage(db: Database, vec: Database, messageId: string, ownerId?: string | null): PurgePlan {
  const ownerFilter = ownerId ? " AND COALESCE(user_id,'') = COALESCE(@owner,'')" : "";
  const eventIds = (db
    .query(`SELECT id FROM memory_events WHERE raw_message_id = @msg${ownerFilter}`)
    .all({ "@msg": messageId, "@owner": ownerId ?? null }) as Array<{ id: string }>).map(r => r.id);

  // conversation_turns：日记/playground turn（id == messageId）或 log 流 user turn（metadata 链接）
  const ownerTurns = (db
    .query(
      `SELECT id, owner_id, role, created_at FROM conversation_turns
       WHERE id = @msg OR json_extract(metadata,'$.pipeline_message_id') = @msg`,
    )
    .all({ "@msg": messageId }) as Array<{ id: string; owner_id: string; role: string; created_at: string }>);

  const turnIds = new Set<string>(ownerTurns.map(t => t.id));

  // 紧跟每条 user turn 的助手回复气泡（log 流里无外键，靠时序定位）
  for (const t of ownerTurns) {
    if (t.role !== "user") continue;
    const nextUser = db
      .query(
        `SELECT created_at FROM conversation_turns
         WHERE owner_id = @owner AND role='user' AND created_at > @ts
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get({ "@owner": t.owner_id, "@ts": t.created_at }) as { created_at: string } | undefined;
    const replies = (db
      .query(
        `SELECT id FROM conversation_turns
         WHERE owner_id = @owner AND role='assistant' AND created_at > @ts
           ${nextUser ? "AND created_at < @next" : ""}`,
      )
      .all({ "@owner": t.owner_id, "@ts": t.created_at, "@next": nextUser?.created_at ?? "" }) as Array<{ id: string }>);
    for (const r of replies) turnIds.add(r.id);
  }

  const countIn = (table: string, col: string, ids: string[]): number => {
    if (ids.length === 0) return 0;
    const ph = ids.map(() => "?").join(",");
    return (db.query(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} IN (${ph})`).get(...ids) as { c: number }).c;
  };
  const embeddings = eventIds.length === 0
    ? 0
    : (vec.query(
        `SELECT COUNT(*) AS c FROM memory_embeddings WHERE target_id IN (${eventIds.map(() => "?").join(",")})`,
      ).get(...eventIds) as { c: number }).c;

  return {
    messageId,
    eventIds,
    turnIds: [...turnIds],
    counts: {
      memory_events: eventIds.length,
      entity_events: countIn("entity_events", "event_id", eventIds),
      memory_open_facts: countIn("memory_open_facts", "event_id", eventIds),
      causal_chains: eventIds.length === 0 ? 0 : (db.query(
        `SELECT COUNT(*) AS c FROM causal_chains WHERE cause_event_id IN (${eventIds.map(() => "?").join(",")}) OR effect_event_id IN (${eventIds.map(() => "?").join(",")})`,
      ).get(...eventIds, ...eventIds) as { c: number }).c,
      memory_embeddings: embeddings,
      pipeline_status: (db.query("SELECT COUNT(*) AS c FROM pipeline_status WHERE message_id = ?").get(messageId) as { c: number }).c,
      conversation_turns: turnIds.size,
      media_assets: countMediaForTurns([...turnIds], db),
    },
  };
}

/**
 * 计算删除计划但不执行——用于 dry-run 预览。
 */
export function planPurge(messageId: string, opts: { ownerId?: string | null; db?: Database; vec?: Database } = {}): PurgePlan {
  return planMessage(opts.db ?? getDB(), opts.vec ?? getEmbeddingDB(), messageId, opts.ownerId ?? null);
}

/**
 * 干净删除一条记录的全部痕迹，事务内完成。返回实际删除计划。
 */
export function purgeMessage(messageId: string, opts: { ownerId?: string | null; db?: Database; vec?: Database } = {}): PurgePlan {
  const db = opts.db ?? getDB();
  const vec = opts.vec ?? getEmbeddingDB();
  const plan = planMessage(db, vec, messageId, opts.ownerId ?? null);
  const { eventIds, turnIds } = plan;

  const runIn = (q: ReturnType<Database["query"]>, ids: string[]) => {
    if (ids.length) q.run(...ids);
  };

  db.transaction(() => {
    if (eventIds.length) {
      const ph = eventIds.map(() => "?").join(",");
      runIn(db.query(`DELETE FROM causal_chains WHERE cause_event_id IN (${ph}) OR effect_event_id IN (${eventIds.map(() => "?").join(",")})`), [...eventIds, ...eventIds]);
      runIn(db.query(`DELETE FROM entity_events WHERE event_id IN (${ph})`), eventIds);
      runIn(db.query(`DELETE FROM memory_open_facts WHERE event_id IN (${ph})`), eventIds);
      runIn(db.query(`DELETE FROM memory_events WHERE id IN (${ph})`), eventIds); // FTS 经触发器自动同步
    }
    db.query("DELETE FROM pipeline_status WHERE message_id = ?").run(messageId);
    if (turnIds.length) {
      runIn(db.query(`DELETE FROM conversation_turns WHERE id IN (${turnIds.map(() => "?").join(",")})`), turnIds);
    }
  })();

  // 向量库是独立连接，单独删
  if (eventIds.length) {
    try {
      vec.query(`DELETE FROM memory_embeddings WHERE target_id IN (${eventIds.map(() => "?").join(",")})`).run(...eventIds);
    } catch (e) {
      console.warn("跳过向量删除：", e instanceof Error ? e.message : String(e));
    }
  }

  // 关联媒体（按 turn id 关联）：删行 + 清理无人共用的落地文件
  if (turnIds.length) {
    try {
      deleteMediaForTurns(turnIds, db);
    } catch (e) {
      console.warn("跳过媒体删除：", e instanceof Error ? e.message : String(e));
    }
  }

  return plan;
}

/**
 * 删除若干条记忆事件本身（不动 conversation_turns）——用于「这条抽取错了」的精修。
 * 连带清掉 open_facts / entity_events / causal_chains / 向量。返回删除数量。
 */
export function purgeEvents(eventIds: string[], opts: { db?: Database; vec?: Database } = {}): { events: number; embeddings: number } {
  const ids = eventIds.filter(Boolean);
  if (!ids.length) return { events: 0, embeddings: 0 };
  const db = opts.db ?? getDB();
  const vec = opts.vec ?? getEmbeddingDB();
  const ph = ids.map(() => "?").join(",");

  db.transaction(() => {
    db.query(`DELETE FROM causal_chains WHERE cause_event_id IN (${ph}) OR effect_event_id IN (${ph})`).run(...ids, ...ids);
    db.query(`DELETE FROM entity_events WHERE event_id IN (${ph})`).run(...ids);
    db.query(`DELETE FROM memory_open_facts WHERE event_id IN (${ph})`).run(...ids);
    db.query(`DELETE FROM memory_events WHERE id IN (${ph})`).run(...ids); // FTS 触发器自动同步
  })();

  let embeddings = 0;
  try {
    const res = vec.query(`DELETE FROM memory_embeddings WHERE target_id IN (${ph})`).run(...ids);
    embeddings = Number((res as { changes?: number }).changes ?? 0);
  } catch (e) {
    console.warn("跳过向量删除：", e instanceof Error ? e.message : String(e));
  }

  return { events: ids.length, embeddings };
}
