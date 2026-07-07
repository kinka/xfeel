import { getLLM } from "../../ai-client/src/llm";
import { roleLLMConfig } from "../../ai-client/src/roles";
import { getDB } from "../../db/src/database";
import { processMessage } from "../../pipeline/src/pipeline";
import { normalizeLocalDate } from "../../domain/src/local-date";
import { normalizeOwnerId, resolveOwnerLabel } from "../../domain/src/owner";
import { getConversationTurns, type ConversationTurn } from "../../conversation/src/conversation";
import { writeRollingWeeklyContext } from "../../conversation/src/session-context";
import { detectCareThreads } from "../../care/src/threads";
import { getMilestones } from "../../analyzer/src/milestone-curation";
import { logWarn, safeErrorMessage } from "../../observability/src/logging";

export interface DailyArchive {
  id: string;
  owner_id?: string;
  archive_date: string;
  summary: string;
  source_turn_ids: string[];
  event_ids: string[];
  status: "done" | "skipped" | "error";
  error?: string;
  created_at: string;
  updated_at: string;
}

export interface DailyArchiveResult {
  archive: DailyArchive;
  turns: number;
  events_stored: number;
  skipped: boolean;
  reason?: string;
}

export interface RunDailyArchiveResult {
  date: string;
  archives: DailyArchiveResult[];
}

export async function runDailyArchive(input: {
  date?: string;
  owner_id?: string;
  user_id?: string;
  force?: boolean;
  dry_run?: boolean;
} = {}): Promise<RunDailyArchiveResult> {
  const date = normalizeDate(input.date);
  const ownerId = normalizeOwnerId(input.owner_id ?? input.user_id);
  const ownerIds = ownerId ? [ownerId] : getOwnersWithTurns(date);
  const archives: DailyArchiveResult[] = [];

  for (const id of ownerIds) {
    archives.push(await archiveDay({ ...input, date, owner_id: id }));
  }

  return { date, archives };
}

export async function archiveDay(input: {
  date?: string;
  owner_id?: string;
  user_id?: string;
  force?: boolean;
  dry_run?: boolean;
}): Promise<DailyArchiveResult> {
  const db = getDB();
  const date = normalizeDate(input.date);
  const ownerId = normalizeOwnerId(input.owner_id ?? input.user_id);
  if (!ownerId) throw new Error("owner_id is required");

  const existing = findArchive(ownerId, date);
  if (existing && !input.force) {
    return {
      archive: existing,
      turns: existing.source_turn_ids.length,
      events_stored: existing.event_ids.length,
      skipped: true,
      reason: "already archived",
    };
  }

  const turns = getConversationTurns({
    owner_id: ownerId,
    date,
    limit: 500,
    include_archived: Boolean(input.force),
  });

  if (turns.length === 0) {
    const skipped = buildArchive({
      id: existing?.id || crypto.randomUUID(),
      ownerId,
      date,
      summary: "",
      turnIds: [],
      eventIds: [],
      status: "skipped",
      error: "no turns to archive",
    });
    return { archive: skipped, turns: 0, events_stored: 0, skipped: true, reason: "no turns to archive" };
  }

  const summary = await summarizeTurns(date, ownerId, turns);
  if (input.dry_run) {
    return {
      archive: buildArchive({
        id: existing?.id || crypto.randomUUID(),
        ownerId,
        date,
        summary,
        turnIds: turns.map(t => t.id),
        eventIds: [],
        status: "done",
      }),
      turns: turns.length,
      events_stored: 0,
      skipped: false,
    };
  }

  const archiveId = existing?.id || crypto.randomUUID();
  const archiveContent = buildArchiveContent(date, ownerId, summary, turns);
  const pipelineResult = await processMessage(archiveContent, {
    ownerId,
    speakerId: ownerId,
    messageId: archiveId,
    force: true,
    eventDate: date,
    sourceArchiveId: archiveId,
    embedNewEvents: false,
  });
  const eventIds = pipelineResult.events.map(event => event.id).filter((id): id is string => Boolean(id));

  const turnIds = turns.map(t => t.id);
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO daily_archives (id, owner_id, archive_date, summary, source_turn_ids, event_ids, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'done', ?)
      ON CONFLICT(owner_id, archive_date) DO UPDATE SET
        summary=excluded.summary,
        source_turn_ids=excluded.source_turn_ids,
        event_ids=excluded.event_ids,
        status='done',
        error=NULL,
        updated_at=excluded.updated_at
    `).run(archiveId, ownerId, date, summary, JSON.stringify(turnIds), JSON.stringify(eventIds), now);

    db.prepare(`
      INSERT OR REPLACE INTO diaries (id, user_id, content, diary_date, source, event_ids)
      VALUES (?, ?, ?, ?, 'daily_archive', ?)
    `).run(`daily:${archiveId}`, ownerId, summary, date, JSON.stringify(eventIds));

    const updateTurn = db.prepare("UPDATE conversation_turns SET archive_id = ? WHERE id = ?");
    for (const turnId of turnIds) updateTurn.run(archiveId, turnId);
  });
  transaction();
  writeRollingWeeklyContext({ owner_id: ownerId, date });

  // 跟进式关怀：归档顺带检测未闭环线索（担忧回访/安排跟进）并闭环已回应的旧线索。
  // 离线链路不赶时间，但失败绝不能影响归档本身。
  try {
    await detectCareThreads({ owner_id: ownerId, date, turns });
  } catch (error) {
    logWarn("daily_archive_care_threads_failed", { date, error: safeErrorMessage(error) });
  }

  // 里程碑快照预热：当天新事件会让候选集指纹变化，离线趁热重建，
  // 用户白天打开 /app 里程碑面板时直接命中缓存（在线路径不等 LLM）。
  try {
    await getMilestones(ownerId);
  } catch (error) {
    logWarn("daily_archive_milestone_warmup_failed", { date, error: safeErrorMessage(error) });
  }

  return {
    archive: buildArchive({
      id: archiveId,
      ownerId,
      date,
      summary,
      turnIds,
      eventIds,
      status: "done",
      updatedAt: now,
    }),
    turns: turns.length,
    events_stored: eventIds.length,
    skipped: false,
  };
}

export function getDailyArchives(query: {
  owner_id?: string;
  user_id?: string;
  date?: string;
  limit?: number;
} = {}): DailyArchive[] {
  const db = getDB();
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  const ownerId = normalizeOwnerId(query.owner_id ?? query.user_id);

  if (ownerId) {
    conditions.push("owner_id = ?");
    params.push(ownerId);
  }
  if (query.date) {
    conditions.push("archive_date = ?");
    params.push(normalizeDate(query.date));
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT * FROM daily_archives
    ${where}
    ORDER BY archive_date DESC, created_at DESC
    LIMIT ?
  `).all(...params, query.limit || 30) as Array<Record<string, unknown>>;

  return rows.map(rowToArchive);
}

function getOwnersWithTurns(date: string): string[] {
  const db = getDB();
  const rows = db.prepare(`
    SELECT DISTINCT owner_id FROM conversation_turns
    WHERE turn_date = ? AND archive_id IS NULL AND owner_id IS NOT NULL
    ORDER BY owner_id ASC
  `).all(date) as Array<{ owner_id: string }>;
  return rows.map(row => row.owner_id);
}

function findArchive(ownerId: string, date: string): DailyArchive | null {
  const db = getDB();
  const row = db.prepare(`
    SELECT * FROM daily_archives WHERE owner_id = ? AND archive_date = ?
  `).get(ownerId, date) as Record<string, unknown> | undefined;
  return row ? rowToArchive(row) : null;
}

async function summarizeTurns(date: string, ownerId: string, turns: ConversationTurn[]): Promise<string> {
  const ownerLabel = resolveOwnerLabel(ownerId) || ownerId;
  const transcript = turns.map(turn => `${roleLabel(turn.role)}：${turn.content}`).join("\n");

  try {
    const llm = getLLM(roleLLMConfig("reply"));
    const result = await llm.chatJSON<{ summary: string }>(
      `日期：${date}
记录者：${ownerLabel}

当天对话：
${transcript}

请总结成一篇当天归档日记，要求：
1. 保留情绪变化、成长记录、重要家庭事件
2. 不编造对话里没有的信息
3. 语言自然，200 到 500 字

输出 JSON：{"summary":"..."}`,
      "你是 xfeel 的日终归档助手。只输出 JSON。",
    );
    const summary = result.summary?.trim();
    if (summary) return summary;
  } catch {
    // fall through to deterministic summary
  }

  const userLines = turns.filter(t => t.role === "user").map(t => t.content);
  const joined = userLines.join(" ");
  const compact = joined.length > 500 ? `${joined.slice(0, 500)}...` : joined;
  return `${date} ${ownerLabel}的对话归档：${compact}`;
}

function buildArchiveContent(
  date: string,
  ownerId: string,
  summary: string,
  turns: ConversationTurn[],
): string {
  const ownerLabel = resolveOwnerLabel(ownerId) || ownerId;
  const transcript = turns
    .filter(turn => turn.role === "user")
    .map(turn => turn.content)
    .join("\n");
  return `日期：${date}
记录者：${ownerLabel}

当天总结：
${summary}

用户当天原始对话：
${transcript}`;
}

function buildArchive(input: {
  id: string;
  ownerId?: string;
  date: string;
  summary: string;
  turnIds: string[];
  eventIds: string[];
  status: DailyArchive["status"];
  error?: string;
  updatedAt?: string;
}): DailyArchive {
  const now = new Date().toISOString();
  return {
    id: input.id,
    owner_id: input.ownerId,
    archive_date: input.date,
    summary: input.summary,
    source_turn_ids: input.turnIds,
    event_ids: input.eventIds,
    status: input.status,
    error: input.error,
    created_at: now,
    updated_at: input.updatedAt || now,
  };
}

function rowToArchive(row: Record<string, unknown>): DailyArchive {
  return {
    id: row.id as string,
    owner_id: row.owner_id as string | undefined,
    archive_date: row.archive_date as string,
    summary: row.summary as string,
    source_turn_ids: JSON.parse(row.source_turn_ids as string || "[]"),
    event_ids: JSON.parse(row.event_ids as string || "[]"),
    status: row.status as DailyArchive["status"],
    error: row.error as string | undefined,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function roleLabel(role: ConversationTurn["role"]): string {
  if (role === "assistant") return "助手";
  if (role === "system") return "系统";
  return "用户";
}

function normalizeDate(input?: string): string {
  return normalizeLocalDate(input);
}
