/**
 * 时序分析 — 情绪趋势、生活阶段、多人对比
 *
 * 来自 diary-knowledge-graph 技能第 5 步 + 第 7 步:
 * v1 经验: 月度热力图揭示 2024-06~09 密集压力期
 * v1 经验: 星星(崩溃+疲惫) vs 爸爸(释然) 情绪分布差异
 */

import { getDB } from "../../db/src/database";

// 正面/负面情绪分组（来自 v1 实战验证）
const POSITIVE_EMOTIONS = new Set([
  "欣喜", "开心", "平静", "崇拜", "信任", "接受", "惊喜", "意外", "期待", "急切", "留意",
  "自豪", "感恩", "满足", "感动", "释然", "精力充沛", "专注", "坚定",
]);

const NEGATIVE_EMOTIONS = new Set([
  "恐惧", "焦虑", "担心", "悲痛", "失落", "惆怅", "憎恶", "厌烦", "无聊",
  "狂怒", "愤怒", "烦躁", "震惊", "疲惫", "愧疚", "无助", "压力", "委屈",
  "心疼", "无奈", "迷茫", "孤独", "紧张", "崩溃",
]);

// ========== 月度情绪热力图 ==========

export interface EmotionHeatmap {
  months: string[];
  emotions: string[];
  matrix: number[][];  // matrix[monthIdx][emotionIdx] = count
}

/**
 * 月度情绪热力图 — 哪种情绪在哪个月最密集
 */
export function getEmotionHeatmap(months?: number): EmotionHeatmap {
  const db = getDB();
  const limit = months || 24;

  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m', event_time) as month,
      json_extract(emotion, '$.primary') as emotion,
      COUNT(*) as count
    FROM memory_events
    WHERE event_time IS NOT NULL
    GROUP BY month, emotion
    ORDER BY month ASC
    LIMIT 500
  `).all() as Array<{ month: string; emotion: string; count: number }>;

  const monthSet = new Set<string>();
  const emotionSet = new Set<string>();
  const data = new Map<string, number>();

  for (const row of rows) {
    monthSet.add(row.month);
    emotionSet.add(row.emotion);
    data.set(`${row.month}|${row.emotion}`, row.count);
  }

  const monthList = [...monthSet].sort().slice(-limit);
  const emotionList = [...emotionSet].sort((a, b) => {
    // 按总频次降序
    const sumA = monthList.reduce((s, m) => s + (data.get(`${m}|${a}`) || 0), 0);
    const sumB = monthList.reduce((s, m) => s + (data.get(`${m}|${b}`) || 0), 0);
    return sumB - sumA;
  });

  const matrix = monthList.map(m =>
    emotionList.map(e => data.get(`${m}|${e}`) || 0)
  );

  return { months: monthList, emotions: emotionList, matrix };
}

// ========== 核心情绪趋势线 ==========

export interface EmotionTrend {
  months: string[];
  series: Array<{
    emotion: string;
    values: number[];
    trend: "rising" | "falling" | "stable";
  }>;
}

/**
 * 核心情绪趋势线 — 跟踪 Top N 情绪的月度变化
 */
export function getEmotionTrends(topN: number = 6): EmotionTrend {
  const heatmap = getEmotionHeatmap();
  const { months, emotions, matrix } = heatmap;

  // 取总频次最高的 N 个情绪
  const totals = emotions.map((e, idx) => ({
    emotion: e,
    total: matrix.reduce((sum, row) => sum + row[idx], 0),
    idx,
  }));
  totals.sort((a, b) => b.total - a.total);
  const topEmotions = totals.slice(0, topN);

  const series = topEmotions.map(({ emotion, idx }) => {
    const values = matrix.map(row => row[idx]);
    const trend = detectTrend(values);
    return { emotion, values, trend };
  });

  return { months, series };
}

function detectTrend(values: number[]): "rising" | "falling" | "stable" {
  if (values.length < 3) return "stable";
  const recent = values.slice(-3);
  const earlier = values.slice(0, 3);
  const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
  const earlierAvg = earlier.reduce((s, v) => s + v, 0) / earlier.length;
  if (recentAvg > earlierAvg * 1.3) return "rising";
  if (recentAvg < earlierAvg * 0.7) return "falling";
  return "stable";
}

// ========== 生活阶段检测 ==========

export interface LifePhase {
  month: string;
  phase: "成长/释然" | "压力/挑战" | "过渡";
  posCount: number;
  negCount: number;
  topEmotions: string[];
}

/**
 * 生活阶段检测 — 基于月度正负情绪比
 */
export function getLifePhases(): LifePhase[] {
  const db = getDB();

  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m', event_time) as month,
      json_extract(emotion, '$.primary') as emotion,
      COUNT(*) as count
    FROM memory_events
    WHERE event_time IS NOT NULL
    GROUP BY month, emotion
    ORDER BY month ASC
  `).all() as Array<{ month: string; emotion: string; count: number }>;

  const monthMap = new Map<string, { pos: number; neg: number; emotions: Map<string, number> }>();

  for (const row of rows) {
    if (!monthMap.has(row.month)) {
      monthMap.set(row.month, { pos: 0, neg: 0, emotions: new Map() });
    }
    const m = monthMap.get(row.month)!;
    m.emotions.set(row.emotion, (m.emotions.get(row.emotion) || 0) + row.count);

    if (POSITIVE_EMOTIONS.has(row.emotion)) m.pos += row.count;
    if (NEGATIVE_EMOTIONS.has(row.emotion)) m.neg += row.count;
  }

  const phases: LifePhase[] = [];
  for (const [month, data] of [...monthMap.entries()].sort()) {
    const topEmotions = [...data.emotions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([e]) => e);

    let phase: LifePhase["phase"];
    if (data.pos > data.neg) phase = "成长/释然";
    else if (data.neg > data.pos) phase = "压力/挑战";
    else phase = "过渡";

    phases.push({
      month,
      phase,
      posCount: data.pos,
      negCount: data.neg,
      topEmotions,
    });
  }

  return phases;
}

// ========== 多人对比 ==========

export interface PersonComparison {
  persons: Array<{
    user_id: string;
    total_events: number;
    top_emotions: Array<{ emotion: string; count: number }>;
    valence_ratio: { positive: number; negative: number; neutral: number };
    top_types: Array<{ type: string; count: number }>;
    top_tags: Array<{ tag: string; count: number }>;
  }>;
}

/**
 * 多人情绪对比 — 按 user_id 分组分析
 */
export function comparePersons(): PersonComparison {
  const db = getDB();

  const users = db.prepare(`
    SELECT DISTINCT user_id FROM memory_events WHERE user_id IS NOT NULL
  `).all() as Array<{ user_id: string }>;

  const persons = users.map(({ user_id }) => {
    const totalEvents = (db.prepare(
      "SELECT COUNT(*) as c FROM memory_events WHERE user_id = ?"
    ).get(user_id) as { c: number }).c;

    // 情绪分布
    const emotions = db.prepare(`
      SELECT json_extract(emotion, '$.primary') as emotion, COUNT(*) as count
      FROM memory_events WHERE user_id = ?
      GROUP BY emotion ORDER BY count DESC LIMIT 10
    `).all(user_id) as Array<{ emotion: string; count: number }>;

    // 正负向比例
    const allEmotions = db.prepare(`
      SELECT json_extract(emotion, '$.primary') as emotion, COUNT(*) as count
      FROM memory_events WHERE user_id = ? GROUP BY emotion
    `).all(user_id) as Array<{ emotion: string; count: number }>;

    let pos = 0, neg = 0, neu = 0;
    for (const { emotion, count } of allEmotions) {
      if (POSITIVE_EMOTIONS.has(emotion)) pos += count;
      else if (NEGATIVE_EMOTIONS.has(emotion)) neg += count;
      else neu += count;
    }
    const total = pos + neg + neu || 1;

    // 事件类型分布
    const types = db.prepare(`
      SELECT event_type as type, COUNT(*) as count
      FROM memory_events WHERE user_id = ?
      GROUP BY event_type ORDER BY count DESC LIMIT 5
    `).all(user_id) as Array<{ type: string; count: number }>;

    // 标签分布
    const tags = db.prepare(`
      SELECT json_each.value as tag, COUNT(*) as count
      FROM memory_events, json_each(memory_events.tags)
      WHERE memory_events.user_id = ?
      GROUP BY tag ORDER BY count DESC LIMIT 10
    `).all(user_id) as Array<{ tag: string; count: number }>;

    return {
      user_id,
      total_events: totalEvents,
      top_emotions: emotions,
      valence_ratio: {
        positive: Math.round(pos / total * 100),
        negative: Math.round(neg / total * 100),
        neutral: Math.round(neu / total * 100),
      },
      top_types: types,
      top_tags: tags,
    };
  });

  return { persons };
}

// ========== 实体时序演化 ==========

export interface EntityTimeline {
  entity: string;
  months: Array<{
    month: string;
    count: number;
    top_emotions: string[];
    event_types: string[];
  }>;
}

/**
 * 实体时序演化 — 跟踪某个人物的月度活动和情绪变化
 */
export function getEntityTimeline(entityName: string): EntityTimeline {
  const db = getDB();

  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m', event_time) as month,
      json_extract(emotion, '$.primary') as emotion,
      event_type,
      COUNT(*) as count
    FROM memory_events
    WHERE event_time IS NOT NULL AND entities LIKE ?
    GROUP BY month, emotion, event_type
    ORDER BY month ASC
  `).all(`%"${entityName}"%`) as Array<{
    month: string;
    emotion: string;
    event_type: string;
    count: number;
  }>;

  const monthMap = new Map<string, {
    count: number;
    emotions: Map<string, number>;
    types: Map<string, number>;
  }>();

  for (const row of rows) {
    if (!monthMap.has(row.month)) {
      monthMap.set(row.month, { count: 0, emotions: new Map(), types: new Map() });
    }
    const m = monthMap.get(row.month)!;
    m.count += row.count;
    m.emotions.set(row.emotion, (m.emotions.get(row.emotion) || 0) + row.count);
    m.types.set(row.event_type, (m.types.get(row.event_type) || 0) + row.count);
  }

  const months = [...monthMap.entries()].sort().map(([month, data]) => ({
    month,
    count: data.count,
    top_emotions: [...data.emotions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e]) => e),
    event_types: [...data.types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t),
  }));

  return { entity: entityName, months };
}

// ========== 全局统计摘要 ==========

export function getAnalyticsSummary(): {
  total_events: number;
  date_range: { earliest: string | null; latest: string | null };
  emotion_diversity: number;
  active_months: number;
  top_entities: Array<{ name: string; count: number }>;
} {
  const db = getDB();

  const total = (db.prepare("SELECT COUNT(*) as c FROM memory_events").get() as { c: number }).c;
  const dateRange = db.prepare(
    "SELECT MIN(event_time) as earliest, MAX(event_time) as latest FROM memory_events WHERE event_time IS NOT NULL"
  ).get() as { earliest: string | null; latest: string | null };

  const emotionCount = (db.prepare(
    "SELECT COUNT(DISTINCT json_extract(emotion, '$.primary')) as c FROM memory_events"
  ).get() as { c: number }).c;

  const activeMonths = (db.prepare(
    "SELECT COUNT(DISTINCT strftime('%Y-%m', event_time)) as c FROM memory_events WHERE event_time IS NOT NULL"
  ).get() as { c: number }).c;

  const topEntities = db.prepare(`
    SELECT json_each.value as name, COUNT(*) as count
    FROM memory_events, json_each(memory_events.entities)
    GROUP BY name ORDER BY count DESC LIMIT 10
  `).all() as Array<{ name: string; count: number }>;

  return {
    total_events: total,
    date_range: dateRange,
    emotion_diversity: emotionCount,
    active_months: activeMonths,
    top_entities: topEntities,
  };
}
