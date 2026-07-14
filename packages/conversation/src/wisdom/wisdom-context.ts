import { isResurfaceable } from "../../../care/src/guard";
import { normalizeOwnerId } from "../../../domain/src/owner";
import { findPositiveEvidence } from "./evidence-lookup";
import { detectLevers, hasDistressSignal } from "./lever-detector";
import { getLastInterventionDate, getLeverRecurrence, recordLeverHits } from "./lever-store";
import {
  EMPTY_PLAN,
  LEVER_LABELS,
  type ConstrualLever,
  type LeverDetection,
  type LeverHit,
  type NarrativeEvidence,
  type WisdomPlan,
} from "./lever-types";

/** 依赖注入点（测试用；bun 的 mock.module 是进程级的，会泄漏进别的测试文件）。 */
export interface WisdomDeps {
  detect: (input: { text: string; recentDialogue?: string }) => Promise<LeverDetection>;
  findEvidence: typeof findPositiveEvidence;
}

const DEFAULT_DEPS: WisdomDeps = { detect: detectLevers, findEvidence: findPositiveEvidence };

/**
 * 智慧干预的在线闸门 + 提示层。
 *
 * 这个模块存在的意义有一半在于**不干预**：
 * 危机内容不干预（那需要的是陪伴和求助资源，不是反问）、
 * 单次低落不干预（那是正常情绪）、刚干预过不干预（否则每次难过都被追问，变成骚扰）。
 * 只有当同一种消极解释跨天反复出现时，才值得用一个小问题把解释权交回给用户。
 */

const WINDOW_DAYS = envInt("XFEEL_WISDOM_WINDOW_DAYS", 14, 1, 90);
const MIN_CONFIDENCE = envFloat("XFEEL_WISDOM_MIN_CONFIDENCE", 0.6);
/** 窗口内至少几天出现过同一杠杆（含今天）才干预。2 = 至少跨两天复现。 */
const MIN_RECURRENCE_DAYS = envInt("XFEEL_WISDOM_MIN_DAYS", 2, 1, 30);
/** 冷却期：距上次干预不足这些天，一律不再发问。 */
const COOLDOWN_DAYS = envInt("XFEEL_WISDOM_COOLDOWN_DAYS", 3, 0, 90);

export function isWisdomEnabled(): boolean {
  return process.env.XFEEL_WISDOM_DISABLED !== "1";
}

/**
 * 识别 → 落库 → 闸门 → 取反例 → 生成提示块。
 * 无论是否干预，命中都会落库：复现统计要靠它，且用户看不到任何"你被标注了"的痕迹。
 */
export async function loadWisdomContext(input: {
  owner_id?: string;
  text: string;
  date: string;
  recentDialogue?: string;
  turn_id?: string;
  scope_owner_ids?: string[];
}, deps: WisdomDeps = DEFAULT_DEPS): Promise<WisdomPlan> {
  if (!isWisdomEnabled()) return { ...EMPTY_PLAN, skipReason: "disabled" };
  const owner = normalizeOwnerId(input.owner_id);
  if (!owner) return { ...EMPTY_PLAN, skipReason: "no_owner" };

  const text = input.text?.trim() || "";
  // 危机/丧失类内容：绝不做业余心理干预。这类话需要的是"我在"，不是一个巧妙的问题。
  if (!isResurfaceable({ original_text: text })) return { ...EMPTY_PLAN, skipReason: "sensitive" };
  if (!hasDistressSignal(text)) return { ...EMPTY_PLAN, skipReason: "no_distress" };

  const detection = await deps.detect({ text, recentDialogue: input.recentDialogue });
  if (!detection.hits.length) return { ...EMPTY_PLAN, skipReason: "no_lever" };
  recordLeverHits({ ownerId: owner, hits: detection.hits, date: input.date, turnId: input.turn_id });

  const hit = pickLever(detection.hits);
  if (!hit) return { ...EMPTY_PLAN, hits: detection.hits, skipReason: "no_lever" };

  const recurrence = getLeverRecurrence({
    ownerId: owner,
    lever: hit.lever,
    since: addDays(input.date, -(WINDOW_DAYS - 1)),
    until: input.date,
    minConfidence: MIN_CONFIDENCE,
  });
  // 单次低落 = 正常情绪，不是认知模式。这一条挡掉的量最大，也最重要。
  if (recurrence.days < MIN_RECURRENCE_DAYS) {
    return { ...EMPTY_PLAN, hits: detection.hits, skipReason: "not_recurring" };
  }

  const lastIntervention = getLastInterventionDate(owner);
  if (lastIntervention && daysBetween(lastIntervention, input.date) < COOLDOWN_DAYS) {
    return { ...EMPTY_PLAN, hits: detection.hits, skipReason: "cooldown" };
  }

  // 反例：这个人自己做到过、顺利过的相关经历，供反问锚定在他自己的事实上。
  const counterEvidence = await deps.findEvidence({
    ownerId: owner,
    scopeOwnerIds: input.scope_owner_ids,
    text,
    dateTo: input.date,
    limit: 3,
  });

  return {
    intervene: true,
    lever: hit.lever,
    counterEvidence,
    hits: detection.hits,
    text: buildWisdomText(hit.lever, counterEvidence),
  };
}

function pickLever(hits: LeverHit[]): LeverHit | undefined {
  return hits.filter(hit => hit.confidence >= MIN_CONFIDENCE).sort((a, b) => b.confidence - a.confidence)[0];
}

/**
 * 提示块。这里的每一条禁令都对应智慧干预里一个已知的失败模式：
 * 说教/鸡汤会让人更觉得"你不懂"，贴标签会制造污名，直接给出积极解释会剥夺自作者信念——
 * 那句话必须由用户自己说出来才算数。
 */
export function buildWisdomText(lever: ConstrualLever, counterEvidence: NarrativeEvidence[]): string {
  const evidenceLines = counterEvidence.length
    ? counterEvidence.map(item => `- ${item.date}：${item.detail}`).join("\n")
    : "（没有找到合适的历史反例——那就别硬找，改问一个基于 ta 这次说的话的小问题。）";

  return [
    "【这次回应的特殊方式：把解释权交回给 ta】",
    `ta 最近不止一次用这种方式解释自己的处境：${LEVER_LABELS[lever]}。`,
    "这是解释方式的问题，不是事实——但**绝不能由你来指出这一点**。你要做的是问一个小问题，让 ta 自己说出另一种可能的解释。",
    "",
    "ta 自己经历过、可以用来当锚点的相关片段（只在真的贴合时才用，牵强就别用）：",
    evidenceLines,
    "",
    "硬规则：",
    "- 先真实地接住这一次的情绪（一句话，具体，不敷衍），然后再问。",
    "- 【禁止说教】不讲道理、不做总结陈词、不给建议清单、不说“其实你应该……”。",
    "- 【禁止鸡汤】不说“你已经很棒了/别对自己太苛刻/你要相信自己”这类正能量口号。",
    "- 【禁止替 ta 下结论】不要由你说出那个积极解释（“其实你做得挺好的”），那句话必须由 ta 自己说出来才有用。",
    "- 【禁止贴标签/被监控感】不要说“我发现你最近老是这么说”“你这是消极归因”，不诊断、不点评 ta 的思维方式。",
    "- 只问**一个**问题：小、具体、容易回答，最好指向一次 ta 自己做到过的相似情形的**细节**（当时是怎么弄的、有什么不一样）。",
    "- 问题要让人可以不回答也不尴尬；不要追问，不要连环问。",
    "- 全文仍然是微信家人语气：短，2-3 句，不用 Markdown，不喊口号。",
  ].join("\n");
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function envFloat(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, 0), 1);
}

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function daysBetween(since: string, until: string): number {
  const start = new Date(`${since}T00:00:00.000Z`).getTime();
  const end = new Date(`${until}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return Number.POSITIVE_INFINITY;
  return Math.round((end - start) / 86_400_000);
}
