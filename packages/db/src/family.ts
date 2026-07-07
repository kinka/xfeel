import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { getDB, getEmbeddingDB } from "./database";
import type { AliasContext, OnboardingFamilyInput } from "../../domain/src/family";
import { buildAliasContext, normalizeFamilyLabel } from "../../domain/src/family";

/** 自动开户时占位 self 成员的 label / role，用于区分「尚未确认身份」的新用户 */
export const PLACEHOLDER_SELF_LABEL = "本人";
export const PLACEHOLDER_SELF_ROLE = "unknown";

export interface FamilySummary {
  family: { id: string; name: string };
  members: Array<{ id: string; label: string; role: string; aliases: string[]; birth_date?: string }>;
  speakers: Array<{ id: string; platform: string; external_user_id: string; self_member_id?: string; self_label?: string; display_name?: string }>;
  settings: { timezone: string; record_mode: string; default_owner_id?: string };
  aliasContext: AliasContext;
}

export function upsertFamilyOnboarding(input: OnboardingFamilyInput, db: Database = getDB()): FamilySummary {
  const familyId = input.family_id?.trim() || crypto.randomUUID();
  const familyName = input.name?.trim() || "我的家庭";
  const settings = input.settings || {};
  const memberIdsByLabel = new Map<string, string>();

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO families (id, name)
      VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=datetime('now')
    `).run(familyId, familyName);

    for (const member of input.members || []) {
      const label = member.label?.trim();
      if (!label) continue;
      const memberId = member.id?.trim() || stableId("member", familyId, label);
      memberIdsByLabel.set(label, memberId);
      db.prepare(`
        INSERT INTO family_members (id, family_id, label, role, birth_date, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(family_id, label) DO UPDATE SET
          role=excluded.role,
          birth_date=excluded.birth_date,
          metadata=excluded.metadata,
          updated_at=datetime('now')
      `).run(
        memberId,
        familyId,
        label,
        member.role?.trim() || "member",
        member.birth_date || null,
        JSON.stringify(member.metadata || {}),
      );

      const aliases = new Set([label, ...(member.aliases || [])].map(alias => alias.trim()).filter(Boolean));
      for (const alias of aliases) upsertAlias(db, familyId, memberId, alias, "global");
    }

    const speaker = input.speaker;
    if (speaker?.external_user_id?.trim()) {
      const platform = speaker.platform?.trim() || "weixin";
      const selfMemberId = resolveMemberRef(db, familyId, speaker.self_member_id, memberIdsByLabel);
      const speakerId = speaker.id?.trim() || stableId("speaker", platform, speaker.external_user_id.trim());
      db.prepare(`
        INSERT INTO speaker_profiles (id, family_id, platform, external_user_id, self_member_id, display_name, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform, external_user_id) DO UPDATE SET
          family_id=excluded.family_id,
          self_member_id=excluded.self_member_id,
          display_name=excluded.display_name,
          metadata=excluded.metadata,
          updated_at=datetime('now')
      `).run(
        speakerId,
        familyId,
        platform,
        speaker.external_user_id.trim(),
        selfMemberId || null,
        speaker.display_name?.trim() || null,
        JSON.stringify(speaker.metadata || {}),
      );

      for (const item of speaker.aliases || []) {
        const memberId = resolveMemberRef(db, familyId, item.member_id, memberIdsByLabel);
        const scope = normalizeAliasScope(item.scope, "speaker");
        if (memberId && item.alias?.trim()) upsertAlias(db, familyId, memberId, item.alias.trim(), scope, speakerId);
      }
    }

    db.prepare(`
      INSERT INTO family_settings (family_id, timezone, record_mode, default_owner_id, metadata)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(family_id) DO UPDATE SET
        timezone=excluded.timezone,
        record_mode=excluded.record_mode,
        default_owner_id=excluded.default_owner_id,
        metadata=excluded.metadata,
        updated_at=datetime('now')
    `).run(
      familyId,
      settings.timezone?.trim() || "Asia/Shanghai",
      normalizeRecordMode(settings.record_mode),
      settings.default_owner_id?.trim() || null,
      JSON.stringify(settings.metadata || {}),
    );
  });
  tx();

  return getFamilySummary({ family_id: familyId }, db)!;
}

export function getFamilySummary(query: { family_id?: string; speaker_profile_id?: string; platform?: string; external_user_id?: string }, db: Database = getDB()): FamilySummary | null {
  const family = findFamily(query, db);
  if (!family) return null;

  const members = db.prepare(`
    SELECT id, label, role, birth_date
    FROM family_members
    WHERE family_id = ?
    ORDER BY created_at ASC, label ASC
  `).all(family.id) as Array<{ id: string; label: string; role: string; birth_date?: string | null }>;

  const aliases = db.prepare(`
    SELECT a.alias, a.member_id, a.scope, a.speaker_profile_id, a.relation, m.label
    FROM member_aliases a
    JOIN family_members m ON m.id = a.member_id
    WHERE a.family_id = ?
    ORDER BY a.created_at ASC, a.alias ASC
  `).all(family.id) as Array<{ alias: string; member_id: string; scope: "global" | "speaker"; speaker_profile_id?: string | null; relation?: string | null; label: string }>;

  const speakers = db.prepare(`
    SELECT sp.id, sp.platform, sp.external_user_id, sp.self_member_id, sp.display_name, fm.label AS self_label
    FROM speaker_profiles sp
    LEFT JOIN family_members fm ON fm.id = sp.self_member_id
    WHERE sp.family_id = ?
    ORDER BY sp.created_at ASC
  `).all(family.id) as Array<{ id: string; platform: string; external_user_id: string; self_member_id?: string | null; self_label?: string | null; display_name?: string | null }>;

  const settings = db.prepare("SELECT timezone, record_mode, default_owner_id FROM family_settings WHERE family_id = ?")
    .get(family.id) as { timezone: string; record_mode: string; default_owner_id?: string | null } | undefined;

  const selectedSpeaker = selectSpeaker(query, speakers);
  const aliasesByMember = new Map<string, string[]>();
  for (const alias of aliases) {
    if (!aliasesByMember.has(alias.member_id)) aliasesByMember.set(alias.member_id, []);
    aliasesByMember.get(alias.member_id)!.push(alias.alias);
  }

  const childLabels = members.filter(member => ["child", "baby", "kid"].includes(member.role)).map(member => member.label);

  return {
    family,
    members: members.map(member => ({
      id: member.id,
      label: member.label,
      role: member.role,
      aliases: [...new Set(aliasesByMember.get(member.id) || [])],
      birth_date: member.birth_date || undefined,
    })),
    speakers: speakers.map(speaker => ({
      id: speaker.id,
      platform: speaker.platform,
      external_user_id: speaker.external_user_id,
      self_member_id: speaker.self_member_id || undefined,
      self_label: speaker.self_label || undefined,
      display_name: speaker.display_name || undefined,
    })),
    settings: {
      timezone: settings?.timezone || "Asia/Shanghai",
      record_mode: settings?.record_mode || "conservative",
      default_owner_id: settings?.default_owner_id || undefined,
    },
    aliasContext: buildAliasContext({
      familyId: family.id,
      speakerProfileId: selectedSpeaker?.id,
      selfMemberId: selectedSpeaker?.self_member_id || undefined,
      selfLabel: selectedSpeaker?.self_label || undefined,
      timezone: settings?.timezone || "Asia/Shanghai",
      childLabels,
      aliases: aliases.map(alias => ({
        alias: alias.alias,
        memberId: alias.member_id,
        label: alias.label,
        scope: alias.scope,
        speakerProfileId: alias.speaker_profile_id || undefined,
        relation: alias.relation || undefined,
      })),
    }),
  };
}

export function getAliasContextForSpeaker(input: { family_id?: string; speaker_profile_id?: string; platform?: string; external_user_id?: string }, db: Database = getDB()): AliasContext | undefined {
  return getFamilySummary(input, db)?.aliasContext;
}

export interface FamilyEntityLexicon {
  /** 家庭成员 canonical label 列表 */
  labels: string[];
  /** 全局别名 surface → canonical label（不含 speaker 视角的「我/自己」，规则兜底是跨说话人的） */
  aliasToLabel: Record<string, string>;
  /** 「孩子们/宝宝们」等集合称呼应展开成的孩子 label 列表 */
  collectiveChildren: string[];
}

const SELF_SURFACE_WORDS = new Set(["我", "自己", "本人"]);

/**
 * 按 owner（= self 成员 id）取其家庭的实体词典，供无 LLM 的规则兜底路径
 * （分类关键词、检索意图实体归一、查询扩展）在运行时替代硬编码人名。
 * 只收 global 别名——speaker 视角别名（我/我老婆…）依赖说话人，跨说话人的兜底不能用。
 * owner 不明或查不到家庭时返回空词典，调用方应只依赖通用角色词。
 */
export function getEntityLexiconForOwner(ownerId?: string | null, db: Database = getDB()): FamilyEntityLexicon {
  const empty: FamilyEntityLexicon = { labels: [], aliasToLabel: {}, collectiveChildren: [] };
  const id = ownerId?.trim();
  if (!id) return empty;
  const member = db.prepare("SELECT family_id FROM family_members WHERE id = ?").get(id) as { family_id: string } | undefined;
  if (!member) return empty;

  const members = db.prepare("SELECT id, label, role FROM family_members WHERE family_id = ? ORDER BY created_at ASC, label ASC")
    .all(member.family_id) as Array<{ id: string; label: string; role: string }>;
  const aliases = db.prepare(`
    SELECT a.alias, m.label FROM member_aliases a
    JOIN family_members m ON m.id = a.member_id
    WHERE a.family_id = ? AND a.scope = 'global'
  `).all(member.family_id) as Array<{ alias: string; label: string }>;

  const aliasToLabel: Record<string, string> = {};
  for (const row of aliases) {
    if (!SELF_SURFACE_WORDS.has(row.alias)) aliasToLabel[row.alias] = row.label;
  }
  for (const m of members) aliasToLabel[m.label] = m.label;

  return {
    labels: members.map(m => m.label),
    aliasToLabel,
    collectiveChildren: members.filter(m => ["child", "baby", "kid"].includes(m.role)).map(m => m.label),
  };
}

/**
 * memberId → label 映射。owner 池以 self 成员 id 为键，所以这同样是 owner_id → 家人称呼。
 * 用于家庭共享记忆里给召回结果标注"谁记的"。
 */
export function getMemberLabels(memberIds: string[], db: Database = getDB()): Map<string, string> {
  const ids = [...new Set(memberIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = db.prepare(
    `SELECT id, label FROM family_members WHERE id IN (${ids.map(() => "?").join(",")})`,
  ).all(...ids) as Array<{ id: string; label: string }>;
  return new Map(rows.map(row => [row.id, row.label]));
}

/**
 * 一个家庭名下的全部 owner 记忆池 id。owner_id 是 self 成员 id（按人分池），
 * 所以 = 该家庭全部 family_members.id。网页多租户隔离用它把「登录者能看的数据」
 * 收窄到自己家庭：登录的家人能看全家（爸爸/妈妈/…），但看不到别的家庭。
 */
export function getFamilyOwnerIds(familyId: string | undefined | null, db: Database = getDB()): string[] {
  const id = familyId?.trim();
  if (!id) return [];
  const rows = db.prepare("SELECT id FROM family_members WHERE family_id = ?").all(id) as Array<{ id: string }>;
  const set = new Set(rows.map(r => r.id));
  const settings = db.prepare("SELECT default_owner_id FROM family_settings WHERE family_id = ?").get(id) as { default_owner_id?: string | null } | undefined;
  if (settings?.default_owner_id) set.add(settings.default_owner_id);
  return [...set];
}

export function updateFamilyName(
  input: { family_id: string; name: string },
  db: Database = getDB(),
): FamilySummary {
  const familyId = input.family_id.trim();
  const name = normalizeFamilyName(input.name);
  if (!familyId) throw new Error("family_id is required");
  if (!name) throw new Error("family name is required");
  db.prepare("UPDATE families SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, familyId);
  const summary = getFamilySummary({ family_id: familyId }, db);
  if (!summary) throw new Error("family not found");
  return summary;
}

function findFamily(query: { family_id?: string; speaker_profile_id?: string; platform?: string; external_user_id?: string }, db: Database): { id: string; name: string } | null {
  if (query.family_id) {
    return db.prepare("SELECT id, name FROM families WHERE id = ?").get(query.family_id) as { id: string; name: string } | undefined || null;
  }
  if (query.speaker_profile_id) {
    return db.prepare(`
      SELECT f.id, f.name FROM families f
      JOIN speaker_profiles sp ON sp.family_id = f.id
      WHERE sp.id = ?
    `).get(query.speaker_profile_id) as { id: string; name: string } | undefined || null;
  }
  if (query.external_user_id) {
    return db.prepare(`
      SELECT f.id, f.name FROM families f
      JOIN speaker_profiles sp ON sp.family_id = f.id
      WHERE sp.platform = ? AND sp.external_user_id = ?
    `).get(query.platform || "weixin", query.external_user_id) as { id: string; name: string } | undefined || null;
  }
  return db.prepare("SELECT id, name FROM families ORDER BY created_at ASC LIMIT 1").get() as { id: string; name: string } | undefined || null;
}

function selectSpeaker(query: { speaker_profile_id?: string; platform?: string; external_user_id?: string }, speakers: Array<{ id: string; platform: string; external_user_id: string; self_member_id?: string | null; self_label?: string | null }>) {
  if (query.speaker_profile_id) return speakers.find(speaker => speaker.id === query.speaker_profile_id);
  if (query.external_user_id) return speakers.find(speaker => speaker.platform === (query.platform || "weixin") && speaker.external_user_id === query.external_user_id);
  return speakers[0];
}

function upsertAlias(db: Database, familyId: string, memberId: string, alias: string, scope: "global" | "speaker", speakerProfileId?: string) {
  const existing = db.prepare(`
    SELECT id FROM member_aliases
    WHERE family_id = ? AND alias = ? AND scope = ? AND COALESCE(speaker_profile_id, '') = COALESCE(?, '')
  `).get(familyId, alias, scope, speakerProfileId || null) as { id: string } | undefined;
  const id = existing?.id || stableId("alias", familyId, alias, scope, speakerProfileId || "");
  db.prepare(`
    INSERT INTO member_aliases (id, family_id, member_id, alias, scope, speaker_profile_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      member_id=excluded.member_id,
      updated_at=datetime('now')
  `).run(id, familyId, memberId, alias, scope, speakerProfileId || null);
}

function resolveMemberRef(db: Database, familyId: string, ref: string | undefined, memberIdsByLabel: Map<string, string>): string | undefined {
  const trimmed = ref?.trim();
  if (!trimmed) return undefined;
  const fromPayload = memberIdsByLabel.get(trimmed);
  if (fromPayload) return fromPayload;
  const existing = db.prepare("SELECT id FROM family_members WHERE family_id = ? AND (id = ? OR label = ?) LIMIT 1")
    .get(familyId, trimmed, trimmed) as { id: string } | undefined;
  return existing?.id;
}

function normalizeAliasScope(scope: string | undefined, fallback: "global" | "speaker"): "global" | "speaker" {
  return scope === "global" || scope === "speaker" ? scope : fallback;
}

function normalizeRecordMode(mode: string | undefined): "conservative" | "balanced" | "verbose" {
  return mode === "balanced" || mode === "verbose" || mode === "conservative" ? mode : "conservative";
}

function normalizeFamilyName(name: string | undefined): string {
  return (name || "").trim().replace(/\s+/g, " ").slice(0, 20);
}

function stableId(...parts: string[]): string {
  const chars = createHash("sha256").update(parts.join("\x1f")).digest("hex").slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 新用户首条消息时自动建一个「单家庭」并把该 openid 绑为占位 self。
 * 这样我们可以先收下并正常处理消息（owner_id 有了归属），稍后再温和提醒去确认身份。
 * 幂等：若该 openid 已有 speaker_profile，直接返回既有家庭，不会重复建。
 */
export function autoProvisionFamilyForSpeaker(
  input: { platform?: string; external_user_id: string; display_name?: string },
  db: Database = getDB(),
): FamilySummary {
  const platform = input.platform?.trim() || "weixin";
  const externalUserId = input.external_user_id.trim();
  const existing = getFamilySummary({ platform, external_user_id: externalUserId }, db);
  if (existing) return existing;

  const familyId = crypto.randomUUID();
  const selfMemberId = crypto.randomUUID();
  const selfLabel = normalizeFamilyLabel(input.display_name) || PLACEHOLDER_SELF_LABEL;
  return upsertFamilyOnboarding({
    family_id: familyId,
    name: generateUniqueFamilyName(db),
    members: [{ id: selfMemberId, label: selfLabel, role: PLACEHOLDER_SELF_ROLE }],
    speaker: {
      external_user_id: externalUserId,
      platform,
      self_member_id: selfMemberId,
      display_name: input.display_name?.trim() || undefined,
      aliases: [
        { alias: "我", member_id: selfMemberId, scope: "speaker" },
        { alias: "自己", member_id: selfMemberId, scope: "speaker" },
      ],
      metadata: { onboarding_stage: "auto", source: "auto-provision" },
    },
    settings: {
      timezone: "Asia/Shanghai",
      record_mode: "balanced",
      default_owner_id: selfMemberId,
      metadata: { source: "auto-provision" },
    },
  }, db);
}

const FAMILY_NAME_PREFIXES = ["晴", "星", "云", "月", "风", "竹", "松", "禾", "溪", "山", "海", "林", "橙", "蓝", "青", "暖"];
const FAMILY_NAME_SUFFIXES = ["岚", "舟", "庭", "光", "屿", "川", "谷", "屋", "湾", "台", "窗", "径", "田", "桥", "院", "巷"];

function generateUniqueFamilyName(db: Database): string {
  for (let i = 0; i < 64; i++) {
    const name = "家庭-" + randomItem(FAMILY_NAME_PREFIXES) + randomItem(FAMILY_NAME_SUFFIXES);
    const exists = db.prepare("SELECT 1 FROM families WHERE name = ? LIMIT 1").get(name);
    if (!exists) return name;
  }
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return "家庭-" + randomItem(FAMILY_NAME_PREFIXES) + randomItem(FAMILY_NAME_SUFFIXES) + suffix;
}

function randomItem(items: string[]): string {
  return items[Math.floor(Math.random() * items.length)]!;
}

/**
 * 用户确认「我是X」时设置说话人的 self 成员。
 * - 占位 self（自动开户产生）会被「原地重命名」，从而保持 owner_id（=default_owner_id）连续，
 *   不会把已记录的内容切到另一个记忆池。
 * - 若家庭里已存在同名成员（phase 2 邀请/合并场景），则把 self 指过去，不动 owner 池。
 */
export function setSpeakerSelf(
  input: { platform?: string; external_user_id: string; label: string; role?: string },
  db: Database = getDB(),
): FamilySummary {
  const platform = input.platform?.trim() || "weixin";
  const externalUserId = input.external_user_id.trim();
  const label = normalizeFamilyLabel(input.label);
  let summary = getFamilySummary({ platform, external_user_id: externalUserId }, db);
  if (!summary) summary = autoProvisionFamilyForSpeaker({ platform, external_user_id: externalUserId }, db);
  if (!label) return summary;

  const speaker = summary.speakers.find(s => s.platform === platform && s.external_user_id === externalUserId);
  if (!speaker) return summary;
  const familyId = summary.family.id;
  const role = input.role?.trim() || "member";

  const tx = db.transaction(() => {
    const existingMember = db.prepare(
      "SELECT id FROM family_members WHERE family_id = ? AND label = ? LIMIT 1",
    ).get(familyId, label) as { id: string } | undefined;

    let selfMemberId = speaker.self_member_id;
    if (existingMember && existingMember.id !== selfMemberId) {
      // 已有同名成员：把 self 指过去，并把原本累计在占位/旧 self 上的 owner 池迁到该成员（按人分池）
      const previousSelf = selfMemberId;
      selfMemberId = existingMember.id;
      db.prepare("UPDATE family_members SET role = ?, updated_at = datetime('now') WHERE id = ?").run(role, selfMemberId);
      if (previousSelf && previousSelf !== selfMemberId) migrateOwnerPool(previousSelf, selfMemberId, db);
    } else if (selfMemberId) {
      // 原地重命名占位 self，保持 owner_id 连续
      db.prepare("UPDATE family_members SET label = ?, role = ?, updated_at = datetime('now') WHERE id = ?").run(label, role, selfMemberId);
    } else {
      selfMemberId = crypto.randomUUID();
      db.prepare("INSERT INTO family_members (id, family_id, label, role) VALUES (?, ?, ?, ?)").run(selfMemberId, familyId, label, role);
    }

    // self 自身的 global 别名只保留真实 label（清掉占位期的「本人」等）
    db.prepare("DELETE FROM member_aliases WHERE family_id = ? AND member_id = ? AND scope = 'global'").run(familyId, selfMemberId);
    upsertAlias(db, familyId, selfMemberId, label, "global");

    // 说话人视角的「我/自己」指向新的 self 成员
    for (const alias of ["我", "自己"]) upsertAlias(db, familyId, selfMemberId, alias, "speaker", speaker.id);

    db.prepare("UPDATE speaker_profiles SET self_member_id = ?, updated_at = datetime('now') WHERE id = ?").run(selfMemberId, speaker.id);
    patchSpeakerMetadata(db, speaker.id, { onboarding_stage: "self_set" });
  });
  tx();

  return getFamilySummary({ family_id: familyId }, db)!;
}

/**
 * 给说话人所在家庭添加一个孩子成员（「孩子叫X」）：建 member(role=child) + 全局别名，
 * 让抽取时「X」能归一到这个成员。同名成员已存在则幂等返回。
 */
export function addFamilyChild(
  input: { platform?: string; external_user_id: string; label: string },
  db: Database = getDB(),
): { ok: boolean; created: boolean; label: string } | null {
  const platform = input.platform?.trim() || "weixin";
  const externalUserId = input.external_user_id.trim();
  const label = normalizeFamilyLabel(input.label);
  if (!label) return null;
  const summary = getFamilySummary({ platform, external_user_id: externalUserId }, db);
  if (!summary) return null;
  const familyId = summary.family.id;

  const existing = db.prepare("SELECT id FROM family_members WHERE family_id = ? AND label = ? LIMIT 1")
    .get(familyId, label) as { id: string } | undefined;
  if (existing) return { ok: true, created: false, label };

  const memberId = crypto.randomUUID();
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO family_members (id, family_id, label, role) VALUES (?, ?, ?, 'child')")
      .run(memberId, familyId, label);
    upsertAlias(db, familyId, memberId, label, "global");
  });
  tx();
  return { ok: true, created: true, label };
}

export interface SpeakerOnboardingState {
  speakerId: string;
  familyId: string;
  /** "auto"：自动开户、尚未确认身份；"self_set"：已确认 self */
  stage: "auto" | "self_set";
  remindedAt?: string;
}

export function getSpeakerOnboardingState(
  query: { platform?: string; external_user_id?: string; speaker_profile_id?: string },
  db: Database = getDB(),
): SpeakerOnboardingState | null {
  const row = (query.external_user_id
    ? db.prepare(`
        SELECT sp.id, sp.family_id, sp.metadata, sp.self_member_id, fm.label AS self_label, fm.role AS self_role
        FROM speaker_profiles sp LEFT JOIN family_members fm ON fm.id = sp.self_member_id
        WHERE sp.platform = ? AND sp.external_user_id = ?
      `).get(query.platform || "weixin", query.external_user_id)
    : query.speaker_profile_id
      ? db.prepare(`
          SELECT sp.id, sp.family_id, sp.metadata, sp.self_member_id, fm.label AS self_label, fm.role AS self_role
          FROM speaker_profiles sp LEFT JOIN family_members fm ON fm.id = sp.self_member_id
          WHERE sp.id = ?
        `).get(query.speaker_profile_id)
      : undefined) as
    | { id: string; family_id: string; metadata: string | null; self_member_id: string | null; self_label: string | null; self_role: string | null }
    | undefined;
  if (!row) return null;

  let meta: Record<string, unknown> = {};
  try { meta = row.metadata ? JSON.parse(row.metadata) : {}; } catch { meta = {}; }

  // 老用户没有 onboarding_stage 字段：按 self 是否为有效身份推断，避免给已绑定用户发新手提醒
  const hasRealSelf = Boolean(row.self_member_id) && row.self_role !== PLACEHOLDER_SELF_ROLE && row.self_label !== PLACEHOLDER_SELF_LABEL;
  const stage = meta.onboarding_stage === "self_set" || (meta.onboarding_stage === undefined && hasRealSelf) ? "self_set" : "auto";

  return {
    speakerId: row.id,
    familyId: row.family_id,
    stage,
    remindedAt: typeof meta.reminded_at === "string" ? meta.reminded_at : undefined,
  };
}

export function markSpeakerReminded(speakerId: string, db: Database = getDB()): void {
  patchSpeakerMetadata(db, speakerId, { reminded_at: new Date().toISOString() });
}

function patchSpeakerMetadata(db: Database, speakerId: string, patch: Record<string, unknown>): void {
  const row = db.prepare("SELECT metadata FROM speaker_profiles WHERE id = ?").get(speakerId) as { metadata: string | null } | undefined;
  let meta: Record<string, unknown> = {};
  try { meta = row?.metadata ? JSON.parse(row.metadata) : {}; } catch { meta = {}; }
  db.prepare("UPDATE speaker_profiles SET metadata = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify({ ...meta, ...patch }), speakerId);
}

/* ── Phase 2：邀请加入家庭 + owner 记忆池迁移 ───────────────────────── */

// 7 天有效、可多人使用：家里人不一定当天就来，一次性/24h 的码逼着邀请人反复重发
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 邀请码 = 6 位纯数字（无中划线，方便微信里念/输）。 */
function generateCode(length = 6): string {
  let code = "";
  for (let i = 0; i < length; i++) code += Math.floor(Math.random() * 10);
  return code;
}

/**
 * 把一个 owner 记忆池整体并入另一个。owner_id 是硬分区键，分散在多张表：
 * memory_events.user_id / conversation_turns / memory_open_facts / daily_archives / memory_profiles，
 * 以及独立向量库 memory_embeddings.owner_id。
 * daily_archives、memory_profiles 有唯一约束（按天/按层），冲突的旧行直接丢弃（属可重建聚合）。
 */
export function migrateOwnerPool(fromOwner: string, toOwner: string, db: Database = getDB()): { moved: Record<string, number> } {
  const moved: Record<string, number> = {};
  if (!fromOwner || !toOwner || fromOwner === toOwner) return { moved };

  const run = () => {
    moved.memory_events = db.prepare("UPDATE memory_events SET user_id = ? WHERE user_id = ?").run(toOwner, fromOwner).changes;
    moved.conversation_turns = db.prepare("UPDATE conversation_turns SET owner_id = ? WHERE owner_id = ?").run(toOwner, fromOwner).changes;
    moved.memory_open_facts = db.prepare("UPDATE memory_open_facts SET owner_id = ? WHERE owner_id = ?").run(toOwner, fromOwner).changes;
    moved.daily_archives = db.prepare("UPDATE OR IGNORE daily_archives SET owner_id = ? WHERE owner_id = ?").run(toOwner, fromOwner).changes;
    db.prepare("DELETE FROM daily_archives WHERE owner_id = ?").run(fromOwner);
    moved.memory_profiles = db.prepare("UPDATE OR IGNORE memory_profiles SET owner_id = ? WHERE owner_id = ?").run(toOwner, fromOwner).changes;
    db.prepare("DELETE FROM memory_profiles WHERE owner_id = ?").run(fromOwner);
  };
  if (db.inTransaction) run(); else db.transaction(run)();

  // 向量库是独立连接，单独迁移；不可用时跳过（embeddings 可重建，召回另有词法兜底）。
  try {
    const vdb = getEmbeddingDB();
    const hasTable = vdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_embeddings'").get();
    if (hasTable) moved.memory_embeddings = vdb.prepare("UPDATE memory_embeddings SET owner_id = ? WHERE owner_id = ?").run(toOwner, fromOwner).changes;
  } catch { /* vec db 不可用 */ }

  return { moved };
}

export interface FamilyInvite {
  code: string;
  familyId: string;
  expiresAt: string;
}

/** 家庭成员发起邀请，生成 24h 有效的一次性邀请码。邀请人必须已属于某家庭。 */
export function createFamilyInvite(input: { platform?: string; external_user_id: string }, db: Database = getDB()): FamilyInvite | null {
  const platform = input.platform?.trim() || "weixin";
  const externalUserId = input.external_user_id.trim();
  const summary = getFamilySummary({ platform, external_user_id: externalUserId }, db);
  if (!summary) return null;
  const speaker = summary.speakers.find(s => s.platform === platform && s.external_user_id === externalUserId);

  let code = generateCode();
  for (let i = 0; i < 5 && db.prepare("SELECT 1 FROM verification_codes WHERE code = ?").get(code); i++) code = generateCode();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  db.prepare(`
    INSERT INTO verification_codes (code, purpose, family_id, created_by, expires_at)
    VALUES (?, 'invite', ?, ?, ?)
  `).run(code, summary.family.id, speaker?.id || externalUserId, expiresAt);

  return { code, familyId: summary.family.id, expiresAt };
}

export interface JoinResult {
  ok: boolean;
  reason?: "code_not_found" | "expired" | "already_used" | "already_in_family";
  family?: FamilySummary;
  migrated?: Record<string, number>;
}

/**
 * 凭邀请码加入目标家庭：切换 speaker_profile 到目标家庭、把旧 owner 池整体并入目标 owner 池，
 * 旧家庭无其它成员时删除。全新用户（还没自动开户）则直接落到目标家庭，无需迁移。
 */
export function joinFamilyByInvite(input: { platform?: string; external_user_id: string; code: string }, db: Database = getDB()): JoinResult {
  const platform = input.platform?.trim() || "weixin";
  const externalUserId = input.external_user_id.trim();
  const code = input.code.trim().toUpperCase();

  const row = db.prepare(`
    SELECT code, family_id, expires_at, used_at FROM verification_codes WHERE code = ? AND purpose = 'invite'
  `).get(code) as { code: string; family_id: string | null; expires_at: string; used_at: string | null } | undefined;
  if (!row || !row.family_id) return { ok: false, reason: "code_not_found" };
  // 邀请码在有效期内可多人使用（爸爸发一个码，妈妈和奶奶都能加入）；used_at 仅作最近使用记录
  if (Date.parse(row.expires_at) < Date.now()) return { ok: false, reason: "expired" };

  const targetFamilyId = row.family_id;
  const target = getFamilySummary({ family_id: targetFamilyId }, db);
  if (!target) return { ok: false, reason: "code_not_found" };

  const current = getFamilySummary({ platform, external_user_id: externalUserId }, db);
  if (current && current.family.id === targetFamilyId) return { ok: false, reason: "already_in_family", family: current };

  const currentSpeaker = current?.speakers.find(s => s.platform === platform && s.external_user_id === externalUserId);
  // 沿用加入者原来的称呼（若已确认过），否则用占位、稍后引导 "我是X"
  const carriedLabel = current?.aliasContext.selfLabel && current.aliasContext.selfLabel !== PLACEHOLDER_SELF_LABEL
    ? current.aliasContext.selfLabel
    : PLACEHOLDER_SELF_LABEL;

  let migrated: Record<string, number> | undefined;
  const tx = db.transaction(() => {
    // 1. 目标家庭里建/复用加入者的 self 成员
    const existingMember = db.prepare("SELECT id FROM family_members WHERE family_id = ? AND label = ? LIMIT 1")
      .get(targetFamilyId, carriedLabel) as { id: string } | undefined;
    let selfMemberId = existingMember?.id;
    if (!selfMemberId) {
      selfMemberId = crypto.randomUUID();
      db.prepare("INSERT INTO family_members (id, family_id, label, role) VALUES (?, ?, ?, ?)")
        .run(selfMemberId, targetFamilyId, carriedLabel, carriedLabel === PLACEHOLDER_SELF_LABEL ? PLACEHOLDER_SELF_ROLE : "member");
    }

    // 2. 切换 speaker 到目标家庭（或为全新用户新建 speaker）
    const stage = carriedLabel === PLACEHOLDER_SELF_LABEL ? "auto" : "self_set";
    if (currentSpeaker) {
      db.prepare("DELETE FROM member_aliases WHERE scope = 'speaker' AND speaker_profile_id = ?").run(currentSpeaker.id);
      db.prepare("UPDATE speaker_profiles SET family_id = ?, self_member_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(targetFamilyId, selfMemberId, currentSpeaker.id);
      patchSpeakerMetadata(db, currentSpeaker.id, { onboarding_stage: stage, joined_via: "invite" });
      for (const alias of ["我", "自己"]) upsertAlias(db, targetFamilyId, selfMemberId, alias, "speaker", currentSpeaker.id);
    } else {
      const speakerId = stableId("speaker", platform, externalUserId);
      db.prepare(`
        INSERT INTO speaker_profiles (id, family_id, platform, external_user_id, self_member_id, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform, external_user_id) DO UPDATE SET
          family_id = excluded.family_id, self_member_id = excluded.self_member_id, updated_at = datetime('now')
      `).run(speakerId, targetFamilyId, platform, externalUserId, selfMemberId, JSON.stringify({ onboarding_stage: stage, joined_via: "invite" }));
      for (const alias of ["我", "自己"]) upsertAlias(db, targetFamilyId, selfMemberId, alias, "speaker", speakerId);
    }

    // 3. 按人分池：把加入者自己累计的 owner 池迁到 ta 在新家庭里的 self（不并入邀请人的池）；旧家庭无成员则删除（级联清理）
    if (current) {
      const fromOwner = current.settings.default_owner_id;
      if (fromOwner && fromOwner !== selfMemberId) migrated = migrateOwnerPool(fromOwner, selfMemberId, db).moved;
      const remaining = (db.prepare("SELECT COUNT(*) AS c FROM speaker_profiles WHERE family_id = ?").get(current.family.id) as { c: number }).c;
      if (remaining === 0) db.prepare("DELETE FROM families WHERE id = ?").run(current.family.id);
    }

    // 4. 标记邀请码已用
    db.prepare(`
      UPDATE verification_codes SET claimed_by_openid = ?, claimed_by_platform = ?, claimed_at = datetime('now'), used_at = datetime('now')
      WHERE code = ?
    `).run(externalUserId, platform, code);
  });
  tx();

  return { ok: true, family: getFamilySummary({ family_id: targetFamilyId }, db)!, migrated };
}
