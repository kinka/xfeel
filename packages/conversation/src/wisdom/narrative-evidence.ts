import { normalizeOwnerId } from "../../../domain/src/owner";
import { findPositiveEvidence } from "./evidence-lookup";
import { appendNarrativeEvidence, getPreferredNarratives } from "./narrative-store";
import { isWisdomEnabled } from "./wisdom-context";

/**
 * 递归证据链（离线，挂在 nightly 归档之后）。
 *
 * 用户说出的那句解释（"方法对了我是能弄好的"）如果没有后续，几天就蒸发了。
 * 这里做的事很朴素：在他自己往后记的日志里，找那些**真实发生过的**、支持这句话的小事，
 * 挂到叙事下面。之后回复/周期总结引用的是他自己的事实，不是我们的鼓励。
 */
export async function buildNarrativeEvidence(input: {
  owner_id?: string;
  date: string;
  scope_owner_ids?: string[];
}): Promise<{ appended: number; narratives: number }> {
  if (!isWisdomEnabled()) return { appended: 0, narratives: 0 };
  const owner = normalizeOwnerId(input.owner_id);
  if (!owner) return { appended: 0, narratives: 0 };

  const narratives = getPreferredNarratives(owner);
  if (!narratives.length) return { appended: 0, narratives: 0 };

  let appended = 0;
  for (const narrative of narratives) {
    // 只找叙事被说出**之后**的事：说出当天（含）之前的事是它的来源，不能反过来当它的印证。
    const since = addDays(narrative.capturedAt, 1);
    if (!narrative.capturedAt || since > input.date) continue;
    const evidence = await findPositiveEvidence({
      ownerId: owner,
      text: narrative.statement,
      scopeOwnerIds: input.scope_owner_ids,
      dateFrom: since,
      dateTo: input.date,
      limit: 2,
    });
    appended += appendNarrativeEvidence(owner, narrative.lever, evidence);
  }

  return { appended, narratives: narratives.length };
}

function addDays(date: string, delta: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  parsed.setUTCDate(parsed.getUTCDate() + delta);
  return parsed.toISOString().slice(0, 10);
}
