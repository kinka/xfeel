import { getLongTermProfile, upsertProfile } from "../memory/profile-repository";
import type { LongTermProfileContent } from "../memory/profile-types";
import { normalizeOwnerId } from "../../../domain/src/owner";
import type { ConstrualLever, NarrativeEvidence, PreferredNarrative } from "./lever-types";

/**
 * 首选叙事的读写。
 *
 * 它和 understandings 不一样：understandings 是系统**归纳**出来的假设，
 * preferredNarratives 是用户**自己说出**的那句话。所以它由对话回收写入，
 * 离线归纳不得生成、也不得覆盖（见 profile-builder 的保留逻辑）。
 */

export function getPreferredNarratives(ownerId?: string): PreferredNarrative[] {
  const profile = getLongTermProfile(ownerId);
  const narratives = profile?.content?.preferredNarratives;
  return Array.isArray(narratives) ? narratives : [];
}

/** 同一杠杆只保留最新的一条叙事：人对自己的解释会更新，旧的让位给新的。 */
export function upsertPreferredNarrative(ownerId: string, narrative: PreferredNarrative): void {
  writeNarratives(ownerId, current => [
    narrative,
    ...current.filter(item => item.lever !== narrative.lever),
  ].slice(0, 4));
}

/** 证据链：给某条叙事追加它自己后来印证到的微小事实（去重、只留最近 5 条）。 */
export function appendNarrativeEvidence(ownerId: string, lever: ConstrualLever, evidence: NarrativeEvidence[]): number {
  if (!evidence.length) return 0;
  let added = 0;
  writeNarratives(ownerId, current => current.map(narrative => {
    if (narrative.lever !== lever) return narrative;
    const seen = new Set((narrative.evidence || []).map(item => item.eventId || `${item.date}:${item.detail}`));
    const fresh = evidence.filter(item => !seen.has(item.eventId || `${item.date}:${item.detail}`));
    added = fresh.length;
    if (!fresh.length) return narrative;
    return { ...narrative, evidence: [...(narrative.evidence || []), ...fresh].slice(-5) };
  }));
  return added;
}

function writeNarratives(
  ownerId: string,
  update: (current: PreferredNarrative[]) => PreferredNarrative[],
): void {
  const owner = normalizeOwnerId(ownerId);
  if (!owner) throw new Error("ownerId is required");
  const profile = getLongTermProfile(owner);
  const content: LongTermProfileContent = profile?.content
    ? { ...profile.content }
    : { understandings: [], addressBook: [], openQuestions: [] };
  content.preferredNarratives = update(
    Array.isArray(content.preferredNarratives) ? content.preferredNarratives : [],
  );

  upsertProfile({
    ownerId: owner,
    layer: "long_term",
    content,
    // 画像的覆盖范围/证据数由离线归纳负责，这里只改叙事，原样带回避免被清空。
    coversFrom: profile?.coversFrom,
    coversTo: profile?.coversTo,
    evidenceCount: profile?.evidenceCount ?? 0,
    sourceModel: profile?.sourceModel,
  });
}
