import { getDB } from "../../db/src/database";
import { getValence } from "../../domain/src/emotion-vocabulary";

/**
 * owner 级情绪统计：给 /app 家庭用户看的口径，一律按 user_id 收窄。
 * （temporal.ts 里的热力图/趋势是全库口径，只能给 admin dashboard 用，直接开放会跨家庭泄漏。）
 */

export type Valence = "positive" | "negative" | "neutral";

export interface DayMood {
  /** 当天主导情绪（最高频 primary）。 */
  emotion: string;
  valence: Valence;
  /** 当天情绪分布：正/中/负计数与总量，日历迷你分布条用。 */
  positive: number;
  negative: number;
  neutral: number;
  total: number;
  /** 出现最多的情绪词（≤3），悬停提示用。 */
  top: string[];
}

/** 与 /memories 系列一致的"天"口径：优先 event_date，缺失退回 created_at 前 10 位。 */
const DAY_EXPR = "COALESCE(NULLIF(event_date, ''), substr(created_at, 1, 10))";

/**
 * 某 owner 某月每天的情绪分布 + 主导情绪（当天出现次数最多的 primary，平局取先出现的）。
 * 日历用：迷你分布条（正绿/负蓝/中灰）+ 悬停显示 top 情绪词。
 */
export function getOwnerDailyMoods(ownerId: string, month: string): Record<string, DayMood> {
  const like = `${month}-%`;
  const rows = getDB().prepare(`
    SELECT ${DAY_EXPR} AS d, json_extract(emotion, '$.primary') AS emo, COUNT(*) AS c
    FROM memory_events
    WHERE user_id = ? AND ${DAY_EXPR} LIKE ?
      AND json_extract(emotion, '$.primary') IS NOT NULL AND json_extract(emotion, '$.primary') != ''
    GROUP BY d, emo
    ORDER BY d ASC, c DESC
  `).all(ownerId, like) as Array<{ d: string; emo: string; c: number }>;

  const moods: Record<string, DayMood> = {};
  for (const row of rows) {
    const valence = getValence(row.emo);
    let day = moods[row.d];
    if (!day) {
      // rows 按 c DESC 排序：每天第一行就是主导情绪
      day = moods[row.d] = { emotion: row.emo, valence, positive: 0, negative: 0, neutral: 0, total: 0, top: [] };
    }
    day[valence] += row.c;
    day.total += row.c;
    if (day.top.length < 3) day.top.push(row.emo);
  }
  return moods;
}

export interface EmotionCount {
  emotion: string;
  valence: Valence;
  count: number;
}

export interface EmotionWeekBucket {
  /** 桶起止（含），本地日 YYYY-MM-DD。 */
  from: string;
  to: string;
  positive: number;
  negative: number;
  neutral: number;
  total: number;
}

export interface OwnerEmotionReview {
  owner_id: string;
  from: string;
  to: string;
  days: number;
  total: number;
  valence: { positive: number; negative: number; neutral: number };
  top: EmotionCount[];
  weeks: EmotionWeekBucket[];
}

/**
 * 最近 N 天情绪回顾：总量、正/负/中占比、top 情绪、按 7 天桶（自 today 往回切）的走势。
 * 纯 SQL + 内存聚合，无 LLM；解读文案由调用方另行生成。
 */
export function getOwnerEmotionReview(ownerId: string, days = 30, today?: string): OwnerEmotionReview {
  const span = Math.min(Math.max(Math.floor(days) || 30, 7), 90);
  const end = /^\d{4}-\d{2}-\d{2}$/.test(today || "") ? today! : localToday();
  const start = addDays(end, -(span - 1));

  const rows = getDB().prepare(`
    SELECT ${DAY_EXPR} AS d, json_extract(emotion, '$.primary') AS emo, COUNT(*) AS c
    FROM memory_events
    WHERE user_id = ? AND ${DAY_EXPR} >= ? AND ${DAY_EXPR} <= ?
      AND json_extract(emotion, '$.primary') IS NOT NULL AND json_extract(emotion, '$.primary') != ''
    GROUP BY d, emo
  `).all(ownerId, start, end) as Array<{ d: string; emo: string; c: number }>;

  const valence = { positive: 0, negative: 0, neutral: 0 };
  const byEmotion = new Map<string, number>();
  const buckets: EmotionWeekBucket[] = [];
  for (let to = end; to >= start; to = addDays(to, -7)) {
    const from = maxDate(addDays(to, -6), start);
    buckets.unshift({ from, to, positive: 0, negative: 0, neutral: 0, total: 0 });
  }

  let total = 0;
  for (const row of rows) {
    const v = getValence(row.emo);
    total += row.c;
    valence[v] += row.c;
    byEmotion.set(row.emo, (byEmotion.get(row.emo) || 0) + row.c);
    const bucket = buckets.find(b => row.d >= b.from && row.d <= b.to);
    if (bucket) {
      bucket[v] += row.c;
      bucket.total += row.c;
    }
  }

  const top = [...byEmotion.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([emotion, count]) => ({ emotion, valence: getValence(emotion), count }));

  return { owner_id: ownerId, from: start, to: end, days: span, total, valence, top, weeks: buckets };
}

function localToday(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function addDays(ymd: string, delta: number): string {
  const date = new Date(`${ymd}T00:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}
