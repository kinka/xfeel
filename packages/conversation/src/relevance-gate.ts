import type { AliasContext } from "../../domain/src/family";
import type { MemoryEvent } from "../../domain/src/memory-event";

const BASE_WEAK_ENTITIES = [
  "爸爸",
  "妈妈",
  "我",
  "自己",
  "老婆",
  "老公",
  "我老婆",
  "我老公",
  "伴侣昵称",
  "老公仔",
  "她",
  "他",
  "ta",
  "TA",
  "我们",
  "你们",
  "家里",
  "大人",
  "父母",
];

const WEAK_TAGS = new Set([
  "天气",
  "下雨",
  "大雨",
  "雨",
  "降温",
  "情绪",
  "情绪转换",
  "感觉",
  "感受",
  "变化",
  "压力",
  "开心",
  "担心",
  "焦虑",
  "疲惫",
  "难过",
]);

const CONCRETE_EVENT_TYPES = new Set<MemoryEvent["event_type"]>([
  "sleep",
  "feeding",
  "health",
  "milestone",
  "care",
  "conflict",
  "work",
  "social",
]);

export function buildWeakEntitySet(aliasContext?: AliasContext): Set<string> {
  const weak = new Set(BASE_WEAK_ENTITIES);
  if (aliasContext?.selfLabel) weak.add(aliasContext.selfLabel);
  if (aliasContext?.selfMemberId) weak.add(aliasContext.selfMemberId);

  for (const alias of aliasContext?.aliases || []) {
    if (isWeakAlias(alias.alias) || isWeakAlias(alias.label) || isWeakAlias(alias.memberId)) {
      weak.add(alias.alias);
      weak.add(alias.label);
      weak.add(alias.memberId);
    }
  }
  return weak;
}

export function isContextuallyRelevant(
  candidate: MemoryEvent,
  currentEvents: MemoryEvent[],
  score: number,
  weakEntities: Set<string> = buildWeakEntitySet(),
): boolean {
  void score;
  const candidateEntities = new Set(candidate.entities || []);
  const candidateTags = new Set(candidate.tags || []);

  for (const current of currentEvents) {
    const sharedEntities = (current.entities || []).filter(entity => candidateEntities.has(entity));

    const sharedSpecificTags = (current.tags || [])
      .filter(tag => candidateTags.has(tag))
      .filter(tag => !WEAK_TAGS.has(tag));
    if (sharedSpecificTags.length > 0) return true;

    if (
      current.event_type === candidate.event_type &&
      CONCRETE_EVENT_TYPES.has(current.event_type) &&
      sharedEntities.some(entity => !weakEntities.has(entity))
    ) {
      return true;
    }
  }

  return false;
}

function isWeakAlias(value?: string): boolean {
  if (!value) return false;
  return /^(爸爸|妈妈|我|自己|老婆|老公|我老婆|我老公|伴侣昵称|老公仔)$/.test(value);
}
