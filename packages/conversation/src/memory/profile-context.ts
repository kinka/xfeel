import { getLongTermProfile, getRecentProfile } from "./profile-repository";
import type { UnderstandingItem } from "./profile-types";
import { applyUnderstandingFeedback } from "./understanding-feedback";

export interface UnderstandingContext {
  hasLongTerm: boolean;
  hasRecent: boolean;
  /** 用于注入回复 prompt 的文本块（已带使用纪律）。空字符串表示无可用画像。 */
  text: string;
  /** 称呼表：成员 -> 习惯叫法，供回复保持称呼一致。 */
  addressBook: Array<{ member: string; preferredAddress: string }>;
}

const EMPTY: UnderstandingContext = { hasLongTerm: false, hasRecent: false, text: "", addressBook: [] };

/**
 * 读取长期(L3)+近期(L2)理解快照，拼成注入回复的“理解层”文本。
 * 纪律：理解是“假设/底色”，用于定调与方向，不能逐字当事实复述；具体事实仍以当前消息/召回证据为准。
 */
export function loadUnderstandingContext(input: {
  owner_id?: string;
  maxUnderstandings?: number;
}): UnderstandingContext {
  // 特性开关：灰度/回滚或 A/B 时可一键关闭理解层注入，回到纯事件召回行为。
  if (process.env.XFEEL_UNDERSTANDING_DISABLED === "1") return EMPTY;
  const longTerm = getLongTermProfile(input.owner_id);
  const recent = getRecentProfile(input.owner_id);
  if (!longTerm && !recent) return EMPTY;

  const maxU = input.maxUnderstandings ?? 8;
  const sections: string[] = [];

  if (longTerm?.content) {
    const c = longTerm.content;
    const parts: string[] = [];
    if (c.narrative) parts.push(c.narrative);
    const understandings = applyUnderstandingFeedback(input.owner_id, c.understandings || [])
      .filter(u => u.status === "active")
      .slice(0, maxU)
      .map(formatUnderstanding);
    if (understandings.length) parts.push(understandings.map(u => `- ${u}`).join("\n"));
    if (parts.length) sections.push(`【对这个人的长期理解（假设/底色，非事实）】\n${parts.join("\n")}`);
  }

  // 首选叙事 + 它自己攒下的微证据：用户当初自己说出的那句解释，配上后来真实发生的小事。
  // 这是智慧干预的收口——引用的是 ta 自己的话和 ta 自己的事，不是我们的鼓励。
  const narratives = (longTerm?.content?.preferredNarratives || []).filter(n => n?.statement);
  if (narratives.length) {
    const lines = narratives.slice(0, 2).map(n => {
      const evidence = (n.evidence || []).slice(-2).map(e => `${e.date} ${e.detail}`).join("；");
      return `- ta 自己说过：“${n.statement}”${evidence ? `\n  后来确实发生过：${evidence}` : ""}`;
    });
    sections.push(
      `【ta 自己给过的解释（不是我们的结论）】\n${lines.join("\n")}\n` +
      "只在 ta 又陷进同一种自我否定、且时机自然时，才用 ta 自己的原话和上面这些真实小事轻轻提一句；不要说教、不要当口号反复念。",
    );
  }

  if (recent?.content) {
    const c = recent.content;
    const parts: string[] = [];
    if (c.stateSummary) parts.push(c.stateSummary);
    if (c.emotionalTrend) parts.push(`近期情绪走向：${c.emotionalTrend}`);
    const threads = (c.openThreads || []).map(t => t.topic).filter(Boolean);
    if (threads.length) parts.push(`仍在关注：${threads.join("、")}`);
    if (parts.length) sections.push(`【近期状态（最近一两周，非逐字事实）】\n${parts.join("\n")}`);
  }

  const addressBook = (longTerm?.content?.addressBook || [])
    .filter(a => a.member && a.preferredAddress)
    .map(a => ({ member: a.member, preferredAddress: a.preferredAddress }));
  if (addressBook.length) {
    sections.push(`【称呼一致】对家人统一用：${addressBook.map(a => `${a.member}→${a.preferredAddress}`).join("，")}`);
  }

  if (!sections.length) return { ...EMPTY, addressBook };

  const text = [
    sections.join("\n\n"),
    "——使用方式：以上是对这个人的长期理解与近期状态，用来决定语气、关切点和方向，让回应像懂 ta 的家人。" +
    "这是假设而非事实：以用户当下这句为准，若与理解冲突，顺着当下，不要拿理解去纠正或编造具体事件。",
  ].join("\n\n");

  return { hasLongTerm: Boolean(longTerm), hasRecent: Boolean(recent), text, addressBook };
}

function formatUnderstanding(u: UnderstandingItem): string {
  const subject = u.subject && u.subject !== "记录者" ? `${u.subject}：` : "";
  const soft = u.confidence < 0.5 ? "（暂不确定）" : "";
  return `${subject}${u.statement}${soft}`;
}
