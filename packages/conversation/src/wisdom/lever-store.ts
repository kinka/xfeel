import { getDB } from "../../../db/src/database";
import { normalizeOwnerId } from "../../../domain/src/owner";
import type { ConstrualLever, LeverHit, NarrativeEvidence } from "./lever-types";

/** 杠杆命中落库：一次命中一行，带原话片段，可回溯可审计。 */
export function recordLeverHits(input: {
  ownerId?: string;
  hits: LeverHit[];
  date: string;
  turnId?: string;
}): number {
  const owner = normalizeOwnerId(input.ownerId);
  if (!owner || !input.hits.length) return 0;
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO construal_levers (id, owner_id, lever, confidence, quote, turn_id, event_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  for (const hit of input.hits) {
    stmt.run(crypto.randomUUID(), owner, hit.lever, hit.confidence, hit.quote, input.turnId ?? null, input.date, now);
  }
  return input.hits.length;
}

export interface LeverRecurrence {
  /** 窗口内该杠杆命中的**天数**（不是条数：一天里反复说三遍只算一天）。 */
  days: number;
  hits: number;
  lastDate?: string;
}

/**
 * 滚动窗口内某杠杆的复现情况。
 *
 * 按“天”计数是刻意的：一个人在同一个晚上把同一句自我否定说三遍，那是一次情绪，不是一种模式。
 * 只有跨天反复出现，才值得把它当作"解释方式"来撬。
 */
export function getLeverRecurrence(input: {
  ownerId?: string;
  lever: ConstrualLever;
  since: string;
  until: string;
  minConfidence?: number;
}): LeverRecurrence {
  const owner = normalizeOwnerId(input.ownerId);
  if (!owner) return { days: 0, hits: 0 };
  const row = getDB().prepare(`
    SELECT COUNT(DISTINCT event_date) AS days, COUNT(*) AS hits, MAX(event_date) AS last_date
    FROM construal_levers
    WHERE owner_id = ? AND lever = ? AND event_date BETWEEN ? AND ? AND confidence >= ?
  `).get(owner, input.lever, input.since, input.until, input.minConfidence ?? 0) as
    { days: number; hits: number; last_date: string | null };
  return { days: row?.days ?? 0, hits: row?.hits ?? 0, lastDate: row?.last_date ?? undefined };
}

export interface WisdomInterventionRow {
  id: string;
  ownerId: string;
  lever: ConstrualLever;
  question: string;
  narrative?: string;
  eventDate: string;
  askedTurnId?: string;
}

export function recordIntervention(input: {
  ownerId: string;
  lever: ConstrualLever;
  question: string;
  evidence: NarrativeEvidence[];
  date: string;
  askedTurnId?: string;
}): string {
  const owner = normalizeOwnerId(input.ownerId);
  if (!owner) throw new Error("ownerId is required");
  const id = crypto.randomUUID();
  getDB().prepare(`
    INSERT INTO wisdom_interventions (id, owner_id, lever, asked_turn_id, question, evidence, event_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, owner, input.lever, input.askedTurnId ?? null, input.question,
    JSON.stringify(input.evidence ?? []), input.date, new Date().toISOString(),
  );
  return id;
}

/** 最近一次干预的日期（用于冷却期：别把每一次难过都变成一场反问）。 */
export function getLastInterventionDate(ownerId?: string): string | undefined {
  const owner = normalizeOwnerId(ownerId);
  if (!owner) return undefined;
  const row = getDB().prepare(
    `SELECT MAX(event_date) AS last_date FROM wisdom_interventions WHERE owner_id = ?`,
  ).get(owner) as { last_date: string | null } | undefined;
  return row?.last_date ?? undefined;
}

/** 取最近一次"已发问但用户还没自述新解释"的干预，供下一条消息回收叙事。 */
export function getOpenIntervention(ownerId?: string): WisdomInterventionRow | null {
  const owner = normalizeOwnerId(ownerId);
  if (!owner) return null;
  const row = getDB().prepare(`
    SELECT id, owner_id, lever, question, narrative, event_date, asked_turn_id
    FROM wisdom_interventions
    WHERE owner_id = ? AND narrative IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).get(owner) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    ownerId: row.owner_id as string,
    lever: row.lever as ConstrualLever,
    question: row.question as string,
    narrative: (row.narrative as string) || undefined,
    eventDate: row.event_date as string,
    askedTurnId: (row.asked_turn_id as string) || undefined,
  };
}

/**
 * 用户这句话之前的最后一条助手消息。
 * 叙事回收只认"对反问的直接回答"，需要它来判断中间有没有隔着别的对话。
 */
export function getLastAssistantTurnId(ownerId?: string): string | undefined {
  const owner = normalizeOwnerId(ownerId);
  if (!owner) return undefined;
  const row = getDB().prepare(`
    SELECT id FROM conversation_turns
    WHERE owner_id = ? AND role = 'assistant'
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(owner) as { id: string } | undefined;
  return row?.id;
}

export function markNarrativeCaptured(interventionId: string, narrative: string): void {
  getDB().prepare(
    `UPDATE wisdom_interventions SET narrative = ?, narrative_captured_at = ? WHERE id = ?`,
  ).run(narrative, new Date().toISOString(), interventionId);
}
