import {
  type Emotion,
  EventType,
  type EventType as EventTypeValue,
} from "./memory-event";
import { normalizeEmotion } from "./emotion-vocabulary";
import { resolveAliasLabel } from "./family";
import { type OwnerContext, resolveOwnerContext } from "./owner";

/** 通用亲属角色词：不绑定任何具体家庭，作为无 profile 时的最低限度已知实体 */
const GENERIC_ROLE_LABELS = ["妈妈", "爸爸", "外婆", "外公", "奶奶", "爷爷"] as const;

const COLLECTIVE_CHILD_ENTITY_ALIASES = new Set([
  "孩子",
  "孩子们",
  "娃",
  "娃们",
  "宝宝",
  "宝宝们",
  "两个宝宝",
  "两个娃",
  "两个孩子",
  "俩宝",
  "俩娃",
  "双胞胎",
  "崽",
]);

/** 通用亲属称谓归一：只收放之任何家庭皆准的映射，具体人名别名一律走 aliasContext */
const ENTITY_ALIASES: Record<string, string> = {
  父亲: "爸爸",
  老公: "爸爸",
  丈夫: "爸爸",
  先生: "爸爸",
  母亲: "妈妈",
  老婆: "妈妈",
  妻子: "妈妈",
  太太: "妈妈",
  姥姥: "外婆",
  姥爷: "外公",
};

/** 已知实体 = 通用角色词 + 家庭 profile 里的 canonical label */
function knownEntityLabels(context: OwnerContext): string[] {
  const labels = new Set<string>(GENERIC_ROLE_LABELS);
  for (const alias of context.aliasContext?.aliases || []) labels.add(alias.label);
  for (const child of context.aliasContext?.collectiveChildren || []) labels.add(child);
  return [...labels];
}

const SELF_REFERENCES = new Set(["我", "自己", "本人", "咱", "俺"]);

const EVENT_TYPE_ALIASES: Record<string, EventTypeValue> = {
  sleep: "sleep",
  睡眠: "sleep",
  入睡: "sleep",
  夜醒: "sleep",
  feeding: "feeding",
  喂养: "feeding",
  吃饭: "feeding",
  吃奶: "feeding",
  健康: "health",
  生病: "health",
  就医: "health",
  milestone: "milestone",
  里程碑: "milestone",
  成长: "milestone",
  emotion: "emotion",
  情绪: "emotion",
  心情: "emotion",
  care: "care",
  照护: "care",
  育儿: "care",
  conflict: "conflict",
  冲突: "conflict",
  矛盾: "conflict",
  work: "work",
  工作: "work",
  social: "social",
  社交: "social",
  家庭: "social",
  travel: "daily",
  旅行: "daily",
  旅游: "daily",
  出游: "daily",
  外出: "daily",
  daily: "daily",
  日常: "daily",
  reflection: "reflection",
  反思: "reflection",
  感悟: "reflection",
  other: "other",
  其他: "other",
};

export function isValidEventType(raw: string): raw is EventTypeValue {
  return EventType.safeParse(raw).success;
}

export function normalizeEventType(raw?: string | null): EventTypeValue {
  const trimmed = raw?.trim();
  if (!trimmed) return "other";
  if (isValidEventType(trimmed)) return trimmed;

  const alias = EVENT_TYPE_ALIASES[trimmed];
  if (alias) return alias;

  const lowered = trimmed.toLowerCase();
  for (const [key, value] of Object.entries(EVENT_TYPE_ALIASES)) {
    if (lowered.includes(key.toLowerCase()) || key.includes(trimmed)) {
      return value;
    }
  }

  return "other";
}

export function normalizeEmotionPayload(
  input?: {
    primary?: string;
    secondary?: string;
    intensity?: number;
    valence?: string;
  } | null,
): Emotion {
  const primary = normalizeEmotion(input?.primary || "平静");
  const secondary = input?.secondary ? normalizeEmotion(input.secondary) : null;

  return {
    primary: (primary?.word || "平静") as Emotion["primary"],
    secondary: secondary?.word as Emotion["secondary"] | undefined,
    intensity: clamp(input?.intensity ?? 0.5, 0, 1),
    valence: (primary?.valence || input?.valence || "neutral") as Emotion["valence"],
  };
}

export function normalizeEntity(
  raw: string,
  context?: Partial<OwnerContext>,
): string | null {
  const normalizedContext = resolveOwnerContext(context);
  const cleaned = raw.trim().replace(/^[\[("'“‘\s]+|[\]"')”’\s]+$/g, "");
  if (!cleaned) return null;

  if (SELF_REFERENCES.has(cleaned)) {
    return normalizedContext.aliasContext?.selfLabel || normalizedContext.speakerLabel || normalizedContext.ownerLabel || null;
  }

  const aliasLabel = resolveAliasLabel(cleaned, normalizedContext.aliasContext);
  if (aliasLabel) return aliasLabel;

  if (COLLECTIVE_CHILD_ENTITY_ALIASES.has(cleaned)) {
    // normalizeEntities expands this into concrete children. Keep a stable
    // marker here for call sites that still normalize one raw string at a time;
    // without profile children we keep the surface form as-is.
    const children = normalizedContext.aliasContext?.collectiveChildren;
    return children?.length ? children.join(" ") : cleaned;
  }

  const knownLabels = knownEntityLabels(normalizedContext);
  if (knownLabels.includes(cleaned)) {
    return cleaned;
  }

  const alias = ENTITY_ALIASES[cleaned];
  if (alias) return alias;

  for (const entity of knownLabels) {
    if (cleaned.includes(entity) || entity.includes(cleaned)) return entity;
  }

  return cleaned;
}

export function normalizeEntities(
  rawEntities: string[],
  context?: Partial<OwnerContext>,
  originalText?: string,
): string[] {
  const normalizedContext = resolveOwnerContext(context);
  const result = new Set<string>();
  const knownProfileLabels = new Set([
    ...(normalizedContext.aliasContext?.aliases || []).map(alias => alias.label),
    ...(normalizedContext.aliasContext?.collectiveChildren || []),
    normalizedContext.aliasContext?.selfLabel,
  ].filter((label): label is string => Boolean(label)));

  const collectiveChildren = normalizedContext.aliasContext?.collectiveChildren || [];
  for (const rawEntity of rawEntities) {
    const cleaned = rawEntity.trim().replace(/^[\[("'“‘\s]+|[\]"')”’\s]+$/g, "");
    if (COLLECTIVE_CHILD_ENTITY_ALIASES.has(cleaned)) {
      // profile 里有孩子就展开成具体孩子；没有则保留集合称呼原文，交给后续人工/画像补全
      if (collectiveChildren.length) {
        for (const childLabel of collectiveChildren) result.add(childLabel);
      } else if (cleaned) {
        result.add(cleaned);
      }
      continue;
    }
    if (SELF_REFERENCES.has(cleaned) && originalText && !hasStandaloneSelfReference(originalText)) {
      continue;
    }
    const normalized = normalizeEntity(rawEntity, normalizedContext);
    if (!normalized) continue;
    if (collectiveChildren.length > 1 && normalized === collectiveChildren.join(" ")) {
      for (const childLabel of collectiveChildren) result.add(childLabel);
    } else {
      result.add(normalized);
    }
  }

  if (normalizedContext.aliasContext?.aliases?.length && originalText) {
    const aliases = [...normalizedContext.aliasContext.aliases]
      .sort((a, b) => b.alias.length - a.alias.length || a.alias.localeCompare(b.alias, "zh-Hans-CN"));
    for (const alias of aliases) {
      if (!alias.alias || !originalText.includes(alias.alias)) continue;
      if (alias.scope === "speaker" && alias.speakerProfileId && alias.speakerProfileId !== normalizedContext.aliasContext.speakerProfileId) continue;
      result.add(alias.label);
    }
  }

  if (knownProfileLabels.size) {
    // 有家庭 profile 时，剔除模型臆测出的、不属于这个家庭的通用角色实体（如不存在的"外婆"）
    for (const entity of [...result]) {
      if ((GENERIC_ROLE_LABELS as readonly string[]).includes(entity) && !knownProfileLabels.has(entity)) {
        result.delete(entity);
      }
    }
  }

  if (originalText && hasStandaloneSelfReference(originalText)) {
    const selfEntity = normalizedContext.aliasContext?.selfLabel || normalizedContext.speakerLabel || normalizedContext.ownerLabel;
    if (selfEntity) result.add(selfEntity);
  }

  if (result.size === 0 && normalizedContext.ownerLabel) {
    result.add(normalizedContext.ownerLabel);
  }

  return [...result];
}

function hasStandaloneSelfReference(text: string): boolean {
  const withoutScopedAliases = text.replace(/我(老婆|老公|妈妈|爸爸|妈|爸|妻子|丈夫|太太|先生|对象)/g, "");
  return /自己/.test(withoutScopedAliases) || /我(?!老婆|老公|妈妈|爸爸|妈|爸|妻子|丈夫|太太|先生|对象|们)/.test(withoutScopedAliases);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
