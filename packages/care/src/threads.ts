import { getLLM } from "../../ai-client/src/llm";
import { roleLLMConfig } from "../../ai-client/src/roles";
import { normalizeLocalDate } from "../../domain/src/local-date";
import { logInfo, logWarn, safeErrorMessage } from "../../observability/src/logging";
import { closeCareByTopics, createCareItem, type CareItem } from "./care-queue";
import { getDB } from "../../db/src/database";
import { isResurfaceable } from "./guard";

/**
 * 线索检测：日终归档时扫描当天对话，标记"故事还没讲完"的叙事线——
 * - concern：未闭环的担忧（生病/失眠/冲突…），隔两天回访一句"后来好点了吗"；
 * - anticipation：用户自己说了日期的未来安排（面试/体检/开学…），事后问一句"怎么样"。
 * 同时做闭环：当天对话已经回应的旧线索，标记 resolved 不再追问。
 * 挂在离线归档链路上，LLM 想跑多久跑多久，与微信 15 秒限制无关。
 */

const CONCERN_FOLLOW_UP_DAYS = 2;
const THREAD_TTL_DAYS = 7;
const MAX_THREADS_PER_DAY = 2;

export interface DetectThreadsInput {
  owner_id: string;
  /** 归档的本地日期 YYYY-MM-DD。 */
  date: string;
  /** 当天对话轮次（喂 user 侧内容给 LLM）。 */
  turns: Array<{ role: string; content: string }>;
}

export interface DetectThreadsResult {
  created: CareItem[];
  closed: number;
}

/** 依赖注入口（测试用）：避免 mock.module 的进程级泄漏。 */
export interface ThreadDeps {
  chatJSON?: (prompt: string, system?: string) => Promise<unknown>;
}

interface ThreadCandidate {
  type?: string;
  topic?: string;
  target_date?: string;
  question?: string;
  sensitive?: boolean;
}

export async function detectCareThreads(input: DetectThreadsInput, deps: ThreadDeps = {}): Promise<DetectThreadsResult> {
  const empty: DetectThreadsResult = { created: [], closed: 0 };
  const ownerId = input.owner_id?.trim();
  if (!ownerId) return empty;
  const date = normalizeLocalDate(input.date);
  const userLines = input.turns
    .filter(turn => turn.role === "user" && turn.content?.trim())
    .map(turn => turn.content.replace(/\s+/g, " ").trim())
    .slice(0, 80);
  if (!userLines.length) return empty;

  const openThreads = listOpenThreads(ownerId);

  try {
    const ask = deps.chatJSON || ((prompt: string, system?: string) => getLLM(roleLLMConfig("reply")).chatJSON(prompt, system));
    const parsed = await ask(buildPrompt(date, userLines, openThreads), THREAD_SYSTEM) as {
      threads?: ThreadCandidate[];
      resolved_topics?: string[];
    };

    const closed = closeCareByTopics({
      owner_id: ownerId,
      topics: (parsed.resolved_topics || []).filter(topic =>
        openThreads.some(open => open.topic === topic),
      ),
    });

    const created: CareItem[] = [];
    for (const candidate of (parsed.threads || []).slice(0, MAX_THREADS_PER_DAY)) {
      const item = createThreadItem(ownerId, date, candidate);
      if (item) created.push(item);
    }
    logInfo("care_threads_detected", {
      owner_len: ownerId.length,
      date,
      created: created.length,
      closed,
      open_before: openThreads.length,
    });
    return { created, closed };
  } catch (error) {
    logWarn("care_threads_skipped", { date, error: safeErrorMessage(error) });
    return empty;
  }
}

function createThreadItem(ownerId: string, date: string, candidate: ThreadCandidate): CareItem | null {
  const type = candidate.type === "anticipation" ? "anticipation" : candidate.type === "concern" ? "concern" : null;
  const topic = candidate.topic?.trim();
  const question = candidate.question?.trim();
  if (!type || !topic || !question || candidate.sensitive) return null;
  if (!isResurfaceable({ summary: topic, original_text: question })) return null;

  // anticipation：事发日之后一天再问（当天问"怎么样"太早）；concern：隔两天回访。
  const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(candidate.target_date || "") ? candidate.target_date! : null;
  const triggerDay = type === "anticipation"
    ? addDays(targetDate && targetDate > date ? targetDate : date, 1)
    : addDays(date, CONCERN_FOLLOW_UP_DAYS);

  return createCareItem({
    owner_id: ownerId,
    kind: type,
    topic,
    content: question,
    trigger_after: triggerDay,
    expires_at: `${addDays(triggerDay, THREAD_TTL_DAYS)}T23:59:59+08:00`,
    metadata: { detected_on: date, ...(targetDate ? { target_date: targetDate } : {}) },
  });
}

interface OpenThread {
  topic: string;
  content: string;
}

/** 该 owner 还挂着的线索（含未到期的），供 LLM 判断哪些已被今天的对话回应。 */
function listOpenThreads(ownerId: string): OpenThread[] {
  // 不查 trigger_after：未到回访时间的也算"开着的线索"，今天聊到了照样要闭环。
  const rows = getDB().prepare(`
    SELECT topic, content FROM pending_care
    WHERE owner_id = ? AND status = 'pending' AND kind IN ('concern', 'anticipation')
    ORDER BY created_at DESC LIMIT 20
  `).all(ownerId) as Array<{ topic: string | null; content: string }>;
  return rows.map(row => ({ topic: row.topic || "", content: row.content }));
}

const THREAD_SYSTEM = [
  "你是 xfeel 家庭记忆助手的\"跟进线索检测器\"。你读一位家人当天的记录，找出值得过几天温和问一句的未闭环线索。只输出 JSON。",
  "两类线索：",
  "- concern：明确未解决的担忧（孩子生病、失眠、和人闹矛盾、压力大到影响生活）。当天已解决的（\"退烧了\"\"和好了\"）不算。",
  "- anticipation：用户明确提到的未来安排（面试、体检、考试、旅行、开学），尽量换算出具体日期。",
  "硬性规则：",
  "1. 宁缺毋滥：只挑用户明显在意的事，最多 2 条；日常琐事、情绪碎片不算线索。",
  "2. 丧失/创伤类话题（去世、流产、重病确诊、离婚等）绝不生成线索，如拿不准就标 sensitive: true。",
  "3. question 是几天后随口关心的一句话：像家人发微信，不超过40个字，提到具体的事，不说教不罗列。",
  "4. topic 用 3-8 个字概括（如\"星星发烧\"\"下周面试\"），同一件事措辞要稳定。",
].join("\n");

function buildPrompt(date: string, userLines: string[], openThreads: OpenThread[]): string {
  const openList = openThreads.length
    ? openThreads.map(item => `- ${item.topic}（原计划问：${item.content}）`).join("\n")
    : "（无）";
  return [
    `今天日期：${date}`,
    "",
    "这位家人今天的记录：",
    userLines.map(line => `- ${line}`).join("\n"),
    "",
    "之前还开着的线索（若今天的记录已经回应/解决了某条，把它的 topic 放进 resolved_topics）：",
    openList,
    "",
    '输出 JSON：{"threads":[{"type":"concern|anticipation","topic":"...","target_date":"YYYY-MM-DD 可选","question":"...","sensitive":false}],"resolved_topics":["..."]}',
    "没有值得跟进的就输出 {\"threads\":[],\"resolved_topics\":[]}。",
  ].join("\n");
}

function addDays(ymd: string, delta: number): string {
  const date = new Date(`${ymd}T00:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}
