import { getDB } from "../../db/src/database";
import { logInfo, logWarn, safeErrorMessage } from "../../observability/src/logging";

/**
 * pending_care 队列：跟进式关怀的共用底座。
 * 生产者：回声（echo.ts）、线索检测（threads.ts）。
 * 消费者：微信被动回复搭便车（每 owner 每天最多一条）、/app 跟进卡片。
 * 所有 LLM 的重活都在生产侧离线完成，消费侧只有 SQL——这是绕开微信 15 秒限制的关键。
 */

export type CareKind = "echo" | "concern" | "anticipation";
export type CareStatus = "pending" | "delivered" | "closed" | "expired";

export interface CareItem {
  id: string;
  owner_id: string;
  kind: CareKind;
  topic: string;
  content: string;
  source_event_id?: string;
  related_event_ids: string[];
  trigger_after: string;
  expires_at?: string;
  status: CareStatus;
  delivered_at?: string;
  delivered_via?: string;
  closed_reason?: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateCareItemInput {
  owner_id: string;
  kind: CareKind;
  /** 去重键：同 owner 同 kind 下已有同 topic 的 pending 时不重复创建。 */
  topic?: string;
  content: string;
  source_event_id?: string;
  related_event_ids?: string[];
  trigger_after?: string;
  expires_at?: string;
  metadata?: Record<string, unknown>;
}

export function createCareItem(input: CreateCareItemInput): CareItem | null {
  const db = getDB();
  const ownerId = input.owner_id?.trim();
  const content = input.content?.trim();
  if (!ownerId || !content) return null;
  const topic = input.topic?.trim() || "";

  if (topic) {
    const dup = db.prepare(
      "SELECT id FROM pending_care WHERE owner_id = ? AND kind = ? AND topic = ? AND status = 'pending' LIMIT 1",
    ).get(ownerId, input.kind, topic);
    if (dup) return null;
  }
  if (input.source_event_id) {
    const dup = db.prepare(
      "SELECT id FROM pending_care WHERE owner_id = ? AND kind = ? AND source_event_id = ? LIMIT 1",
    ).get(ownerId, input.kind, input.source_event_id);
    if (dup) return null;
  }

  const now = new Date().toISOString();
  const item: CareItem = {
    id: crypto.randomUUID(),
    owner_id: ownerId,
    kind: input.kind,
    topic,
    content,
    source_event_id: input.source_event_id,
    related_event_ids: input.related_event_ids || [],
    trigger_after: input.trigger_after || now,
    expires_at: input.expires_at,
    status: "pending",
    metadata: input.metadata || {},
    created_at: now,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO pending_care (id, owner_id, kind, topic, content, source_event_id, related_event_ids, trigger_after, expires_at, status, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(
    item.id, item.owner_id, item.kind, item.topic, item.content,
    item.source_event_id ?? null, JSON.stringify(item.related_event_ids),
    item.trigger_after, item.expires_at ?? null, JSON.stringify(item.metadata),
    item.created_at, item.updated_at,
  );
  logInfo("care_item_created", { care_id: item.id, kind: item.kind, owner_len: ownerId.length, topic, trigger_after: item.trigger_after });
  return item;
}

/** 可投递项：pending 且已到 trigger_after、未过期。顺带把过期项懒清理掉。 */
export function listDeliverableCare(query: { owner_id: string; now?: string; limit?: number }): CareItem[] {
  const db = getDB();
  const now = query.now || new Date().toISOString();
  expireStaleCare(query.owner_id, now);
  const rows = db.prepare(`
    SELECT * FROM pending_care
    WHERE owner_id = ? AND status = 'pending' AND trigger_after <= ?
    ORDER BY trigger_after ASC, created_at ASC
    LIMIT ?
  `).all(query.owner_id, now, Math.min(Math.max(1, query.limit || 10), 50)) as Array<Record<string, unknown>>;
  return rows.map(rowToCareItem);
}

/**
 * 微信搭便车取词：每 owner 每（本地）天最多投递一条，问过即 delivered 不再重复。
 * 纯 SQL，可在被动回复的 15 秒预算内随手调用。
 */
export function takeCareLineForWechat(query: { owner_id: string; now?: string }): CareItem | null {
  const db = getDB();
  const now = query.now || new Date().toISOString();
  const localDay = localDateOf(now);
  const deliveredToday = db.prepare(`
    SELECT id FROM pending_care
    WHERE owner_id = ? AND delivered_via = 'wechat' AND delivered_at >= ?
    LIMIT 1
  `).get(query.owner_id, minUtcInstantOfLocalDay(localDay)) as { id: string } | undefined;
  if (deliveredToday) return null;

  const candidates = listDeliverableCare({ owner_id: query.owner_id, now, limit: 1 });
  const item = candidates[0];
  if (!item) return null;
  markCareDelivered(item.id, "wechat", now);
  return { ...item, status: "delivered", delivered_at: now, delivered_via: "wechat" };
}

export function markCareDelivered(id: string, via: string, now?: string): void {
  const ts = now || new Date().toISOString();
  getDB().prepare(
    "UPDATE pending_care SET status = 'delivered', delivered_at = ?, delivered_via = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
  ).run(ts, via, ts, id);
}

export function dismissCare(query: { id: string; owner_id: string }): boolean {
  const now = new Date().toISOString();
  const result = getDB().prepare(`
    UPDATE pending_care SET status = 'closed', closed_reason = 'user_dismissed', updated_at = ?
    WHERE id = ? AND owner_id = ? AND status IN ('pending', 'delivered')
  `).run(now, query.id, query.owner_id);
  return result.changes > 0;
}

/** 线索闭环：当天对话已经回应了这些话题，不用再问。 */
export function closeCareByTopics(query: { owner_id: string; topics: string[]; reason?: string }): number {
  const topics = query.topics.map(topic => topic.trim()).filter(Boolean);
  if (!topics.length) return 0;
  const db = getDB();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE pending_care SET status = 'closed', closed_reason = ?, updated_at = ?
    WHERE owner_id = ? AND topic = ? AND status = 'pending'
  `);
  let closed = 0;
  for (const topic of topics) {
    try {
      closed += stmt.run(query.reason || "resolved", now, query.owner_id, topic).changes;
    } catch (error) {
      logWarn("care_close_topic_failed", { topic, error: safeErrorMessage(error) });
    }
  }
  return closed;
}

/** 频控用：今天（本地日）已为该 owner 创建了几条某类关怀。 */
export function countCareCreatedToday(ownerId: string, kind: CareKind, now?: string): number {
  const ts = now || new Date().toISOString();
  const row = getDB().prepare(`
    SELECT COUNT(*) AS c FROM pending_care
    WHERE owner_id = ? AND kind = ? AND created_at >= ?
  `).get(ownerId, kind, minUtcInstantOfLocalDay(localDateOf(ts))) as { c: number };
  return row.c;
}

export function getCareItem(id: string): CareItem | null {
  const row = getDB().prepare("SELECT * FROM pending_care WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToCareItem(row) : null;
}

function expireStaleCare(ownerId: string, now: string): void {
  getDB().prepare(`
    UPDATE pending_care SET status = 'expired', updated_at = ?
    WHERE owner_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
  `).run(now, ownerId, now);
}

/** Asia/Shanghai 本地日期（与产品其余部分的"天"口径一致）。 */
function localDateOf(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

/** 该本地日在 UTC 时间轴上的起点（本地 00:00 = UTC 前一天 16:00），用于 delivered_at/created_at 的按天过滤。 */
function minUtcInstantOfLocalDay(localDay: string): string {
  return new Date(`${localDay}T00:00:00+08:00`).toISOString();
}

function rowToCareItem(row: Record<string, unknown>): CareItem {
  return {
    id: row.id as string,
    owner_id: row.owner_id as string,
    kind: row.kind as CareKind,
    topic: (row.topic as string) || "",
    content: row.content as string,
    source_event_id: (row.source_event_id as string) || undefined,
    related_event_ids: parseJsonArray(row.related_event_ids as string),
    trigger_after: row.trigger_after as string,
    expires_at: (row.expires_at as string) || undefined,
    status: row.status as CareStatus,
    delivered_at: (row.delivered_at as string) || undefined,
    delivered_via: (row.delivered_via as string) || undefined,
    closed_reason: (row.closed_reason as string) || undefined,
    metadata: parseJsonObject(row.metadata as string),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function parseJsonArray(raw?: string): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw?: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
