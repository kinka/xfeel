/**
 * 事件归一化 — 批量去重 + 因果拆分
 *
 * 来自 diary-knowledge-graph 技能第 3 步：
 * v1 经验: 41 原始事件 → 32 规范化事件，去重率 22%
 *
 * 运行模式:
 *  - 实时: ingest 后调 checkDuplicate() 检查单条
 *  - 批量: /normalize/run 对全库跑一次
 */

import { getDB } from "../../db/src/database";
import { getLLM } from "../../ai-client/src/llm";
import { roleLLMConfig } from "../../ai-client/src/roles";
import type { MemoryEvent } from "../../domain/src/memory-event";

export interface DedupResult {
  total_events: number;
  duplicates_found: number;
  merged: number;
  splits: number;       // 因果拆分产生的新事件对
  details: Array<{
    action: "merged" | "split" | "keep";
    event_id: string;
    summary: string;
    merged_into?: string;
    split_into?: string[];
  }>;
}

export interface DuplicateCandidate {
  existing: MemoryEvent;
  incoming: MemoryEvent;
  similarity: number;
  reason: string;
}

/**
 * 快速相似度检查（规则 + 文本重叠，不调 LLM）
 * 用于实时 ingest 时的快速判断
 */
export function quickSimilarity(a: string, b: string): number {
  // Jaccard on 2-grams
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const sa = bigrams(a);
  const sb = bigrams(b);
  const intersection = new Set([...sa].filter(x => sb.has(x)));
  const union = new Set([...sa, ...sb]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

/**
 * 实时去重检查 — ingest 后调用
 * 返回最可能的重复事件，或 null
 */
export function checkDuplicate(
  newEvent: MemoryEvent,
  lookbackDays: number = 7,
  threshold: number = 0.45,
): MemoryEvent | null {
  if (!newEvent.id) return null;
  const db = getDB();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);

  const rows = db.prepare(`
    SELECT * FROM memory_events
    WHERE created_at >= ? AND id != ?
    ORDER BY created_at DESC LIMIT 200
  `).all(cutoff.toISOString(), newEvent.id) as Array<Record<string, unknown>>;

  let bestMatch: MemoryEvent | null = null;
  let bestScore = 0;

  for (const row of rows) {
    const existing = rowToEvent(row);
    // 1. summary 相似度
    const summarySim = quickSimilarity(newEvent.summary, existing.summary);
    // 2. 同实体加分
    const sharedEntities = newEvent.entities.filter(e => existing.entities.includes(e));
    const entityBonus = sharedEntities.length > 0 ? 0.15 : 0;
    // 3. 同情绪加分
    const emotionBonus = newEvent.emotion.primary === existing.emotion.primary ? 0.1 : 0;
    // 4. 同类型加分
    const typeBonus = newEvent.event_type === existing.event_type ? 0.1 : 0;

    const score = summarySim + entityBonus + emotionBonus + typeBonus;
    if (score > bestScore && score >= threshold) {
      bestScore = score;
      bestMatch = existing;
    }
  }

  return bestMatch;
}

/**
 * 批量归一化 — 对全库事件做去重 + 因果拆分
 * 调 LLM 做语义判断
 */
export async function runBatchNormalization(opts: {
  lookbackDays?: number;
  dryRun?: boolean;
} = {}): Promise<DedupResult> {
  const db = getDB();
  const lookbackDays = opts.lookbackDays || 90;
  const dryRun = opts.dryRun ?? false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);

  const rows = db.prepare(`
    SELECT * FROM memory_events
    WHERE created_at >= ?
    ORDER BY event_time ASC, created_at ASC
  `).all(cutoff.toISOString()) as Array<Record<string, unknown>>;

  const events = rows.map(rowToEvent);
  const result: DedupResult = {
    total_events: events.length,
    duplicates_found: 0,
    merged: 0,
    splits: 0,
    details: [],
  };

  if (events.length < 2) return result;

  // Step 1: 快速预筛选 — 找出可能重复的对
  const candidates: Array<{ a: MemoryEvent; b: MemoryEvent; score: number }> = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const sim = quickSimilarity(events[i].summary, events[j].summary);
      if (sim >= 0.3) {
        candidates.push({ a: events[i], b: events[j], score: sim });
      }
    }
  }

  // Step 2: LLM 精确判断（批量，每批 10 对）
  const BATCH_SIZE = 10;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const pairs = batch.map((c, idx) => ({
      idx,
      a: { id: c.a.id, summary: c.a.summary, entities: c.a.entities, emotion: c.a.emotion.primary, type: c.a.event_type },
      b: { id: c.b.id, summary: c.b.summary, entities: c.b.entities, emotion: c.b.emotion.primary, type: c.b.event_type },
    }));

    try {
      const llm = getLLM(roleLLMConfig("extract"));
      const judgment = await llm.chatJSON<Array<{
        idx: number;
        action: "duplicate" | "split" | "different";
        merged_to?: string;
        reason: string;
      }>>(
        `判断以下事件对是否重复、需要因果拆分、还是不同事件。

事件对:
${JSON.stringify(pairs, null, 2)}

规则:
1. "duplicate": 同一件事的不同表述，应合并（保留信息更丰富的那个）
2. "split": 一个标签包含因果关系（如"X导致Y"），应拆成两个事件+因果边
3. "different": 不同事件，保留两者

输出 JSON 数组: [{idx, action, merged_to?, reason}]`,
        "你是事件归一化助手。只输出 JSON，不要解释。"
      );

      for (const j of judgment) {
        const pair = batch[j.idx];
        if (!pair) continue;

        if (j.action === "duplicate") {
          if (!pair.a.id || !pair.b.id) continue;
          result.duplicates_found++;
          const keepId = j.merged_to === pair.a.id ? pair.a.id : pair.b.id;
          const removeId = keepId === pair.a.id ? pair.b.id : pair.a.id;

          if (!dryRun) {
            // 合并: 保留 keepId 的事件，删除 removeId
            // 把 removeId 的原文追加到 keepId
            const keepRow = db.prepare("SELECT original_text FROM memory_events WHERE id = ?").get(keepId) as { original_text: string } | undefined;
            const removeRow = db.prepare("SELECT original_text FROM memory_events WHERE id = ?").get(removeId) as { original_text: string } | undefined;
            if (keepRow && removeRow) {
              const merged = keepRow.original_text + "\n---\n" + removeRow.original_text;
              db.prepare("UPDATE memory_events SET original_text = ?, updated_at = datetime('now') WHERE id = ?").run(merged, keepId);
            }
            // 删除重复事件
            db.prepare("DELETE FROM memory_events WHERE id = ?").run(removeId);
          }

          result.merged++;
          result.details.push({
            action: "merged",
            event_id: removeId,
            summary: removeId === pair.a.id ? pair.a.summary : pair.b.summary,
            merged_into: keepId,
          });
        } else if (j.action === "split") {
          if (!pair.a.id || !pair.b.id) continue;
          result.splits++;
          result.details.push({
            action: "split",
            event_id: pair.a.id,
            summary: pair.a.summary,
            split_into: [pair.b.id],
          });
        } else {
          if (!pair.a.id) continue;
          result.details.push({
            action: "keep",
            event_id: pair.a.id,
            summary: pair.a.summary,
          });
        }
      }
    } catch (e) {
      console.error("LLM dedup batch failed:", e);
      // 降级: 全部保留
      for (const pair of batch) {
        if (!pair.a.id) continue;
        result.details.push({ action: "keep", event_id: pair.a.id, summary: pair.a.summary });
      }
    }

    // 避免 rate limit
    if (i + BATCH_SIZE < candidates.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return result;
}

/**
 * 获取归一化统计
 */
export function getNormalizationStats(): {
  total: number;
  potential_duplicates: number;
  recent_7d: number;
  type_distribution: Record<string, number>;
} {
  const db = getDB();
  const total = (db.prepare("SELECT COUNT(*) as c FROM memory_events").get() as { c: number }).c;

  const cutoff7d = new Date();
  cutoff7d.setDate(cutoff7d.getDate() - 7);
  const recent7d = (db.prepare("SELECT COUNT(*) as c FROM memory_events WHERE created_at >= ?").get(cutoff7d.toISOString()) as { c: number }).c;

  // 快速扫描最近 7 天的潜在重复
  const recent = db.prepare(`
    SELECT id, summary FROM memory_events WHERE created_at >= ? ORDER BY created_at DESC LIMIT 100
  `).all(cutoff7d.toISOString()) as Array<{ id: string; summary: string }>;

  let potentialDuplicates = 0;
  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      if (quickSimilarity(recent[i].summary, recent[j].summary) >= 0.45) {
        potentialDuplicates++;
      }
    }
  }

  const types = db.prepare(`
    SELECT event_type, COUNT(*) as c FROM memory_events GROUP BY event_type ORDER BY c DESC
  `).all() as Array<{ event_type: string; c: number }>;
  const typeDistribution: Record<string, number> = {};
  for (const t of types) typeDistribution[t.event_type] = t.c;

  return {
    total,
    potential_duplicates: potentialDuplicates,
    recent_7d: recent7d,
    type_distribution: typeDistribution,
  };
}

function rowToEvent(row: Record<string, unknown>): MemoryEvent {
  return {
    id: row.id as string,
    raw_message_id: row.raw_message_id as string | undefined,
    summary: row.summary as string,
    original_text: row.original_text as string,
    event_type: row.event_type as MemoryEvent["event_type"],
    entities: JSON.parse(row.entities as string || "[]"),
    emotion: JSON.parse(row.emotion as string || "{}"),
    tags: JSON.parse(row.tags as string || "[]"),
    location: row.location as string | undefined,
    event_time: row.event_time as string | undefined,
    confidence: row.confidence as number,
    source: row.source as MemoryEvent["source"],
    source_layer: row.source_layer as MemoryEvent["source_layer"],
    user_id: row.user_id as string | undefined,
    created_at: row.created_at as string,
  };
}
