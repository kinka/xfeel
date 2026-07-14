import { isResurfaceable } from "../../../care/src/guard";
import { recallHybrid } from "../../../retrieval/src/recall";
import type { NarrativeEvidence } from "./lever-types";

/**
 * 取"这个人自己做到过的正向片段"。
 * 反例（干预时的锚点）和证据链（叙事的后续印证）拿的是同一种东西，只是时间方向相反，
 * 所以共用一个查询：语义相关 + 正向 + 过了敏感护栏。宁可返回空，也不塞不相干的"你上次很棒"。
 */
export async function findPositiveEvidence(input: {
  ownerId: string;
  text: string;
  scopeOwnerIds?: string[];
  dateFrom?: string;
  dateTo?: string;
  limit: number;
}): Promise<NarrativeEvidence[]> {
  try {
    const result = await recallHybrid({
      text: input.text,
      owner_id: input.ownerId,
      scope_owner_ids: input.scopeOwnerIds,
      date_from: input.dateFrom,
      date_to: input.dateTo,
      valence: "positive",
      limit: Math.max(input.limit * 4, 8),
    });
    return result.events
      .filter(event => isResurfaceable({
        summary: event.summary,
        original_text: event.original_text,
        emotion: event.emotion,
      }))
      .map(event => ({
        date: (event.event_time || event.created_at || "").slice(0, 10),
        detail: event.summary,
        eventId: event.id,
      }))
      .filter(item => item.detail && item.date)
      .slice(0, input.limit);
  } catch {
    return [];
  }
}
