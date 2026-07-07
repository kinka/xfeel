import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDB } from "../../db/src/database";
import { normalizeLocalDate } from "../../domain/src/local-date";
import { normalizeOwnerId } from "../../domain/src/owner";
import type { ConversationRole } from "./conversation";

export interface SessionTurn {
  role: ConversationRole;
  content: string;
  created_at: string;
  /** true = content 是图片的自动转写，不是用户亲口说的话（拼对话历史时要标注） */
  image_transcript?: boolean;
}

export interface AmbientContext {
  archiveSummaries: string[];
  todayTurnSnippets: string[];
  recentTurnSnippets: string[];
  openFacts: string[];
  weeklyContextPath?: string;
  text: string;
}

export interface SessionContext {
  owner_id?: string;
  date: string;
  recentTurns: SessionTurn[];
  hasRecent: boolean;
  ambient?: AmbientContext;
}

export function loadSessionContext(input: {
  owner_id?: string;
  date?: string;
  maxTurns?: number;
  excludeTurnId?: string;
}): SessionContext {
  const ownerId = normalizeOwnerId(input.owner_id);
  const date = normalizeLocalDate(input.date);
  const limit = Math.min(Math.max(1, Math.floor(input.maxTurns || 8)), 30);
  if (!ownerId) {
    return { owner_id: ownerId, date, recentTurns: [], hasRecent: false, ambient: emptyAmbientContext() };
  }

  const conditions = ["turn_date = ?"];
  const params: Array<string | number | null> = [date];

  conditions.push("owner_id = ?");
  params.push(ownerId);
  if (input.excludeTurnId) {
    conditions.push("id != ?");
    params.push(input.excludeTurnId);
  }

  const rows = getDB().prepare(`
    SELECT role, content, created_at, metadata
    FROM conversation_turns
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(...params, limit) as Array<SessionTurn & { metadata?: string | null }>;

  const recentTurns = rows.reverse().map(row => {
    let imageTranscript = false;
    try { imageTranscript = row.metadata ? Boolean(JSON.parse(row.metadata).image_transcript) : false; } catch { /* ignore */ }
    return { role: row.role, content: row.content, created_at: row.created_at, image_transcript: imageTranscript };
  });
  return {
    owner_id: ownerId,
    date,
    recentTurns,
    hasRecent: recentTurns.length > 0,
    ambient: loadAmbientContext({ owner_id: ownerId, date }),
  };
}

export function loadAmbientContext(input: { owner_id?: string; date?: string; days?: number; maxChars?: number }): AmbientContext {
  const ownerId = normalizeOwnerId(input.owner_id);
  const date = normalizeLocalDate(input.date);
  const maxChars = Math.min(Math.max(200, Math.floor(input.maxChars || 1800)), 5000);
  if (!ownerId) return emptyAmbientContext();

  const db = getDB();
  const days = Math.min(Math.max(1, Math.floor(input.days || 7)), 14);
  const since = addDays(date, -(days - 1));

  const archives = db.prepare(`
    SELECT archive_date, summary
    FROM daily_archives
    WHERE owner_id = ? AND archive_date BETWEEN ? AND ?
    ORDER BY archive_date DESC
    LIMIT 7
  `).all(ownerId, since, date) as Array<{ archive_date: string; summary: string }>;

  const todayTurns = db.prepare(`
    SELECT role, content, created_at
    FROM conversation_turns
    WHERE owner_id = ? AND turn_date = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 20
  `).all(ownerId, date) as SessionTurn[];

  const facts = db.prepare(`
    SELECT kind, value, surface
    FROM memory_open_facts
    WHERE owner_id = ?
    ORDER BY rowid DESC
    LIMIT 16
  `).all(ownerId) as Array<{ kind: string; value: string; surface: string }>;

  const archiveSummaries = archives.map(row => `${row.archive_date}: ${normalizeSnippet(row.summary)}`).filter(Boolean).slice(0, 5);
  const todayTurnSnippets = todayTurns
    .reverse()
    .map(turn => `${turn.role === "user" ? "用户" : turn.role === "assistant" ? "助手" : "系统"}: ${normalizeSnippet(turn.content, 80)}`)
    .filter(Boolean)
    .slice(-12);
  const openFacts = unique(facts.map(fact => normalizeSnippet(`${fact.kind}:${fact.value || fact.surface}`, 80)).filter(Boolean)).slice(0, 8);
  const weeklyContextPath = getRollingWeeklyContextPath(ownerId);
  const weeklyContext = readRollingWeeklyContext(ownerId);
  const text = clampSections([
    weeklyContext || (archiveSummaries.length ? `近一周归档：\n${archiveSummaries.map((x, i) => `${i + 1}. ${x}`).join("\n")}` : ""),
    todayTurnSnippets.length ? `今日持续对话：\n${todayTurnSnippets.map((x, i) => `${i + 1}. ${x}`).join("\n")}` : "",
    openFacts.length ? `开放事实：${openFacts.join("；")}` : "",
  ], maxChars);

  return { archiveSummaries, todayTurnSnippets, recentTurnSnippets: todayTurnSnippets, openFacts, weeklyContextPath, text };
}

export function buildRollingWeeklyContext(input: { owner_id?: string; date?: string; days?: number; maxChars?: number }): AmbientContext {
  const ownerId = normalizeOwnerId(input.owner_id);
  const date = normalizeLocalDate(input.date);
  const maxChars = Math.min(Math.max(400, Math.floor(input.maxChars || 2200)), 6000);
  if (!ownerId) return emptyAmbientContext();

  const db = getDB();
  const days = Math.min(Math.max(1, Math.floor(input.days || 7)), 14);
  const since = addDays(date, -(days - 1));
  const archives = db.prepare(`
    SELECT archive_date, summary
    FROM daily_archives
    WHERE owner_id = ? AND archive_date BETWEEN ? AND ? AND status = 'done' AND summary != ''
    ORDER BY archive_date ASC
    LIMIT 14
  `).all(ownerId, since, date) as Array<{ archive_date: string; summary: string }>;
  const facts = db.prepare(`
    SELECT kind, value, surface
    FROM memory_open_facts
    WHERE owner_id = ?
    ORDER BY rowid DESC
    LIMIT 16
  `).all(ownerId) as Array<{ kind: string; value: string; surface: string }>;

  const archiveSummaries = archives.map(row => `${row.archive_date}: ${normalizeSnippet(row.summary, 220)}`).filter(Boolean);
  const openFacts = unique(facts.map(fact => normalizeSnippet(`${fact.kind}:${fact.value || fact.surface}`, 80)).filter(Boolean)).slice(0, 10);
  const weeklyContextPath = getRollingWeeklyContextPath(ownerId);
  const text = clampSections([
    `# xfeel rolling 7-day context\nowner_id: ${ownerId}\nupdated_for_date: ${date}\nwindow: ${since}..${date}`,
    archiveSummaries.length ? `## 近7天日终摘要\n${archiveSummaries.map((x, i) => `${i + 1}. ${x}`).join("\n")}` : "## 近7天日终摘要\n暂无已归档摘要",
    openFacts.length ? `## 开放事实/待观察线索\n${openFacts.map((x, i) => `${i + 1}. ${x}`).join("\n")}` : "",
    "## 使用约束\n这是弱背景，只帮助理解用户；回答事实性问题仍以当前消息、今日持续对话和明确召回证据为准，不要把背景当作新事实。",
  ], maxChars);
  return { archiveSummaries, todayTurnSnippets: [], recentTurnSnippets: [], openFacts, weeklyContextPath, text };
}

export function writeRollingWeeklyContext(input: { owner_id?: string; date?: string; days?: number; maxChars?: number }): { path?: string; text: string } {
  const ownerId = normalizeOwnerId(input.owner_id);
  const date = normalizeLocalDate(input.date);
  if (!ownerId) return { text: "" };
  const ambient = buildRollingWeeklyContext({ owner_id: ownerId, date, days: input.days, maxChars: input.maxChars });
  const path = getRollingWeeklyContextPath(ownerId);
  mkdirSync(join(process.cwd(), "data", "context"), { recursive: true });
  writeFileSync(path, ambient.text, "utf8");
  return { path, text: ambient.text };
}

export function summarizeRecentTurns(ctx: SessionContext): string | null {
  const userSnippets = ctx.recentTurns
    .filter(turn => turn.role === "user")
    .map(turn => normalizeSnippet(turn.content))
    .filter(Boolean)
    .slice(-4);

  if (userSnippets.length === 0) return null;
  return `刚刚主要是在聊：${userSnippets.join("；")}。`;
}

function normalizeSnippet(content: string, maxLength = 42): string {
  const cleaned = content
    .trim()
    .replace(/^(记|记录|查|查询|找|改|修正|更正)(?:\s*[:：]\s*|\s+)/i, "")
    .replace(/\s+/g, " ")
    .replace(/[。！？!?]+$/g, "");
  if (!cleaned) return "";
  return cleaned.length > maxLength ? `${cleaned.slice(0, Math.max(1, maxLength - 1))}...` : cleaned;
}

function emptyAmbientContext(): AmbientContext {
  return { archiveSummaries: [], todayTurnSnippets: [], recentTurnSnippets: [], openFacts: [], text: "" };
}

function getRollingWeeklyContextPath(ownerId: string): string {
  return join(process.cwd(), "data", "context", `rolling-7d-${ownerId}.md`);
}

function readRollingWeeklyContext(ownerId: string): string {
  const path = getRollingWeeklyContextPath(ownerId);
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * 按预算拼段落：段落累计超限就停，只保留已拼上的。
 * 第一段单独就超限时（滚动周报文件常见）截断保留而非整体清零——
 * 之前的实现会在第一段就 break，导致 out 停留在 ""，当天注入的 ambient 上下文整段消失。
 */
function clampSections(sections: string[], maxChars: number): string {
  let out = "";
  for (const section of sections.filter(Boolean)) {
    if (!out) {
      out = section.length > maxChars ? `${section.slice(0, maxChars - 1)}…` : section;
      continue;
    }
    const next = `${out}\n\n${section}`;
    if (next.length > maxChars) break;
    out = next;
  }
  return out;
}
