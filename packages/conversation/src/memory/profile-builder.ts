import { getLLM } from "../../../ai-client/src/llm";
import { roleLLMConfig, ROLE_MODELS } from "../../../ai-client/src/roles";
import { getDB } from "../../../db/src/database";
import { normalizeLocalDate } from "../../../domain/src/local-date";
import { normalizeOwnerId, resolveOwnerLabel } from "../../../domain/src/owner";
import { getLongTermProfile, upsertProfile } from "./profile-repository";
import type {
  AddressEntry,
  LongTermProfileContent,
  OpenQuestion,
  OpenThread,
  RecentProfileContent,
  UnderstandingCategory,
  UnderstandingItem,
} from "./profile-types";
import { listUnderstandingFeedback } from "./understanding-feedback";

const RECENT_WINDOW_DAYS = 21; // 近期窗口：约三周，覆盖“最近一两周细节 + 一点缓冲”
const LONG_TERM_BATCH = 50; // 长期归纳每批喂给 LLM 的归档天数：滚动精炼(refine)，全覆盖不抽样
const VALID_CATEGORIES: UnderstandingCategory[] = [
  "comfort_strategy", "interaction_preference", "sensitivity",
  "persona", "values", "relationship", "stressor", "parenting_style", "member_trait",
];

interface ArchiveRow {
  archive_date: string;
  summary: string;
}

/**
 * full：读全历史抽样重建 L3（基线校准，成本高）。
 * incremental：只读上次 coversTo 之后的新日志，在既有 L3 上增量合并；无新日志则跳过。
 * 定期 nightly 用 incremental 控成本，定期（或手动）用 full 校准防漂移。
 */
export type ProfileBuildMode = "full" | "incremental";

export interface BuildProfileResult {
  ownerId: string;
  recent: { built: boolean; reason?: string; understandingsOrThreads?: number };
  longTerm: { built: boolean; reason?: string; understandings?: number; mode?: ProfileBuildMode };
}

/** 对某个 owner 重建近期(L2)与长期(L3)理解画像。离线调用（nightly / 手动脚本）。 */
export async function buildMemoryProfile(input: {
  owner_id?: string;
  date?: string;
  mode?: ProfileBuildMode;
}): Promise<BuildProfileResult> {
  const ownerId = normalizeOwnerId(input.owner_id);
  if (!ownerId) throw new Error("owner_id is required");
  const date = normalizeLocalDate(input.date);
  const mode: ProfileBuildMode = input.mode ?? "full";

  const recent = await buildRecentDigest(ownerId, date);
  const longTerm = await buildLongTermUnderstanding(ownerId, date, recent.content, mode);

  return {
    ownerId,
    recent: { built: recent.built, reason: recent.reason, understandingsOrThreads: recent.content?.openThreads.length },
    longTerm: { built: longTerm.built, reason: longTerm.reason, understandings: longTerm.content?.understandings.length, mode: longTerm.mode },
  };
}

// ---------------- L2 近期状态 ----------------

async function buildRecentDigest(ownerId: string, date: string): Promise<{ built: boolean; reason?: string; content?: RecentProfileContent }> {
  const since = addDays(date, -(RECENT_WINDOW_DAYS - 1));
  const archives = getArchives(ownerId, since, date);
  if (archives.length === 0) return { built: false, reason: "no archives in window" };

  const knownDates = new Set(archives.map(a => a.archive_date));
  const ownerLabel = resolveOwnerLabel(ownerId) || ownerId;
  const archiveText = archives.map(a => `[${a.archive_date}] ${clip(a.summary, 360)}`).join("\n");

  let content: RecentProfileContent | null = null;
  try {
    const out = await getLLM(roleLLMConfig("reply")).chatJSON<{
      stateSummary?: string;
      emotionalTrend?: string;
      openThreads?: Array<{ topic?: string; status?: string; lastMentionedAt?: string }>;
      notableEvents?: Array<{ date?: string; summary?: string }>;
    }>(
      `记录者：${ownerLabel}\n近期窗口：${since} 至 ${date}\n\n近 ${archives.length} 天日终归档（按日期）：\n${archiveText}\n\n` +
      `请把上面的归档归纳成“近期状态总结”，帮助助手理解 ${ownerLabel} 最近过得怎么样。输出 JSON：\n` +
      `{\n  "stateSummary": "2-5 句，较具体地概括最近的生活节奏、状态和反复出现的主题",\n` +
      `  "emotionalTrend": "一句话描述近期情绪走向（如：从忙乱逐渐缓和）",\n` +
      `  "openThreads": [{"topic": "未闭合/值得继续关注的话题", "status": "open|watching", "lastMentionedAt": "YYYY-MM-DD"}],\n` +
      `  "notableEvents": [{"date": "YYYY-MM-DD", "summary": "近期关键事件，一句话"}]\n}\n\n` +
      `要求：只基于归档内容，不要编造；日期必须来自上面出现过的归档日期；notableEvents 最多 5 条。`,
      "你是 xfeel 的近期状态归纳助手。只输出 JSON，只基于给定归档，不编造。",
    );
    content = {
      windowDays: RECENT_WINDOW_DAYS,
      stateSummary: clip(str(out.stateSummary), 600),
      emotionalTrend: clip(str(out.emotionalTrend), 120),
      openThreads: normalizeThreads(out.openThreads, knownDates),
      notableEvents: (Array.isArray(out.notableEvents) ? out.notableEvents : [])
        .map(e => ({ date: str(e.date), summary: clip(str(e.summary), 120) }))
        .filter(e => e.summary && knownDates.has(e.date))
        .slice(0, 5),
    };
  } catch {
    // 降级：直接拼最近几条归档作为近期总结，保证在线永远有快照可读。
    content = {
      windowDays: RECENT_WINDOW_DAYS,
      stateSummary: archives.slice(-5).map(a => `${a.archive_date}：${clip(a.summary, 80)}`).join("；"),
      emotionalTrend: "",
      openThreads: [],
      notableEvents: [],
    };
  }

  upsertProfile({
    ownerId, layer: "recent", content,
    coversFrom: since, coversTo: date,
    evidenceCount: archives.length, sourceModel: ROLE_MODELS.reply,
  });
  return { built: true, content };
}

// ---------------- L3 长期理解 ----------------

async function buildLongTermUnderstanding(
  ownerId: string,
  date: string,
  recent: RecentProfileContent | undefined,
  mode: ProfileBuildMode,
): Promise<{ built: boolean; reason?: string; content?: LongTermProfileContent; mode?: ProfileBuildMode }> {
  const existingProfile = getLongTermProfile(ownerId);
  const existing = existingProfile?.content;
  const incremental = mode === "incremental"
    && !!existing?.understandings?.length
    && !!existingProfile?.coversTo;

  // 确定要处理的归档范围与滚动起点(prior)。
  // full：从空理解开始，滚动整段历史(全覆盖，不抽样)。
  // incremental：从既有理解开始，只滚动上次水位线之后的新日志。
  let archives: ArchiveRow[];
  let prior: LongTermProfileContent | undefined;
  let coversFrom: string | undefined;
  let baseEvidence: number;

  if (incremental) {
    const since = addDays(existingProfile!.coversTo!, 1);
    archives = getArchives(ownerId, since, date);
    if (archives.length === 0) {
      return { built: false, reason: `no new diaries since ${existingProfile!.coversTo}`, mode: "incremental" };
    }
    prior = existing;
    coversFrom = existingProfile!.coversFrom || archives[0]!.archive_date;
    baseEvidence = existingProfile!.evidenceCount || 0;
  } else {
    archives = getArchives(ownerId, "0000-00-00", date);
    if (archives.length === 0) return { built: false, reason: "no archives", mode: "full" };
    prior = undefined; // full 从头滚动，做干净的基线校准
    coversFrom = archives[0]!.archive_date;
    baseEvidence = 0;
  }

  const ownerLabel = resolveOwnerLabel(ownerId) || ownerId;
  const addressHint = collectAddressHints(ownerId);
  const batches = chunk(archives, LONG_TERM_BATCH);
  // 已知日期随滚动累积：prior 的旧支撑日期 + 已处理批次的日期，避免 LLM 沿用旧日期被校验丢弃。
  const knownDates = new Set<string>(prior?.understandings?.flatMap(u => u.supportDates || []) || []);

  let acc: LongTermProfileContent | undefined = prior;
  let folded = false;
  for (const batch of batches) {
    for (const a of batch) knownDates.add(a.archive_date);
    const next = await synthesizeLongTermBatch({ ownerId, ownerLabel, date, recent, prior: acc, batch, knownDates, addressHint });
    if (next) { acc = next; folded = true; }
  }

  if (!folded || !acc || (acc.understandings.length === 0 && !acc.narrative)) {
    return { built: false, reason: "no supported understandings produced", mode: incremental ? "incremental" : "full" };
  }

  upsertProfile({
    ownerId, layer: "long_term", content: acc,
    coversFrom, coversTo: date,
    evidenceCount: baseEvidence + archives.length, sourceModel: ROLE_MODELS.reply,
  });
  return { built: true, content: acc, mode: incremental ? "incremental" : "full" };
}

/** 滚动精炼(refine)的单批：在 prior 理解之上、用这批归档更新出完整理解集合。失败/空则保留 prior。 */
async function synthesizeLongTermBatch(input: {
  ownerId: string;
  ownerLabel: string;
  date: string;
  recent: RecentProfileContent | undefined;
  prior: LongTermProfileContent | undefined;
  batch: ArchiveRow[];
  knownDates: Set<string>;
  addressHint: string;
}): Promise<LongTermProfileContent | null> {
  const { ownerId, ownerLabel, date, recent, prior, batch, knownDates, addressHint } = input;
  const hasPrior = !!prior?.understandings?.length;
  const archiveText = batch.map(a => `[${a.archive_date}] ${clip(a.summary, 280)}`).join("\n");
  const feedbackText = listUnderstandingFeedback(ownerId).map(f =>
    `- ${f.action}: ${f.originalStatement}${f.replacementStatement ? ` → ${f.replacementStatement}` : ""}`,
  ).join("\n") || "（无）";
  const existingText = hasPrior
    ? prior!.understandings.map(u => `- (${u.category}/${u.subject}) ${u.statement} ⟵ ${(u.supportDates || []).join(",")}`).join("\n")
    : "（暂无既有理解）";
  const mergeInstruction = hasPrior
    ? `请在「既有长期理解」基础上更新：保留仍成立的条目（沿用其原 supportDates），用这批日志强化已有理解（把新日期并入对应 supportDates）或补充新出现的稳定模式，被明显推翻的可以不再输出。必须输出更新后的完整理解集合。`
    : `请从这批日志中沉淀稳定的长期理解。`;

  try {
    const out = await getLLM(roleLLMConfig("reply")).chatJSON<{
      narrative?: string;
      understandings?: Array<Partial<UnderstandingItem> & { supportDates?: string[] }>;
      addressBook?: Array<Partial<AddressEntry>>;
      openQuestions?: Array<Partial<OpenQuestion>>;
    }>(
      `记录者：${ownerLabel}\n今天：${date}\n\n` +
      `既有长期理解：\n${existingText}\n\n` +
      (recent?.stateSummary ? `近期状态总结：\n${recent.stateSummary}\n\n` : "") +
      `本批归档（共 ${batch.length} 天，按日期）：\n${archiveText}\n\n` +
      `称呼线索（已记录的家庭成员叫法）：\n${addressHint || "（无）"}\n\n` +
      `用户对既有理解的明确反馈（最高优先级）：\n${feedbackText}\n\n` +
      `${mergeInstruction}\n\n` +
      `请沉淀出对 ${ownerLabel} 的“长期理解画像”，目标是让助手能像家人一样懂 ${ownerLabel}。输出 JSON：\n` +
      `{\n  "narrative": "一段 3-5 句的自然语言画像：${ownerLabel} 是个怎样的人、在乎什么、最近的底色",\n` +
      `  "understandings": [{\n    "category": "${VALID_CATEGORIES.join("|")}",\n` +
      `    "subject": "描述对象（${ownerLabel} 自己或某家庭成员的称呼）",\n` +
      `    "statement": "一条理解性陈述（不是某次具体事件，而是反复印证的稳定理解）",\n` +
      `    "kind": "observed|inferred",\n    "supportDates": ["YYYY-MM-DD", "..."],\n` +
      `    "firstSeenAt": "YYYY-MM-DD", "lastConfirmedAt": "YYYY-MM-DD"\n  }],\n` +
      `  "addressBook": [{"member": "成员", "preferredAddress": "用户习惯叫法", "aliases": ["..."], "relation": "与记录者关系"}],\n` +
      `  "openQuestions": [{"topic": "对理解 ${ownerLabel} 重要但还不清楚的事", "why": "为什么重要", "priority": 1}]\n}\n\n` +
      `硬要求：\n` +
      `1. 优先输出“共情可执行”的理解（comfort_strategy/interaction_preference/sensitivity）：怎样回应 ${ownerLabel} 才贴心、什么话题要轻拿轻放。\n` +
      `2. 每条 understanding 必须至少有 2 个 supportDates，且日期必须来自“既有理解里出现过的日期”或本批归档日期；只有单次/微弱信号的不要升格为稳定理解。\n` +
      `3. 不要写进具体数字/某一天的具体事件当结论——那是事件证据层的事；这里只写稳定的、反复出现的理解。\n` +
      `4. understandings 最多 12 条，openQuestions 最多 4 条。\n` +
      `5. 用户反馈是硬约束：confirm/correct 要保留其意思；reject/retract 的原意不得换一种说法重新加入。`,
      "你是 xfeel 的长期理解归纳助手。只输出 JSON。理解必须基于反复印证的归档信号，不编造、不过度概括。",
    );
    const understandings = normalizeUnderstandings(out.understandings, knownDates, date);
    const content: LongTermProfileContent = {
      narrative: clip(str(out.narrative), 500) || prior?.narrative || "",
      understandings,
      addressBook: normalizeAddressBook(out.addressBook),
      openQuestions: normalizeOpenQuestions(out.openQuestions),
    };
    // 本批没产出有效内容时，保留滚动到目前为止的 prior，不让一批空结果把累积清空。
    if (understandings.length === 0 && !str(out.narrative)) return prior ?? null;
    if (!content.addressBook.length && prior?.addressBook?.length) content.addressBook = prior.addressBook;
    if (!content.openQuestions.length && prior?.openQuestions?.length) content.openQuestions = prior.openQuestions;
    return content;
  } catch {
    return prior ?? null; // 本批 LLM 失败，保留已滚动的累积
  }
}

// ---------------- guards / helpers ----------------

/** 校验 + 计算拆解置信度：丢弃支撑不足或日期不存在的理解，杜绝多级摘要漂移成“事实”。 */
function normalizeUnderstandings(
  raw: Array<Partial<UnderstandingItem> & { supportDates?: string[] }> | undefined,
  knownDates: Set<string>,
  today: string,
): UnderstandingItem[] {
  if (!Array.isArray(raw)) return [];
  const out: UnderstandingItem[] = [];
  for (const item of raw) {
    const category = item.category as UnderstandingCategory;
    const statement = str(item.statement);
    if (!VALID_CATEGORIES.includes(category) || !statement) continue;
    const supportDates = (Array.isArray(item.supportDates) ? item.supportDates : [])
      .map(d => str(d)).filter(d => knownDates.has(d));
    if (supportDates.length < 2) continue; // 不过度概括：至少 2 条真实支撑

    const lastConfirmedAt = pickLatest(supportDates) || str(item.lastConfirmedAt) || undefined;
    const firstSeenAt = pickEarliest(supportDates) || str(item.firstSeenAt) || undefined;
    const recencyDays = lastConfirmedAt ? daysBetween(lastConfirmedAt, today) : undefined;
    const kind = item.kind === "inferred" ? "inferred" : "observed";
    const support = {
      evidenceCount: supportDates.length,
      recencyDays,
      consistency: 1,
      userConfirmed: false,
    };
    out.push({
      category,
      subject: str(item.subject) || "记录者",
      statement: clip(statement, 160),
      kind,
      status: "active",
      confidence: deriveConfidence(support, kind),
      support,
      supportDates,
      firstSeenAt,
      lastConfirmedAt,
    });
  }
  // 排序：共情可执行类优先，再按 confidence。注入时高分在前。
  return out.sort((a, b) => empathyRank(a.category) - empathyRank(b.category) || b.confidence - a.confidence).slice(0, 12);
}

function deriveConfidence(support: UnderstandingItem["support"], kind: UnderstandingItem["kind"]): number {
  let score = 0.3 + 0.12 * Math.min(support.evidenceCount, 5); // 证据越多越高，封顶
  if (support.recencyDays !== undefined) {
    if (support.recencyDays <= 14) score += 0.1;
    else if (support.recencyDays > 90) score -= 0.1; // 久未印证，降权
  }
  if (kind === "inferred") score -= 0.1; // 推断比观察低
  if (support.userConfirmed) score += 0.15;
  return Math.max(0.1, Math.min(0.99, Number(score.toFixed(2))));
}

const EMPATHY_FIRST: UnderstandingCategory[] = ["comfort_strategy", "interaction_preference", "sensitivity"];
function empathyRank(category: UnderstandingCategory): number {
  return EMPATHY_FIRST.includes(category) ? 0 : 1;
}

function normalizeThreads(raw: unknown, knownDates: Set<string>): OpenThread[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t: { topic?: string; status?: string; lastMentionedAt?: string }) => ({
      topic: clip(str(t.topic), 80),
      status: t.status === "watching" ? "watching" as const : "open" as const,
      lastMentionedAt: knownDates.has(str(t.lastMentionedAt)) ? str(t.lastMentionedAt) : undefined,
    }))
    .filter(t => t.topic)
    .slice(0, 6);
}

function normalizeAddressBook(raw: Array<Partial<AddressEntry>> | undefined): AddressEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(a => ({
      member: str(a.member),
      preferredAddress: str(a.preferredAddress) || str(a.member),
      aliases: Array.isArray(a.aliases) ? a.aliases.map(x => str(x)).filter(Boolean) : [],
      relation: a.relation ? str(a.relation) : undefined,
    }))
    .filter(a => a.member)
    .slice(0, 12);
}

function normalizeOpenQuestions(raw: Array<Partial<OpenQuestion>> | undefined): OpenQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(q => ({ topic: clip(str(q.topic), 80), why: clip(str(q.why), 100), priority: clampPriority(q.priority) }))
    .filter(q => q.topic)
    .slice(0, 4);
}

function collectAddressHints(ownerId: string): string {
  try {
    const rows = getDB().prepare(`
      SELECT value, surface, COUNT(*) as c FROM memory_open_facts
      WHERE owner_id = ? AND kind IN ('person', 'name', 'address', 'nickname')
      GROUP BY value ORDER BY c DESC LIMIT 12
    `).all(ownerId) as Array<{ value: string; surface: string; c: number }>;
    return rows.map(r => r.surface || r.value).filter(Boolean).join("、");
  } catch {
    return "";
  }
}

/**
 * 取某 owner 的“每日日志/归档”作为归纳输入。
 * 来源是 diaries 表：它同时含历史导入日记与日终归档（archive 也会写入 diaries），
 * 是“持续对话和日志”最完整的沉淀。按日去重（同一天多条取最长一条），日期归一化为 YYYY-MM-DD。
 */
function getArchives(ownerId: string, since: string, until: string): ArchiveRow[] {
  const rows = getDB().prepare(`
    SELECT substr(diary_date, 1, 10) AS archive_date, content AS summary
    FROM diaries
    WHERE user_id = ? AND diary_date IS NOT NULL AND trim(content) != ''
      AND substr(diary_date, 1, 10) BETWEEN ? AND ?
    ORDER BY diary_date ASC
  `).all(ownerId, since, until) as ArchiveRow[];

  // 按日去重：同一天保留信息量最大（最长）的一条。
  const byDate = new Map<string, string>();
  for (const row of rows) {
    if (!row.archive_date) continue;
    const prev = byDate.get(row.archive_date);
    if (!prev || row.summary.length > prev.length) byDate.set(row.archive_date, row.summary);
  }
  return [...byDate.entries()]
    .map(([archive_date, summary]) => ({ archive_date, summary }))
    .sort((a, b) => a.archive_date.localeCompare(b.archive_date));
}

/** 按固定大小切批，供长期理解滚动精炼(refine)使用。 */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
function clampPriority(p: unknown): number {
  const n = Number(p);
  return Number.isInteger(n) && n >= 1 && n <= 3 ? n : 2;
}
function pickLatest(dates: string[]): string | undefined {
  return [...dates].sort().at(-1);
}
function pickEarliest(dates: string[]): string | undefined {
  return [...dates].sort()[0];
}
function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}
function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
