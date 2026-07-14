/**
 * 记忆理解画像（profile）类型定义。
 *
 * 设计目标（来自产品洞察）：recall 的根本目的不是“检索相似事件”，而是“增加对这个人的
 * 理解”，从而形成真正的共情回复。因此上下文分三层时间尺度：
 *   - L3 长期理解（long_term）：从持续对话/日志沉淀出的稳定画像，离线周期归纳。
 *   - L2 近期状态（recent）：最近一两周的较详细状态总结，离线每日归纳。
 *   - L1 当天连续（today）：当天对话，在线实时拼装（见 session-context）。
 *   - L0 事件证据（evidence）：具体事实/日期，按意图按需召回（见 recall）。
 *
 * 关键纪律：
 *   - 理解是“可被当下推翻的假设”，不是事实。注入回复时用于定调/方向，禁止逐字当事实复述。
 *   - 每条理解必须能回溯到支撑它的归档日期（supportDates），无支撑不得输出。
 *   - 理解有生命周期：observed/inferred、status、confidence 拆解、lastConfirmedAt。
 */

import type { PreferredNarrative } from "../wisdom/lever-types";

export type ProfileLayer = "long_term" | "recent";

export type UnderstandingCategory =
  // 共情可执行类（最直接服务于“怎么回应这个人”）
  | "comfort_strategy" // 什么能安抚 ta / ta 需要被怎样接住
  | "interaction_preference" // 沟通节奏、想要建议还是倾听
  | "sensitivity" // 要轻拿轻放或绝对别说的话题
  // 传记/画像类
  | "persona" // 性格、自我认同
  | "values" // 在乎什么、价值观
  | "relationship" // 与家人的关系动态
  | "stressor" // 常见压力源
  | "parenting_style" // 养育风格
  | "member_trait"; // 某个家庭成员的稳定特征

/** 一条理解被多大程度支撑——拆解的置信度，而不是单一“模型自信”。 */
export interface UnderstandingSupport {
  evidenceCount: number; // 支撑证据/归档数
  recencyDays?: number; // 最近一次被印证距今天数（越小越新鲜）
  consistency: number; // 0..1，是否有相互矛盾的信号（1=无矛盾）
  userConfirmed: boolean; // 用户是否明确确认过
}

export interface UnderstandingItem {
  category: UnderstandingCategory;
  subject: string; // 描述对象：owner 自己 / 某家庭成员称呼
  statement: string; // 理解性陈述（非逐字事实）
  kind: "observed" | "inferred"; // 直接观察 vs 推断；推断衰减更快、更需复核
  status: "active" | "superseded" | "retracted";
  confidence: number; // 0..1 综合分（由 support 推导，便于排序/裁剪）
  support: UnderstandingSupport;
  supportDates: string[]; // 支撑的归档日期 YYYY-MM-DD，可回溯审计
  firstSeenAt?: string; // 首次出现日期
  lastConfirmedAt?: string; // 最近一次被印证日期
}

export interface AddressEntry {
  member: string; // 家庭成员（规范称呼）
  preferredAddress: string; // 用户习惯叫法
  aliases: string[];
  relation?: string; // 与 owner 的关系
}

/** 系统知道自己“对这个人还不了解什么”——主动好奇的缺口，供合适时机温和追问。 */
export interface OpenQuestion {
  topic: string;
  why: string; // 为什么这对理解 ta 重要
  priority: number; // 1(高)..3(低)
}

/** L3 长期理解快照内容。 */
export interface LongTermProfileContent {
  understandings: UnderstandingItem[];
  addressBook: AddressEntry[];
  openQuestions: OpenQuestion[];
  narrative?: string; // 一段“这个人是谁”的自然语言画像，便于直接注入
  /**
   * 首选叙事：用户在智慧干预中**自己说出**的、对自己处境更宽的解释（见 wisdom/）。
   * 与 understandings 不同，它不是归纳产物，离线重建不得生成或覆盖它。
   */
  preferredNarratives?: PreferredNarrative[];
}

export interface OpenThread {
  topic: string;
  status: "open" | "watching";
  lastMentionedAt?: string;
}

/** L2 近期状态快照内容（较详细的近期总结）。 */
export interface RecentProfileContent {
  windowDays: number;
  stateSummary: string; // 近期状态的较详细总结（自然段，2-5 句）
  emotionalTrend: string; // 近期情绪走向
  openThreads: OpenThread[]; // 未闭合/值得继续关注的话题
  notableEvents: Array<{ date: string; summary: string }>; // 近期关键事件（带日期，可回溯）
}

export interface MemoryProfile<C = unknown> {
  id: string;
  ownerId: string;
  layer: ProfileLayer;
  content: C;
  version: number;
  coversFrom?: string;
  coversTo?: string;
  evidenceCount: number;
  sourceModel?: string;
  generatedAt: string;
  updatedAt: string;
}

export type LongTermProfile = MemoryProfile<LongTermProfileContent>;
export type RecentProfile = MemoryProfile<RecentProfileContent>;
