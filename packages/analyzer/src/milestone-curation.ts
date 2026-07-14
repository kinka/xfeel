import { createHash } from "node:crypto";
import { getDB } from "../../db/src/database";
import { getLLM } from "../../ai-client/src/llm";
import { roleLLMConfig } from "../../ai-client/src/roles";
import { logInfo, logWarn, safeErrorMessage } from "../../observability/src/logging";

/**
 * 里程碑策展：确定性候选查询解决"捞什么"，LLM 解决规则做不到的语义问题——
 * ①负向条目过滤（"如厕训练尚未成功"不是里程碑）；
 * ②同一能力多次记录合并（如厕训练 8 条 → 最早达成那次才是"第一次"）；
 * ③长日记提炼成短标题。
 * 结果存 milestone_snapshots，候选集指纹变了才重建；LLM 失败回退确定性列表。
 */

export interface MilestoneItem {
  id: string;
  date: string;
  title: string;
  person?: string;
  event_type?: string;
}

export interface MilestoneSnapshot {
  items: MilestoneItem[];
  curated: boolean;
  generated_at: string;
}

interface CandidateRow {
  id: string;
  summary: string;
  event_type: string;
  event_date: string | null;
  created_at: string;
  updated_at: string;
}

/** 测试注入口：避免 mock.module 进程级泄漏。 */
export interface CurationDeps {
  chatJSON?: (prompt: string, system?: string) => Promise<unknown>;
}

/**
 * 只读快照（不触发任何 LLM/写库）：给在线请求路径判断"手头有什么、新不新鲜"。
 * fresh = 候选集指纹没变且是策展版。
 */
export function peekMilestones(ownerId: string): (MilestoneSnapshot & { fresh: boolean }) | null {
  const existing = getDB().prepare("SELECT content, signature, curated, generated_at FROM milestone_snapshots WHERE owner_id = ?")
    .get(ownerId) as { content: string; signature: string; curated: number; generated_at: string } | undefined;
  if (!existing) return null;
  const signature = candidateSignature(loadCandidates(ownerId));
  return {
    items: parseItems(existing.content),
    curated: Boolean(existing.curated),
    generated_at: existing.generated_at,
    fresh: Boolean(existing.curated) && existing.signature === signature,
  };
}

/** 后台重建去重：同一 owner 的策展一次只跑一个，避免连点刷新打爆网关。 */
const rebuildInFlight = new Set<string>();

export function scheduleMilestoneRebuild(ownerId: string, deps: CurationDeps = {}): void {
  if (rebuildInFlight.has(ownerId)) return;
  rebuildInFlight.add(ownerId);
  void getMilestones(ownerId, { rebuild: true }, deps)
    .catch(error => logWarn("milestone_bg_rebuild_failed", { owner_len: ownerId.length, error: safeErrorMessage(error) }))
    .finally(() => rebuildInFlight.delete(ownerId));
}

export async function getMilestones(
  ownerId: string,
  opts: { rebuild?: boolean; curate?: boolean } = {},
  deps: CurationDeps = {},
): Promise<MilestoneSnapshot> {
  const candidates = loadCandidates(ownerId);
  const signature = candidateSignature(candidates);
  const db = getDB();

  const existing = db.prepare("SELECT content, signature, curated, generated_at FROM milestone_snapshots WHERE owner_id = ?")
    .get(ownerId) as { content: string; signature: string; curated: number; generated_at: string } | undefined;
  if (existing && existing.signature === signature && existing.curated && !opts.rebuild) {
    return { items: parseItems(existing.content), curated: true, generated_at: existing.generated_at };
  }

  const fallback = deterministicItems(candidates);
  let items = fallback;
  let curated = false;
  if (candidates.length > 0 && opts.curate !== false) {
    try {
      items = await curateWithLLM(ownerId, candidates, deps);
      curated = true;
    } catch (error) {
      logWarn("milestone_curation_fallback", { owner_len: ownerId.length, error: safeErrorMessage(error) });
    }
  }

  const now = new Date().toISOString();
  // 非策展结果（快速兜底/LLM 失败）不覆盖已有的策展快照：旧策展版比新鲜的原始列表更值得展示
  if (curated || !existing?.curated) {
    db.prepare(`
      INSERT INTO milestone_snapshots (owner_id, content, signature, source_count, curated, generated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET
        content=excluded.content, signature=excluded.signature,
        source_count=excluded.source_count, curated=excluded.curated, generated_at=excluded.generated_at
    `).run(ownerId, JSON.stringify(items), signature, candidates.length, curated ? 1 : 0, now);
  }

  logInfo("milestone_snapshot_built", { owner_len: ownerId.length, candidates: candidates.length, items: items.length, curated });
  return { items, curated, generated_at: now };
}

/**
 * 候选口径：新抽取器及一次性 LLM 回填确认的 milestone 进入候选；
 * 未复核的 legacy 仍只用关键词兜底，避免旧规则把普通工作进展误标成里程碑。
 */
function loadCandidates(ownerId: string): CandidateRow[] {
  const maxCandidates = 400;
  const rows = getDB().prepare(`
    SELECT id, summary, event_type, event_date, created_at, updated_at
    FROM memory_events
    WHERE user_id = ?
      AND (
        (event_type = 'milestone' AND extractor_version != 'legacy')
        OR summary LIKE '%第一次%' OR summary LIKE '%首次%' OR summary LIKE '%学会%'
      )
    ORDER BY COALESCE(NULLIF(event_date, ''), substr(created_at, 1, 10)) ASC, COALESCE(event_time, created_at) ASC
    LIMIT ?
  `).all(ownerId, maxCandidates + 1) as CandidateRow[];
  if (rows.length > maxCandidates) {
    logWarn("milestone_candidates_truncated", { owner_len: ownerId.length, total_at_least: rows.length, limit: maxCandidates });
  }
  return rows.slice(0, maxCandidates);
}

function candidateSignature(candidates: CandidateRow[]): string {
  const hash = createHash("sha256");
  for (const candidate of candidates) {
    hash.update(JSON.stringify([
      candidate.id,
      candidate.summary,
      candidate.event_type,
      candidate.event_date,
      candidate.created_at,
      candidate.updated_at,
    ]));
    hash.update("\n");
  }
  return `v2|${candidates.length}|${hash.digest("hex")}`;
}

/** LLM 不可用时的兜底：按 summary 去重的原始列表（长文截断当标题）。 */
function deterministicItems(candidates: CandidateRow[]): MilestoneItem[] {
  const seen = new Set<string>();
  const items: MilestoneItem[] = [];
  for (const c of candidates) {
    const key = c.summary.trim().slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      id: c.id,
      date: c.event_date || c.created_at.slice(0, 10),
      title: firstLine(c.summary).slice(0, 40),
      event_type: c.event_type,
    });
  }
  return items;
}

const CURATION_SYSTEM = [
  "你是家庭记忆产品的\"成长里程碑策展人\"。输入是候选记录列表，请挑出真正的里程碑并整理成时间线。只输出 JSON。",
  "规则：",
  "1. 里程碑 = 某人第一次达成的能力或人生节点（第一次翻身/开口叫人/自主如厕/第一次剪头发/大人的第一次住院也算）。",
  "2. 未达成/负向的丢弃：\"尚未成功\"\"还不会\"\"仍尿地上\"这类不是里程碑。",
  "3. 同一个人的同一能力只保留最早达成的那条（如厕训练成功出现多天 → 只留第一次；后续重复达成都丢弃）。不同的人分别保留。",
  "4. 若给出\"称呼归一表\"，把同一人的不同叫法当同一个人做去重，title 和 person 一律用规范称呼。",
  "5. title 提炼成 8-18 个字，格式如\"星星第一次自主如厕\"；人物称呼以归一表为准，没有归一表就从原文摘取，不要编造。",
  "6. 长日记候选里往往埋着真里程碑（如\"第一次一家人骑车兜风\"），把它提炼出来；纯情绪感想/与\"第一次\"无关的丢弃。",
  '输出：{"milestones":[{"i":候选序号,"title":"...","person":"主角规范称呼"}]}，按时间顺序。',
].join("\n");

async function curateWithLLM(ownerId: string, candidates: CandidateRow[], deps: CurationDeps): Promise<MilestoneItem[]> {
  const ask = deps.chatJSON || ((prompt: string, system?: string) => getLLM(roleLLMConfig("extract")).chatJSON(prompt, system));
  const lines = candidates.map((c, i) => {
    const date = c.event_date || c.created_at.slice(0, 10);
    return `${i}. [${date}] ${firstLine(c.summary).slice(0, 80)}`;
  });
  const aliasHints = loadAliasHints(ownerId);
  const ownerLabel = loadOwnerLabel(ownerId);
  const prompt = [
    ownerLabel ? `这些候选都来自「${ownerLabel}」的记忆池：记录里的第一人称"我"就是${ownerLabel}本人，不要猜成别的家人。\n` : "",
    aliasHints ? `称呼归一表（同一行是同一个人，用第一个规范称呼）：\n${aliasHints}\n` : "",
    `候选记录：\n${lines.join("\n")}`,
  ].filter(Boolean).join("\n");
  const out = await ask(prompt, CURATION_SYSTEM) as {
    milestones?: Array<{ i?: number; title?: string; person?: string }>;
  };
  const picked = (out.milestones || [])
    .filter(m => typeof m.i === "number" && m.i! >= 0 && m.i! < candidates.length && m.title?.trim())
    .map(m => {
      const c = candidates[m.i!]!;
      return {
        id: c.id,
        date: c.event_date || c.created_at.slice(0, 10),
        title: m.title!.trim().slice(0, 30),
        person: m.person?.trim() || undefined,
        event_type: c.event_type,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!picked.length) throw new Error("curation returned empty");
  return picked;
}

/**
 * 家庭称呼归一表："禾禾：阿禾、禾宝" 每行一人。owner 是 family_members.id，
 * 反查家庭后取全家别名——策展 LLM 靠它把"阿禾第一次擦眼泪"和"禾禾第一次擦眼泪"识别为同一人。
 */
function loadAliasHints(ownerId: string): string {
  try {
    const rows = getDB().prepare(`
      SELECT m.label, GROUP_CONCAT(a.alias, '、') AS aliases
      FROM family_members m
      LEFT JOIN member_aliases a ON a.member_id = m.id
      WHERE m.family_id = (SELECT family_id FROM family_members WHERE id = ?)
      GROUP BY m.id, m.label
      HAVING aliases IS NOT NULL
    `).all(ownerId) as Array<{ label: string; aliases: string }>;
    return rows.map(row => `${row.label}：${row.aliases}`).join("\n");
  } catch {
    return "";
  }
}

function loadOwnerLabel(ownerId: string): string {
  try {
    const row = getDB().prepare("SELECT label FROM family_members WHERE id = ?").get(ownerId) as { label?: string } | undefined;
    return row?.label || "";
  } catch {
    return "";
  }
}

function firstLine(text: string): string {
  return (text || "").split("\n")[0]!.trim();
}

function parseItems(raw: string): MilestoneItem[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
