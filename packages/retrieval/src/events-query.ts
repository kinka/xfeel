import type { Database } from "bun:sqlite";

/**
 * canonical events 查询层：把 /events 的筛选逻辑收敛成可单测的 query builder，
 * 供 API 和后续 analysis layer 复用。
 */

export interface EventsQueryFilters {
  type?: string;
  entity?: string;
  tag?: string;
  emotion?: string;
  /** owner（memory_events.user_id），如 demo-dad-owner=爸爸 / demo-mom-owner=妈妈 */
  owner?: string;
  /** 家庭共享记忆：多个 owner 池（user_id IN ...）。给定时优先于单 owner，用于跨家庭成员召回。 */
  owners?: string[];
  /** 起始日期（含），YYYY-MM-DD，按 memory_events.event_date */
  since?: string;
  /** 结束日期（含），YYYY-MM-DD */
  until?: string;
  limit?: number;
  offset?: number;
  /** 时间排序方向，按 event_time/event_date：desc=最近优先（默认），asc=最早优先 */
  order?: "asc" | "desc";
}

export interface EventsQuery {
  sql: string;
  countSql: string;
  params: unknown[];
  limit: number;
  offset: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 500;
const EVENT_DATE_EXPR = "COALESCE(NULLIF(event_date, ''), date(event_time), substr(event_time, 1, 10), date(created_at, 'localtime'), substr(created_at, 1, 10))";
const EVENT_ORDER_EXPR = "COALESCE(event_time, NULLIF(event_date, ''), created_at)";

export function buildEventsQuery(filters: EventsQueryFilters = {}): EventsQuery {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.type) {
    conditions.push("event_type = ?");
    params.push(filters.type);
  }
  if (filters.entity) {
    conditions.push("entities LIKE ?");
    params.push(`%"${filters.entity}"%`);
  }
  if (filters.tag) {
    conditions.push("tags LIKE ?");
    params.push(`%"${filters.tag}"%`);
  }
  if (filters.emotion) {
    conditions.push("emotion LIKE ?");
    params.push(`%"primary":"${filters.emotion}"%`);
  }
  const ownerSet = filters.owners?.length
    ? [...new Set(filters.owners.filter(Boolean))]
    : (filters.owner ? [filters.owner] : []);
  if (ownerSet.length === 1) {
    conditions.push("user_id = ?");
    params.push(ownerSet[0]);
  } else if (ownerSet.length > 1) {
    conditions.push(`user_id IN (${ownerSet.map(() => "?").join(",")})`);
    params.push(...ownerSet);
  }
  if (filters.since) {
    if (!DATE_RE.test(filters.since)) throw new Error("since must be YYYY-MM-DD");
    conditions.push(`${EVENT_DATE_EXPR} >= ?`);
    params.push(filters.since);
  }
  if (filters.until) {
    if (!DATE_RE.test(filters.until)) throw new Error("until must be YYYY-MM-DD");
    conditions.push(`${EVENT_DATE_EXPR} <= ?`);
    params.push(filters.until);
  }

  const where = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";
  const limit = Math.min(Math.max(1, Math.floor(filters.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const offset = Math.max(0, Math.floor(filters.offset ?? 0));
  const dir = filters.order === "asc" ? "ASC" : "DESC";

  return {
    sql: `SELECT * FROM memory_events${where} ORDER BY ${EVENT_ORDER_EXPR} ${dir}, created_at ${dir} LIMIT ? OFFSET ?`,
    countSql: `SELECT COUNT(*) as c FROM memory_events${where}`,
    params,
    limit,
    offset,
  };
}

export interface EventsQueryResult {
  events: unknown[];
  total: number;
  limit: number;
  offset: number;
}

export function queryEvents(db: Database, filters: EventsQueryFilters = {}): EventsQueryResult {
  const q = buildEventsQuery(filters);
  const events = db.prepare(q.sql).all(...(q.params as never[]), q.limit as never, q.offset as never);
  const total = (db.prepare(q.countSql).get(...(q.params as never[])) as { c: number }).c;
  return { events, total, limit: q.limit, offset: q.offset };
}
