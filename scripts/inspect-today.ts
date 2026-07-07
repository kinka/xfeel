#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

type SqlParam = string | number | null;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface Options {
  date: string;
  owner?: string;
  limit: number;
  dbPath: string;
}

interface CountedRows<T> {
  total: number;
  rows: T[];
  missing?: boolean;
}

interface ConversationTurnRow {
  id: string;
  owner_id: string | null;
  role: string;
  content: string;
  turn_date: string;
  source: string;
  metadata: string | null;
  archive_id: string | null;
  created_at: string;
}

interface DailyArchiveRow {
  id: string;
  owner_id: string | null;
  archive_date: string;
  summary: string;
  source_turn_ids: string | null;
  event_ids: string | null;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface MemoryEventRow {
  id: string;
  raw_message_id: string | null;
  event_index: number | null;
  summary: string;
  original_text: string;
  original_span: string | null;
  event_type: string;
  entities: string | null;
  emotion: string | null;
  tags: string | null;
  open_facts: string | null;
  event_date: string | null;
  event_time: string | null;
  source_archive_id: string | null;
  location: string | null;
  confidence: number | null;
  source: string | null;
  source_layer: string | null;
  user_id: string | null;
  extractor_version: string | null;
  vocab_version: string | null;
  search_text_version: string | null;
  created_at: string;
  updated_at: string;
}

interface OpenFactRow {
  id: string;
  event_id: string;
  owner_id: string | null;
  kind: string;
  value: string;
  surface: string;
  evidence_start: number | null;
  evidence_end: number | null;
  confidence: number;
  polarity: string;
  actor_id: string | null;
  experiencer_id: string | null;
  observer_id: string | null;
  created_at: string;
  event_type: string | null;
  event_summary: string | null;
  event_date: string | null;
  event_created_at: string | null;
}

interface PipelineStatusRow {
  message_id: string;
  stage: string;
  status: string;
  error: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

interface PipelineSummaryRow {
  stage: string;
  status: string;
  count: number;
}

const DEFAULT_LIMIT = 10;

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.dbPath)) {
    throw new Error(`数据库不存在：${options.dbPath}`);
  }

  const db = new Database(options.dbPath, { readonly: true, create: false });
  try {
    db.exec("PRAGMA query_only = ON");
    printReport(db, options);
  } finally {
    db.close();
  }
}

function printReport(db: Database, options: Options) {
  const tableCounts = countTables(db, [
    "conversation_turns",
    "daily_archives",
    "memory_events",
    "memory_open_facts",
    "pipeline_status",
    "memory_profiles",
    "families",
    "sync_state",
  ]);

  const loggedTurns = loadLoggedTurns(db, options);
  const turns = loadConversationTurns(db, options);
  const archives = loadDailyArchives(db, options);
  const events = loadMemoryEvents(db, options);
  const eventsByTurn = loadEventsForTurns(db, loggedTurns.rows, options);
  const facts = loadOpenFacts(db, options);
  const pipelineIds = options.owner ? collectPipelineIds(db, options) : undefined;
  const pipeline = loadPipelineStatus(db, options, pipelineIds);

  console.log(`# xfeel 当天检查`);
  console.log("");
  console.log(`- 数据库：${options.dbPath}`);
  console.log(`- 日期：${options.date}`);
  console.log(`- owner：${options.owner || "全部"}`);
  console.log(`- 每段最多显示：${options.limit}`);
  console.log("");

  console.log(`## 表行数`);
  for (const [name, count] of tableCounts) {
    console.log(`- ${name}: ${count === null ? "表不存在" : count}`);
  }
  console.log("");

  printLoggedTurnsWithEvents(loggedTurns, eventsByTurn, options.limit);
  printConversationTurns(turns, options.limit);
  printDailyArchives(archives, options.limit);
  printMemoryEvents(events, options.limit);
  printOpenFacts(facts, options.limit);
  printPipelineStatus(pipeline, options.limit, options.owner, pipelineIds);
}

function parseArgs(argv: string[]): Options {
  let date: string | undefined;
  let owner: string | undefined;
  let limit = DEFAULT_LIMIT;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--date") {
      date = requireNext(argv, ++index, "--date");
      continue;
    }
    if (arg.startsWith("--date=")) {
      date = arg.slice("--date=".length);
      continue;
    }

    if (arg === "--owner" || arg === "--owner_id" || arg === "--user_id") {
      owner = requireNext(argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--owner=")) {
      owner = arg.slice("--owner=".length);
      continue;
    }
    if (arg.startsWith("--owner_id=")) {
      owner = arg.slice("--owner_id=".length);
      continue;
    }
    if (arg.startsWith("--user_id=")) {
      owner = arg.slice("--user_id=".length);
      continue;
    }

    if (arg === "--limit") {
      limit = parseLimit(requireNext(argv, ++index, "--limit"));
      continue;
    }
    if (arg.startsWith("--limit=")) {
      limit = parseLimit(arg.slice("--limit=".length));
      continue;
    }

    throw new Error(`未知参数：${arg}`);
  }

  return {
    date: normalizeDate(date || todayLocalDate()),
    owner: owner?.trim() || undefined,
    limit,
    dbPath: resolve(process.env.XFEEL_DB_PATH || "data/xfeel.db"),
  };
}

function printHelp() {
  console.log(`用法：
  bun run scripts/inspect-today.ts
  bun run scripts/inspect-today.ts --date 2026-06-20 --owner demo-dad-owner --limit 20

参数：
  --date YYYY-MM-DD   默认使用 Asia/Shanghai 的今天
  --owner <id>        按 owner_id/user_id/owner_id 过滤
  --limit N           每段最多显示 N 条，默认 ${DEFAULT_LIMIT}

环境变量：
  XFEEL_DB_PATH       SQLite 路径，默认 data/xfeel.db`);
}

function requireNext(argv: string[], index: number, name: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} 需要一个值`);
  }
  return value;
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--limit 必须是正整数：${value}`);
  }
  return Math.min(parsed, 200);
}

function normalizeDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`日期格式应为 YYYY-MM-DD：${value}`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`无效日期：${value}`);
  }
  return value;
}

function todayLocalDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.TZ || "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function countTables(db: Database, names: string[]): Array<[string, number | null]> {
  return names.map(name => [name, tableExists(db, name) ? countRows(db, name) : null]);
}

function loadConversationTurns(db: Database, options: Options): CountedRows<ConversationTurnRow> {
  if (!tableExists(db, "conversation_turns")) return { total: 0, rows: [], missing: true };
  const where: string[] = ["turn_date = ?"];
  const params: SqlParam[] = [options.date];
  if (options.owner) {
    where.push("owner_id = ?");
    params.push(options.owner);
  }

  return selectCounted(db, `
    SELECT id, owner_id, role, content, turn_date, source, metadata, archive_id, created_at
    FROM conversation_turns
    WHERE ${where.join(" AND ")}
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `, `
    SELECT COUNT(*) AS count
    FROM conversation_turns
    WHERE ${where.join(" AND ")}
  `, params, options.limit);
}

function loadLoggedTurns(db: Database, options: Options): CountedRows<ConversationTurnRow> {
  if (!tableExists(db, "conversation_turns")) return { total: 0, rows: [], missing: true };
  const where: string[] = [
    "turn_date = ?",
    "role = 'user'",
    `(
      source = 'log'
      OR metadata LIKE '%"log_with_contextual_reply"%'
      OR metadata LIKE '%"pipeline_message_id"%'
      OR metadata LIKE '%"current_event_ids"%'
    )`,
  ];
  const params: SqlParam[] = [options.date];
  if (options.owner) {
    where.push("owner_id = ?");
    params.push(options.owner);
  }

  return selectCounted(db, `
    SELECT id, owner_id, role, content, turn_date, source, metadata, archive_id, created_at
    FROM conversation_turns
    WHERE ${where.join(" AND ")}
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `, `
    SELECT COUNT(*) AS count
    FROM conversation_turns
    WHERE ${where.join(" AND ")}
  `, params, options.limit);
}

function loadDailyArchives(db: Database, options: Options): CountedRows<DailyArchiveRow> {
  if (!tableExists(db, "daily_archives")) return { total: 0, rows: [], missing: true };
  const where: string[] = ["archive_date = ?"];
  const params: SqlParam[] = [options.date];
  if (options.owner) {
    where.push("owner_id = ?");
    params.push(options.owner);
  }

  return selectCounted(db, `
    SELECT id, owner_id, archive_date, summary, source_turn_ids, event_ids, status, error, created_at, updated_at
    FROM daily_archives
    WHERE ${where.join(" AND ")}
    ORDER BY datetime(updated_at) DESC, id DESC
    LIMIT ?
  `, `
    SELECT COUNT(*) AS count
    FROM daily_archives
    WHERE ${where.join(" AND ")}
  `, params, options.limit);
}

function loadMemoryEvents(db: Database, options: Options): CountedRows<MemoryEventRow> {
  if (!tableExists(db, "memory_events")) return { total: 0, rows: [], missing: true };
  const dateExpr = memoryEventDateExpr("memory_events");
  const where: string[] = [`(${dateExpr} = ? OR date(created_at, 'localtime') = ?)`];
  const params: SqlParam[] = [options.date, options.date];
  if (options.owner) {
    where.push("user_id = ?");
    params.push(options.owner);
  }

  return selectCounted(db, `
    SELECT ${memoryEventColumns()}
    FROM memory_events
    WHERE ${where.join(" AND ")}
    ORDER BY datetime(created_at) DESC, COALESCE(event_index, 0) ASC, id DESC
    LIMIT ?
  `, `
    SELECT COUNT(*) AS count
    FROM memory_events
    WHERE ${where.join(" AND ")}
  `, params, options.limit);
}

function loadEventsForTurns(
  db: Database,
  turns: ConversationTurnRow[],
  options: Options,
): Map<string, MemoryEventRow[]> {
  const result = new Map<string, MemoryEventRow[]>();
  for (const turn of turns) result.set(turn.id, []);

  if (turns.length === 0 || !tableExists(db, "memory_events")) return result;

  const linksByTurn = new Map<string, { rawMessageIds: Set<string>; eventIds: Set<string> }>();
  const rawMessageIds = new Set<string>();
  const eventIds = new Set<string>();

  for (const turn of turns) {
    const links = collectTurnEventLinks(turn);
    linksByTurn.set(turn.id, links);
    for (const id of links.rawMessageIds) rawMessageIds.add(id);
    for (const id of links.eventIds) eventIds.add(id);
  }

  const clauses: string[] = [];
  const params: SqlParam[] = [];
  const rawList = [...rawMessageIds];
  const eventList = [...eventIds];

  if (rawList.length) {
    clauses.push(`raw_message_id IN (${placeholders(rawList.length)})`);
    params.push(...rawList);
  }
  if (eventList.length) {
    clauses.push(`id IN (${placeholders(eventList.length)})`);
    params.push(...eventList);
  }
  if (clauses.length === 0) return result;

  const ownerSql = options.owner ? " AND user_id = ?" : "";
  if (options.owner) params.push(options.owner);

  const rows = db.prepare(`
    SELECT ${memoryEventColumns()}
    FROM memory_events
    WHERE (${clauses.join(" OR ")})${ownerSql}
    ORDER BY datetime(created_at) ASC, COALESCE(event_index, 0) ASC, id ASC
  `).all(...params) as MemoryEventRow[];

  for (const turn of turns) {
    const links = linksByTurn.get(turn.id);
    if (!links) continue;
    const matched = rows.filter(row => {
      const rawMatches = Boolean(row.raw_message_id && links.rawMessageIds.has(row.raw_message_id));
      const idMatches = links.eventIds.has(row.id);
      return rawMatches || idMatches;
    });
    result.set(turn.id, dedupeEvents(matched));
  }

  return result;
}

function loadOpenFacts(db: Database, options: Options): CountedRows<OpenFactRow> {
  if (!tableExists(db, "memory_open_facts")) return { total: 0, rows: [], missing: true };
  if (!tableExists(db, "memory_events")) {
    return { total: countRows(db, "memory_open_facts"), rows: [] };
  }

  const eventDateExpr = memoryEventDateExpr("e");
  const where: string[] = [`(${eventDateExpr} = ? OR date(e.created_at, 'localtime') = ? OR date(f.created_at, 'localtime') = ?)`];
  const params: SqlParam[] = [options.date, options.date, options.date];
  if (options.owner) {
    where.push("(f.owner_id = ? OR e.user_id = ?)");
    params.push(options.owner, options.owner);
  }

  return selectCounted(db, `
    SELECT f.id, f.event_id, f.owner_id, f.kind, f.value, f.surface, f.evidence_start, f.evidence_end, f.confidence, f.polarity,
      f.actor_id, f.experiencer_id, f.observer_id, f.created_at,
      e.event_type, e.summary AS event_summary, e.event_date, e.created_at AS event_created_at
    FROM memory_open_facts f
    LEFT JOIN memory_events e ON e.id = f.event_id
    WHERE ${where.join(" AND ")}
    ORDER BY datetime(f.created_at) DESC, f.id DESC
    LIMIT ?
  `, `
    SELECT COUNT(*) AS count
    FROM memory_open_facts f
    LEFT JOIN memory_events e ON e.id = f.event_id
    WHERE ${where.join(" AND ")}
  `, params, options.limit);
}

function collectPipelineIds(db: Database, options: Options): string[] {
  const ids = new Set<string>();

  if (tableExists(db, "conversation_turns")) {
    const rows = db.prepare(`
      SELECT id, metadata
      FROM conversation_turns
      WHERE turn_date = ? AND owner_id = ?
    `).all(options.date, options.owner) as Array<{ id: string; metadata: string | null }>;
    for (const row of rows) {
      ids.add(row.id);
      const metadata = parseJsonObject(row.metadata);
      const pipelineMessageId = metadata?.pipeline_message_id;
      if (typeof pipelineMessageId === "string" && pipelineMessageId.trim()) {
        ids.add(pipelineMessageId);
      }
    }
  }

  if (tableExists(db, "memory_events")) {
    const dateExpr = memoryEventDateExpr("memory_events");
    const rows = db.prepare(`
      SELECT DISTINCT raw_message_id
      FROM memory_events
      WHERE (${dateExpr} = ? OR date(created_at, 'localtime') = ?)
        AND user_id = ?
        AND raw_message_id IS NOT NULL
        AND raw_message_id != ''
    `).all(options.date, options.date, options.owner) as Array<{ raw_message_id: string }>;
    for (const row of rows) ids.add(row.raw_message_id);
  }

  if (tableExists(db, "daily_archives")) {
    const rows = db.prepare(`
      SELECT id
      FROM daily_archives
      WHERE archive_date = ? AND owner_id = ?
    `).all(options.date, options.owner) as Array<{ id: string }>;
    for (const row of rows) ids.add(row.id);
  }

  return [...ids];
}

function loadPipelineStatus(
  db: Database,
  options: Options,
  ownerMessageIds?: string[],
): CountedRows<PipelineStatusRow> & { summary: PipelineSummaryRow[] } {
  if (!tableExists(db, "pipeline_status")) {
    return { total: 0, rows: [], summary: [], missing: true };
  }

  const where: string[] = ["(date(created_at, 'localtime') = ? OR date(updated_at, 'localtime') = ?)"];
  const params: SqlParam[] = [options.date, options.date];

  if (ownerMessageIds) {
    if (ownerMessageIds.length === 0) {
      return { total: 0, rows: [], summary: [] };
    }
    where.push(`message_id IN (${ownerMessageIds.map(() => "?").join(", ")})`);
    params.push(...ownerMessageIds);
  }

  const whereSql = where.join(" AND ");
  const counted = selectCounted<PipelineStatusRow>(db, `
    SELECT message_id, stage, status, error, result, created_at, updated_at
    FROM pipeline_status
    WHERE ${whereSql}
    ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC, message_id DESC
    LIMIT ?
  `, `
    SELECT COUNT(*) AS count
    FROM pipeline_status
    WHERE ${whereSql}
  `, params, options.limit);

  const summary = db.prepare(`
    SELECT stage, status, COUNT(*) AS count
    FROM pipeline_status
    WHERE ${whereSql}
    GROUP BY stage, status
    ORDER BY count DESC, stage ASC, status ASC
  `).all(...params) as PipelineSummaryRow[];

  return { ...counted, summary };
}

function selectCounted<T>(
  db: Database,
  selectSql: string,
  countSql: string,
  params: SqlParam[],
  limit: number,
): CountedRows<T> {
  const total = (db.prepare(countSql).get(...params) as { count: number }).count;
  const rows = db.prepare(selectSql).all(...params, limit) as T[];
  return { total, rows };
}

function countRows(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdent(table)}`).get() as { count: number }).count;
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type IN ('table', 'view') AND name = ?
  `).get(table));
}

function memoryEventDateExpr(alias: string): string {
  const prefix = alias ? `${alias}.` : "";
  return `COALESCE(NULLIF(${prefix}event_date, ''), date(NULLIF(${prefix}event_time, '')), date(${prefix}created_at, 'localtime'))`;
}

function memoryEventColumns(): string {
  return `
    id, raw_message_id, event_index, summary, original_text, original_span,
    event_type, entities, emotion, tags, open_facts,
    event_date, event_time, source_archive_id, location, confidence, source, source_layer,
    user_id, extractor_version, vocab_version, search_text_version, created_at, updated_at
  `;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function printLoggedTurnsWithEvents(
  data: CountedRows<ConversationTurnRow>,
  eventsByTurn: Map<string, MemoryEventRow[]>,
  limit: number,
) {
  console.log(`## 当天记录日志 -> 抽取事件字段（${displayCount(data, limit)}）`);
  if (printMissingOrEmpty(data)) return;

  for (const row of data.rows) {
    const metadata = summarizeMetadata(row.metadata);
    const events = eventsByTurn.get(row.id) || [];
    console.log(`- ${row.created_at} owner=${row.owner_id || "-"} turn=${row.id} source=${row.source}`);
    console.log(`  日志：${preview(row.content, 180)}`);
    if (metadata) console.log(`  metadata：${metadata}`);

    if (events.length === 0) {
      console.log("  抽取事件：无匹配事件（可能尚未抽取、被判定为噪声，或后台写库未完成）");
      continue;
    }

    console.log(`  抽取事件：${events.length} 个`);
    for (const [index, event] of events.entries()) {
      console.log(`  - 事件 ${index + 1}: id=${event.id}`);
      printEventFields(event, "    ");
    }
  }
  console.log("");
}

function printConversationTurns(data: CountedRows<ConversationTurnRow>, limit: number) {
  console.log(`## conversation_turns（${displayCount(data, limit)}）`);
  if (printMissingOrEmpty(data)) return;
  for (const row of data.rows) {
    console.log(`- ${row.created_at} [${row.role}/${row.source}] owner=${row.owner_id || "-"} id=${row.id}${row.archive_id ? ` archive=${row.archive_id}` : ""}`);
    console.log(`  内容：${preview(row.content, 140)}`);
    const metadata = summarizeMetadata(row.metadata);
    if (metadata) console.log(`  metadata：${metadata}`);
  }
  console.log("");
}

function printDailyArchives(data: CountedRows<DailyArchiveRow>, limit: number) {
  console.log(`## daily_archives（${displayCount(data, limit)}）`);
  if (printMissingOrEmpty(data)) return;
  for (const row of data.rows) {
    console.log(`- ${row.updated_at} [${row.status}] owner=${row.owner_id || "-"} id=${row.id}`);
    console.log(`  摘要：${preview(row.summary, 180)}`);
    console.log(`  source_turn_ids=${jsonArrayLength(row.source_turn_ids)} event_ids=${jsonArrayLength(row.event_ids)}${row.error ? ` error=${preview(row.error, 80)}` : ""}`);
  }
  console.log("");
}

function printMemoryEvents(data: CountedRows<MemoryEventRow>, limit: number) {
  console.log(`## memory_events 抽取结果（${displayCount(data, limit)}）`);
  if (printMissingOrEmpty(data)) return;
  for (const row of data.rows) {
    console.log(`- ${row.created_at} [${row.event_type}] owner=${row.user_id || "-"} id=${row.id}`);
    printEventFields(row, "  ");
  }
  console.log("");
}

function printOpenFacts(data: CountedRows<OpenFactRow>, limit: number) {
  console.log(`## memory_open_facts（${displayCount(data, limit)}）`);
  if (printMissingOrEmpty(data)) return;
  for (const row of data.rows) {
    console.log(`- ${row.created_at} [${row.kind}/${row.polarity}] owner=${row.owner_id || "-"} fact=${row.id}`);
    console.log(`  value：${preview(row.value, 120)}`);
    console.log(`  surface：${preview(row.surface, 150)}`);
    console.log(`  event：${row.event_id}${row.event_type ? ` [${row.event_type}]` : ""}${row.event_date ? ` date=${row.event_date}` : ""}`);
    if (row.event_summary) console.log(`  event_summary：${preview(row.event_summary, 130)}`);
    const roles = [
      row.actor_id ? `actor=${row.actor_id}` : "",
      row.experiencer_id ? `experiencer=${row.experiencer_id}` : "",
      row.observer_id ? `observer=${row.observer_id}` : "",
      row.evidence_start !== null && row.evidence_end !== null ? `span=${row.evidence_start}-${row.evidence_end}` : "",
      `confidence=${row.confidence}`,
    ].filter(Boolean).join(" ");
    console.log(`  ${roles}`);
  }
  console.log("");
}

function printPipelineStatus(
  data: CountedRows<PipelineStatusRow> & { summary?: PipelineSummaryRow[] },
  limit: number,
  owner?: string,
  ownerMessageIds?: string[],
) {
  console.log(`## pipeline_status 摘要（${displayCount(data, limit)}）`);
  if (owner && ownerMessageIds) {
    console.log(`owner 过滤关联 message_id 数：${ownerMessageIds.length}`);
  }
  if (data.missing) {
    console.log("表不存在。");
    console.log("");
    return;
  }
  if (data.summary?.length) {
    for (const row of data.summary) {
      console.log(`- ${row.stage}/${row.status}: ${row.count}`);
    }
  } else {
    console.log("无匹配管线状态。");
  }

  if (data.rows.length) {
    console.log("");
    console.log(`最近 ${Math.min(limit, data.rows.length)} 条：`);
    for (const row of data.rows) {
      console.log(`- ${row.updated_at} [${row.stage}/${row.status}] message=${row.message_id}`);
      if (row.error) console.log(`  error：${preview(row.error, 140)}`);
      const result = summarizeJson(row.result, 180);
      if (result) console.log(`  result：${result}`);
    }
  }
  console.log("");
}

function printMissingOrEmpty(data: CountedRows<unknown>): boolean {
  if (data.missing) {
    console.log("表不存在。");
    console.log("");
    return true;
  }
  if (data.rows.length === 0) {
    console.log("无匹配记录。");
    console.log("");
    return true;
  }
  return false;
}

function displayCount(data: CountedRows<unknown>, limit: number): string {
  if (data.missing) return "表不存在";
  return `显示 ${Math.min(data.rows.length, limit)} / 共 ${data.total}`;
}

function preview(value: unknown, maxChars: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "-";
  const chars = Array.from(text);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}...` : text;
}

function dateOnly(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] || null;
}

function collectTurnEventLinks(row: ConversationTurnRow): { rawMessageIds: Set<string>; eventIds: Set<string> } {
  const rawMessageIds = new Set<string>([row.id]);
  const eventIds = new Set<string>();
  const metadata = parseJsonObject(row.metadata);

  const pipelineMessageId = metadata?.pipeline_message_id;
  if (typeof pipelineMessageId === "string" && pipelineMessageId.trim()) {
    rawMessageIds.add(pipelineMessageId);
  }

  for (const eventId of jsonStringArray(metadata?.current_event_ids)) {
    eventIds.add(eventId);
  }

  return { rawMessageIds, eventIds };
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function dedupeEvents(rows: MemoryEventRow[]): MemoryEventRow[] {
  const byId = new Map<string, MemoryEventRow>();
  for (const row of rows) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => {
    const ai = a.event_index ?? 0;
    const bi = b.event_index ?? 0;
    if (ai !== bi) return ai - bi;
    return (a.created_at || "").localeCompare(b.created_at || "") || a.id.localeCompare(b.id);
  });
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function parseJson(value: unknown): JsonValue | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return undefined;
  }
}

function parseJsonObject(value: unknown): Record<string, JsonValue> | undefined {
  const parsed = parseJson(value);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, JsonValue>;
  }
  return undefined;
}

function jsonArrayLength(value: unknown): number {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.length : 0;
}

function summarizeMetadata(value: unknown): string {
  const parsed = parseJsonObject(value);
  if (!parsed) return preview(value, 120);

  const parts: string[] = [];
  for (const key of ["mode", "pipeline_message_id", "corrected_turn_id"]) {
    const item = parsed[key];
    if (typeof item === "string" && item) parts.push(`${key}=${item}`);
  }
  for (const key of ["current_event_ids", "recalled_event_ids"]) {
    const item = parsed[key];
    if (Array.isArray(item)) parts.push(`${key}=${item.length}`);
  }
  return parts.length ? parts.join(" ") : summarizeJson(value, 120);
}

function summarizeJson(value: unknown, maxChars: number): string {
  const parsed = parseJson(value);
  if (parsed === undefined) return preview(value, maxChars);
  if (Array.isArray(parsed)) return formatParsedList(parsed, 6, maxChars);
  if (parsed && typeof parsed === "object") {
    const object = parsed as Record<string, JsonValue>;
    const preferred = ["stored", "count", "category", "is_meaningful", "reason", "modality", "embedding"];
    const parts: string[] = [];
    for (const key of preferred) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        parts.push(`${key}=${formatJsonScalar(object[key], 80)}`);
      }
    }
    if (parts.length) return preview(parts.join(" "), maxChars);
    return preview(JSON.stringify(object), maxChars);
  }
  return preview(String(parsed), maxChars);
}

function formatJsonList(value: unknown, maxItems = 6): string {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || parsed.length === 0) return "-";
  return formatParsedList(parsed, maxItems, 180);
}

function formatParsedList(items: JsonValue[], maxItems: number, maxChars: number): string {
  const head = items.slice(0, maxItems).map(item => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const object = item as Record<string, JsonValue>;
      const kind = typeof object.kind === "string" ? object.kind : "";
      const value = typeof object.value === "string" ? object.value : "";
      const surface = typeof object.surface === "string" ? object.surface : "";
      const summary = [kind, value || surface].filter(Boolean).join(":");
      return summary || JSON.stringify(object);
    }
    return String(item);
  });
  const suffix = items.length > maxItems ? ` ...(+${items.length - maxItems})` : "";
  return preview(`${head.join(", ")}${suffix}`, maxChars);
}

function printEventFields(row: MemoryEventRow, indent: string) {
  const fields = [
    `type=${row.event_type}`,
    row.event_index !== null ? `index=${row.event_index}` : "",
    `event_date=${row.event_date || dateOnly(row.event_time) || dateOnly(row.created_at) || "-"}`,
    row.event_time ? `event_time=${row.event_time}` : "",
    row.location ? `location=${row.location}` : "",
    row.confidence !== null ? `confidence=${row.confidence}` : "",
    row.source ? `source=${row.source}` : "",
    row.source_layer ? `layer=${row.source_layer}` : "",
  ].filter(Boolean).join(" ");
  console.log(`${indent}字段：${fields}`);
  console.log(`${indent}summary：${preview(row.summary, 180)}`);
  console.log(`${indent}original_text：${preview(row.original_text, 180)}`);
  if (row.original_span && row.original_span !== row.original_text) {
    console.log(`${indent}original_span：${preview(row.original_span, 180)}`);
  }
  console.log(`${indent}emotion：${formatEmotion(row.emotion)}`);
  console.log(`${indent}entities：${formatJsonList(row.entities)} | tags：${formatJsonList(row.tags)}`);
  const openFacts = formatOpenFacts(row.open_facts, 6);
  if (openFacts !== "-") console.log(`${indent}open_facts：${openFacts}`);
  const provenance = [
    row.raw_message_id ? `raw=${row.raw_message_id}` : "",
    row.source_archive_id ? `archive=${row.source_archive_id}` : "",
    row.extractor_version ? `extractor=${row.extractor_version}` : "",
    row.vocab_version ? `vocab=${row.vocab_version}` : "",
    row.search_text_version ? `search_text=${row.search_text_version}` : "",
  ].filter(Boolean).join(" ");
  if (provenance) console.log(`${indent}来源/版本：${provenance}`);
}

function formatEmotion(value: unknown): string {
  const parsed = parseJsonObject(value);
  if (!parsed) return preview(value, 120);
  const parts = [
    typeof parsed.primary === "string" ? `primary=${parsed.primary}` : "",
    typeof parsed.secondary === "string" ? `secondary=${parsed.secondary}` : "",
    typeof parsed.intensity === "number" ? `intensity=${parsed.intensity}` : "",
    typeof parsed.valence === "string" ? `valence=${parsed.valence}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : summarizeJson(value, 120);
}

function formatOpenFacts(value: unknown, maxItems: number): string {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || parsed.length === 0) return "-";

  const items = parsed.slice(0, maxItems).map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return String(item);
    const fact = item as Record<string, JsonValue>;
    const head = [
      typeof fact.kind === "string" ? fact.kind : "fact",
      typeof fact.value === "string" ? fact.value : "",
    ].filter(Boolean).join(":");
    const details = [
      typeof fact.surface === "string" ? `surface=${fact.surface}` : "",
      typeof fact.polarity === "string" ? `polarity=${fact.polarity}` : "",
      typeof fact.confidence === "number" ? `confidence=${fact.confidence}` : "",
      typeof fact.actor_id === "string" ? `actor=${fact.actor_id}` : "",
      typeof fact.experiencer_id === "string" ? `experiencer=${fact.experiencer_id}` : "",
      typeof fact.observer_id === "string" ? `observer=${fact.observer_id}` : "",
    ].filter(Boolean).join(" ");
    return details ? `${head} (${details})` : head;
  });

  const suffix = parsed.length > maxItems ? ` ...(+${parsed.length - maxItems})` : "";
  return preview(`${items.join("; ")}${suffix}`, 260);
}

function formatJsonScalar(value: JsonValue, maxChars: number): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === "object") return preview(JSON.stringify(value), maxChars);
  return preview(String(value), maxChars);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
