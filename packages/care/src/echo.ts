import { getLLM } from "../../ai-client/src/llm";
import { roleLLMConfig } from "../../ai-client/src/roles";
import type { MemoryEvent } from "../../domain/src/memory-event";
import { normalizeLocalDate } from "../../domain/src/local-date";
import { recallHybrid } from "../../retrieval/src/recall";
import { logInfo, logWarn, safeErrorMessage } from "../../observability/src/logging";
import { createCareItem, countCareCreatedToday, type CareItem } from "./care-queue";
import { isResurfaceable } from "./guard";

/**
 * 内容触发的回声：新记录入库后，联想历史上相似的旧事，
 * 生成一句"上次也…"的参照（如发烧焦虑时给出"一月那回三天就退了"）。
 * 完全离线预计算（挂在异步写库完成之后），与微信 15 秒限制无关；
 * 产物进 pending_care，由微信搭便车 / /app 卡片投递。
 */

/** 旧事至少要隔这么多天才算"回声"——太近的是同一件事的延续，不是回忆。 */
const ECHO_MIN_AGE_DAYS = Number(process.env.XFEEL_ECHO_MIN_AGE_DAYS) || 7;
/** 语义相似度门槛：低于它宁可不说，回声说错话比不说话伤害大。 */
const ECHO_MIN_SIMILARITY = Number(process.env.XFEEL_ECHO_MIN_SIMILARITY) || 0.55;
/** 每 owner 每天最多产生一条回声，避免"话痨"。 */
const ECHO_DAILY_CAP = Number(process.env.XFEEL_ECHO_DAILY_CAP) || 1;
const ECHO_TTL_DAYS = 3;

export interface MaybeCreateEchoInput {
  owner_id: string;
  scope_owner_ids?: string[];
  /** 本次新入库的事件（pipeline 产物）。 */
  events: MemoryEvent[];
  /** 记录发生的本地日期，默认今天。 */
  date?: string;
}

/** 依赖注入口（测试用）：bun 的 mock.module 是进程级的，会泄漏进别的测试文件，这里用参数替代。 */
export interface EchoDeps {
  recall?: typeof recallHybrid;
  chatJSON?: <T>(prompt: string, system?: string) => Promise<T>;
}

export async function maybeCreateEchoCare(input: MaybeCreateEchoInput, deps: EchoDeps = {}): Promise<CareItem | null> {
  const ownerId = input.owner_id?.trim();
  if (!ownerId || !input.events?.length) return null;

  try {
    if (countCareCreatedToday(ownerId, "echo") >= ECHO_DAILY_CAP) return null;

    // 新事件本身敏感（丧失/创伤类）时整体跳过：此刻需要的是接住，不是翻旧账。
    const anchor = input.events.find(event => (event.summary || "").trim().length >= 6 && isResurfaceable(event));
    if (!anchor || input.events.some(event => !isResurfaceable(event))) return null;

    const today = normalizeLocalDate(input.date);
    const cutoff = addDays(today, -ECHO_MIN_AGE_DAYS);
    const result = await (deps.recall || recallHybrid)({
      text: anchor.summary,
      owner_id: ownerId,
      scope_owner_ids: input.scope_owner_ids,
      date_to: cutoff,
      limit: 5,
    });

    // 语义相似度硬门槛：embedding 通道未命中（如向量库不可用）时宁可不发，
    // 纯 FTS 命中常是"星星"这类高频实体撞词，不是真正相似的旧事。
    const semanticScoreById = new Map<string, number>();
    for (const hit of result.diagnostics?.hybrid?.hits || []) {
      if (hit.event_id && typeof hit.semantic_score === "number") {
        semanticScoreById.set(hit.event_id, Math.max(semanticScoreById.get(hit.event_id) || 0, hit.semantic_score));
      }
    }
    const newIds = new Set(input.events.map(event => event.id).filter(Boolean));
    const echoSource = result.events.find(event =>
      event.id
      && !newIds.has(event.id)
      && (event.event_date || "") <= cutoff
      && (semanticScoreById.get(event.id) || 0) >= ECHO_MIN_SIMILARITY
      && isResurfaceable(event),
    );
    if (!echoSource) return null;

    const content = await buildEchoLine(anchor, echoSource, deps.chatJSON);
    if (!content) return null;

    const item = createCareItem({
      owner_id: ownerId,
      kind: "echo",
      topic: `echo:${echoSource.id}`,
      content,
      source_event_id: anchor.id,
      related_event_ids: echoSource.id ? [echoSource.id] : [],
      expires_at: `${addDays(today, ECHO_TTL_DAYS)}T23:59:59+08:00`,
      metadata: {
        echo_event_date: echoSource.event_date,
        similarity: semanticScoreById.get(echoSource.id || "") || 0,
      },
    });
    if (item) {
      logInfo("care_echo_created", {
        care_id: item.id,
        anchor_event_id: anchor.id,
        echo_event_id: echoSource.id,
        similarity: semanticScoreById.get(echoSource.id || "") || 0,
      });
    }
    return item;
  } catch (error) {
    logWarn("care_echo_skipped", { error: safeErrorMessage(error) });
    return null;
  }
}

/**
 * 回声句由 reply 角色生成（产品的声音），但内容严格限定在旧事件事实内；
 * LLM 不可用时退化为确定性模板——回声宁可朴素，不能编造。
 */
async function buildEchoLine(
  anchor: MemoryEvent,
  old: MemoryEvent,
  chatJSON?: EchoDeps["chatJSON"],
): Promise<string> {
  const oldDate = friendlyDate(old.event_date);
  const fallback = `想起${oldDate}也有过相似的一幕：${old.summary}`;
  try {
    const ask = chatJSON || ((prompt: string, system?: string) => getLLM(roleLLMConfig("reply")).chatJSON(prompt, system));
    const out = await ask(
      [
        `刚发生：${anchor.summary}`,
        `翻到一条过去的记录（${old.event_date || "日期不详"}）：${old.summary}`,
        "",
        "请生成一句回声：像家里人随口提起过去，给此刻一个参照（如果旧事是已经过去的难关，语气里带一点\"那次也过来了\"的宽慰）。",
        "硬性要求：只引用旧记录里明确写到的事实，不补细节不编结果；不超过50个字；不用感叹号堆砌；提到时间用自然说法（如\"一月那会儿\"\"去年夏天\"）。",
        '输出 JSON：{"echo":"..."}',
      ].join("\n"),
      "你是 xfeel 的家庭记忆助手。只输出 JSON。",
    ) as { echo?: string };
    const line = out.echo?.trim();
    if (line && line.length <= 80) return line;
    return fallback;
  } catch {
    return fallback;
  }
}

function friendlyDate(ymd?: string): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "之前";
  const [y, m] = ymd.split("-");
  const thisYear = normalizeLocalDate().slice(0, 4);
  return y === thisYear ? `${Number(m)}月那会儿` : `${y}年${Number(m)}月`;
}

function addDays(ymd: string, delta: number): string {
  const date = new Date(`${ymd}T00:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}
