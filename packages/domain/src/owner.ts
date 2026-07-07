import type { AliasContext } from "./family";

export const OWNER_LABELS_BY_ID = {
  "demo-dad-owner": "爸爸",
  "demo-mom-owner": "妈妈",
} as const;

export const OWNER_IDS_BY_LABEL = Object.fromEntries(
  Object.entries(OWNER_LABELS_BY_ID).map(([id, label]) => [label, id]),
) as Record<string, string>;

const OWNER_LABEL_ALIASES: Record<string, string> = {
  父亲: "爸爸",
  爸比: "爸爸",
  爸爸: "爸爸",
  母亲: "妈妈",
  妈咪: "妈妈",
  妈妈: "妈妈",
};

export interface OwnerContext {
  ownerId?: string;
  ownerLabel?: string;
  speakerId?: string;
  speakerLabel?: string;
  aliasContext?: AliasContext;
}

export function normalizeOwnerId(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeOwnerLabel(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return OWNER_LABEL_ALIASES[trimmed] || trimmed;
}

export function resolveOwnerLabel(ownerId?: string | null): string | undefined {
  const normalized = normalizeOwnerId(ownerId);
  if (!normalized) return undefined;
  return OWNER_LABELS_BY_ID[normalized as keyof typeof OWNER_LABELS_BY_ID];
}

export function resolveOwnerContext(
  input: Partial<OwnerContext> & { userId?: string | null } = {},
): OwnerContext {
  const ownerId = normalizeOwnerId(input.ownerId ?? input.userId);
  const ownerLabel = normalizeOwnerLabel(input.ownerLabel) ?? resolveOwnerLabel(ownerId);
  const speakerId = normalizeOwnerId(input.speakerId) ?? ownerId;
  const speakerLabel =
    normalizeOwnerLabel(input.speakerLabel) ??
    input.aliasContext?.selfLabel ??
    resolveOwnerLabel(speakerId) ??
    ownerLabel;

  return { ownerId, ownerLabel, speakerId, speakerLabel, aliasContext: input.aliasContext };
}
