export interface AliasContextEntry {
  alias: string;
  memberId: string;
  label: string;
  scope?: "global" | "speaker";
  speakerProfileId?: string;
  relation?: string;
}

export interface AliasContext {
  familyId?: string;
  speakerProfileId?: string;
  selfMemberId?: string;
  selfLabel?: string;
  timezone?: string;
  aliases?: AliasContextEntry[];
  collectiveChildren?: string[];
}

export interface FamilyMemberInput {
  id?: string;
  label: string;
  role?: string;
  aliases?: string[];
  birth_date?: string;
  metadata?: Record<string, unknown>;
}

export interface SpeakerProfileInput {
  id?: string;
  external_user_id: string;
  platform?: string;
  self_member_id?: string;
  display_name?: string;
  aliases?: Array<{ alias: string; member_id: string; scope?: "global" | "speaker" }>;
  metadata?: Record<string, unknown>;
}

export interface FamilySettingsInput {
  timezone?: string;
  record_mode?: "conservative" | "balanced" | "verbose";
  default_owner_id?: string;
  metadata?: Record<string, unknown>;
}

export interface OnboardingFamilyInput {
  family_id?: string;
  name?: string;
  members?: FamilyMemberInput[];
  speaker?: SpeakerProfileInput;
  settings?: FamilySettingsInput;
}

export function normalizeFamilyLabel(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

export function normalizeAlias(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

export function buildAliasContext(input: {
  familyId?: string;
  speakerProfileId?: string;
  selfMemberId?: string;
  selfLabel?: string;
  timezone?: string;
  aliases?: AliasContextEntry[];
  childLabels?: string[];
}): AliasContext {
  return {
    familyId: input.familyId,
    speakerProfileId: input.speakerProfileId,
    selfMemberId: input.selfMemberId,
    selfLabel: normalizeFamilyLabel(input.selfLabel),
    timezone: input.timezone,
    aliases: dedupeAliases(input.aliases || []),
    collectiveChildren: [...new Set((input.childLabels || []).map(label => label.trim()).filter(Boolean))],
  };
}

export function resolveAliasLabel(raw: string, context?: AliasContext): string | undefined {
  const alias = normalizeAlias(raw);
  if (!alias || !context?.aliases?.length) return undefined;

  const speakerScoped = context.aliases.find(entry =>
    entry.alias === alias &&
    entry.scope === "speaker" &&
    (!entry.speakerProfileId || entry.speakerProfileId === context.speakerProfileId),
  );
  if (speakerScoped) return speakerScoped.label;

  return context.aliases.find(entry => entry.alias === alias)?.label;
}

function dedupeAliases(aliases: AliasContextEntry[]): AliasContextEntry[] {
  const seen = new Set<string>();
  const result: AliasContextEntry[] = [];
  for (const alias of aliases) {
    const cleanedAlias = normalizeAlias(alias.alias);
    const label = normalizeFamilyLabel(alias.label);
    if (!cleanedAlias || !label || !alias.memberId) continue;
    const key = `${alias.scope || "global"}:${alias.speakerProfileId || ""}:${cleanedAlias}:${alias.memberId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      ...alias,
      alias: cleanedAlias,
      label,
      scope: alias.scope || "global",
    });
  }
  return result;
}
