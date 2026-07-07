import { z } from "zod";
import { OPEN_FACT_KINDS } from "./open-facts";

// 情绪类型枚举 — 合并 Plutchik + PANAS + 特殊词
export const EmotionType = z.enum([
  // Plutchik 喜
  "欣喜", "开心", "平静",
  // Plutchik 信
  "崇拜", "信任", "接受",
  // Plutchik 惊
  "震惊", "惊喜", "意外",
  // Plutchik 惧
  "恐惧", "焦虑", "担心",
  // Plutchik 悲
  "悲痛", "失落", "惆怅",
  // Plutchik 厌
  "憎恶", "厌烦", "无聊",
  // Plutchik 怒
  "狂怒", "愤怒", "烦躁",
  // Plutchik 期
  "急切", "期待", "留意",
  // PANAS 正面补充
  "自豪", "感恩", "满足", "感动", "释然", "精力充沛", "专注", "坚定",
  // PANAS 负面补充
  "疲惫", "愧疚", "无助", "压力", "委屈", "心疼", "无奈", "迷茫", "孤独", "紧张",
  // 特殊复合词
  "崩溃", "思念", "矛盾",
]);
export type EmotionType = z.infer<typeof EmotionType>;

// 事件类型枚举
export const EventType = z.enum([
  "sleep",         // 睡眠相关
  "feeding",       // 喂养相关
  "health",        // 健康/生病
  "milestone",     // 成长里程碑
  "emotion",       // 情绪事件
  "care",          // 照护活动
  "conflict",      // 冲突/矛盾
  "work",          // 工作相关
  "social",        // 社交相关
  "daily",         // 日常琐事
  "reflection",    // 反思/感悟
  "other",         // 其他
]);
export type EventType = z.infer<typeof EventType>;

// 情绪结构
export const EmotionSchema = z.object({
  primary: EmotionType,              // 主要情绪
  secondary: EmotionType.optional(), // 次要情绪
  intensity: z.number().min(0).max(1), // 强度 0-1
  valence: z.enum(["positive", "negative", "neutral"]), // 正负向
});
export type Emotion = z.infer<typeof EmotionSchema>;

export const OpenFactSchema = z.object({
  id: z.string().optional(),
  event_id: z.string().optional(),
  kind: z.enum(OPEN_FACT_KINDS),
  value: z.string(),
  surface: z.string(),
  evidence_span: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
  confidence: z.number().min(0).max(1).optional(),
  polarity: z.enum(["actual", "negated", "hypothetical", "concern"]).default("actual").optional(),
  actor_id: z.string().optional(),
  experiencer_id: z.string().optional(),
  observer_id: z.string().optional(),
});

// 记忆事件 schema
export const MemoryEventSchema = z.object({
  id: z.string().uuid().optional(),
  raw_message_id: z.string().optional(),
  
  // 内容
  summary: z.string(),               // 一句话摘要
  original_text: z.string(),         // 原始文本
  original_span: z.string().optional(), // 源文本中用于抽取该事件的原始片段
  
  // 结构化
  event_type: EventType,             // 事件类型
  entities: z.array(z.string()),     // 涉及的人/物
  emotion: EmotionSchema,            // 情绪
  tags: z.array(z.string()),         // 兼容旧字段：粗标签，不再承载长尾细节
  open_facts: z.array(OpenFactSchema).optional(), // typed open facts：长尾事实/证据/语义召回主字段
  location: z.string().optional(),   // 地点
  
  // 时间
  event_time: z.string().optional(), // 事件实际时间 (ISO string)
  event_date: z.string().optional(), // 事件日期 (YYYY-MM-DD)，用于过滤/排序兜底
  confidence: z.number().min(0).max(1).default(1), // 抽取置信度
  
  // 来源
  source: z.enum(["user", "agent", "system", "inferred", "external:structured"]).default("user"),
  source_layer: z.enum(["raw", "extracted", "inferred", "structured"]).default("extracted"),
  source_archive_id: z.string().optional(),
  
  // 元数据
  user_id: z.string().optional(),    // 兼容旧字段名，实际存 owner_id
  event_index: z.number().int().nonnegative().optional(),
  extractor_version: z.string().optional(),
  vocab_version: z.string().optional(),
  search_text_version: z.string().optional(),
  created_at: z.string().optional(),
});
export type MemoryEvent = z.infer<typeof MemoryEventSchema>;

// 消息分类结果
export const ClassifyResultSchema = z.object({
  is_meaningful: z.boolean(),        // 是否有意义
  modality: z.enum(["text", "voice", "image", "video", "mixed"]),
  category: z.enum(["diary", "command", "chat", "noise"]).default("diary"),
  reason: z.string().optional(),
});
export type ClassifyResult = z.infer<typeof ClassifyResultSchema>;

// 实体
export const EntitySchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string(),
  type: z.enum(["person", "baby", "place", "pet", "other"]),
  aliases: z.array(z.string()).default([]),
  attributes: z.record(z.string(), z.unknown()).default({}),
  first_seen: z.string().optional(),
  last_seen: z.string().optional(),
});
export type Entity = z.infer<typeof EntitySchema>;
