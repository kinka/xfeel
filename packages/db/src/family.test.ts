import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "./schema";
import {
  getAliasContextForSpeaker, getFamilySummary, upsertFamilyOnboarding,
  autoProvisionFamilyForSpeaker, setSpeakerSelf, getSpeakerOnboardingState, markSpeakerReminded,
  createFamilyInvite, joinFamilyByInvite, migrateOwnerPool, getFamilyOwnerIds,
  getEntityLexiconForOwner, updateFamilyName, PLACEHOLDER_SELF_LABEL,
} from "./family";

describe("getEntityLexiconForOwner (规则兜底的运行时实体词典)", () => {
  test("返回本家庭 global 别名映射与孩子列表，排除 speaker 视角词", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      upsertFamilyOnboarding({
        family_id: "fam-lex", name: "词典家",
        members: [
          { id: "lex-dad", label: "爸爸", role: "parent" },
          { id: "lex-kid", label: "星星", role: "child", aliases: ["阿星", "星宝"] },
        ],
        speaker: {
          external_user_id: "wx-lex-dad", platform: "weixin", self_member_id: "lex-dad",
          aliases: [{ alias: "我崽", member_id: "lex-kid", scope: "speaker" }],
        },
        settings: { default_owner_id: "lex-dad" },
      }, db);

      const lexicon = getEntityLexiconForOwner("lex-dad", db);
      expect(lexicon.labels.sort()).toEqual(["星星", "爸爸"].sort());
      expect(lexicon.aliasToLabel["阿星"]).toBe("星星");
      expect(lexicon.aliasToLabel["星宝"]).toBe("星星");
      expect(lexicon.aliasToLabel["星星"]).toBe("星星");
      expect(lexicon.aliasToLabel["我崽"]).toBeUndefined(); // speaker 视角不进跨说话人词典
      expect(lexicon.aliasToLabel["我"]).toBeUndefined();
      expect(lexicon.collectiveChildren).toEqual(["星星"]);

      // 家庭之外的 owner / 未知 owner：空词典
      expect(getEntityLexiconForOwner("no-such-owner", db).labels).toEqual([]);
      expect(getEntityLexiconForOwner(undefined, db).labels).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("getFamilyOwnerIds (多租户隔离基元)", () => {
  test("返回家庭全部成员 id + default_owner，家庭间互不含", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      upsertFamilyOnboarding({
        family_id: "fam-a", name: "A 家",
        members: [{ id: "a-dad", label: "爸爸", role: "parent" }, { id: "a-kid", label: "小禾", role: "child" }],
        settings: { default_owner_id: "a-dad" },
      }, db);
      upsertFamilyOnboarding({
        family_id: "fam-b", name: "B 家",
        members: [{ id: "b-mom", label: "妈妈", role: "parent" }],
        settings: { default_owner_id: "b-mom" },
      }, db);

      const a = new Set(getFamilyOwnerIds("fam-a", db));
      expect(a.has("a-dad")).toBe(true);
      expect(a.has("a-kid")).toBe(true);
      expect(a.has("b-mom")).toBe(false); // 看不到别家
      expect(new Set(getFamilyOwnerIds("fam-b", db)).has("b-mom")).toBe(true);
      expect(getFamilyOwnerIds("", db)).toEqual([]);
      expect(getFamilyOwnerIds(undefined, db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("family onboarding", () => {
  test("creates adjustable family members, speaker profile, settings, and alias context", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      const summary = upsertFamilyOnboarding({
        family_id: "fam-1",
        name: "测试家庭",
        members: [
          { label: "爸爸", role: "parent", aliases: ["老公"] },
          { label: "妈妈", role: "parent", aliases: ["老婆"] },
          { label: "小禾", role: "child", aliases: ["禾禾", "阿禾"] },
          { label: "小星", role: "child", aliases: ["星星", "阿星"] },
        ],
        speaker: {
          id: "speaker-dad",
          platform: "weixin",
          external_user_id: "wx-dad",
          self_member_id: "爸爸",
          display_name: "爸爸微信",
          aliases: [{ alias: "我老婆", member_id: "妈妈", scope: "speaker" }],
        },
        settings: { timezone: "Asia/Shanghai", record_mode: "conservative", default_owner_id: "wx-dad" },
      }, db);

      expect(summary.family).toEqual({ id: "fam-1", name: "测试家庭" });
      expect(new Set(summary.members.map(member => member.label))).toEqual(new Set(["爸爸", "妈妈", "小禾", "小星"]));
      expect(summary.settings.timezone).toBe("Asia/Shanghai");
      expect(summary.aliasContext.selfLabel).toBe("爸爸");
      expect(new Set(summary.aliasContext.collectiveChildren)).toEqual(new Set(["小禾", "小星"]));
      expect(summary.aliasContext.aliases?.some(alias => alias.alias === "阿星" && alias.label === "小星")).toBe(true);
      expect(summary.aliasContext.aliases?.some(alias => alias.alias === "阿禾" && alias.label === "小禾")).toBe(true);
      expect(summary.aliasContext.aliases?.some(alias => alias.alias === "我老婆" && alias.label === "妈妈" && alias.scope === "speaker")).toBe(true);

      const updated = upsertFamilyOnboarding({
        family_id: "fam-1",
        speaker: {
          external_user_id: "wx-dad",
          self_member_id: "爸爸",
          aliases: [{ alias: "队友", member_id: "妈妈", scope: "invalid" as "speaker" }],
        },
        settings: { record_mode: "invalid" as "conservative" },
      }, db);
      expect(updated.settings.record_mode).toBe("conservative");
      expect(updated.aliasContext.selfLabel).toBe("爸爸");
      expect(updated.aliasContext.aliases?.some(alias => alias.alias === "队友" && alias.label === "妈妈" && alias.scope === "speaker")).toBe(true);

      const byExternalUser = getFamilySummary({ platform: "weixin", external_user_id: "wx-dad" }, db);
      expect(byExternalUser?.family.id).toBe("fam-1");
      expect(getAliasContextForSpeaker({ platform: "weixin", external_user_id: "wx-dad" }, db)?.selfLabel).toBe("爸爸");
    } finally {
      db.close();
    }
  });
});

describe("new-user onboarding (phase 1)", () => {
  test("auto-provisions a single-family placeholder self for a fresh openid", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      const summary = autoProvisionFamilyForSpeaker({ platform: "weixin", external_user_id: "wx-new" }, db);

      expect(summary.family.name).toMatch(/^家庭-/);
      expect(summary.members).toHaveLength(1);
      const self = summary.members[0]!;
      expect(self.label).toBe(PLACEHOLDER_SELF_LABEL);
      expect(self.role).toBe("unknown");
      // owner 池 = 占位 self 成员 id，保证消息有归属
      expect(summary.settings.default_owner_id).toBe(self.id);
      expect(summary.aliasContext.selfLabel).toBe(PLACEHOLDER_SELF_LABEL);

      // 幂等：再调一次返回同一个家庭，不会重复建
      const again = autoProvisionFamilyForSpeaker({ platform: "weixin", external_user_id: "wx-new" }, db);
      expect(again.family.id).toBe(summary.family.id);

      const state = getSpeakerOnboardingState({ platform: "weixin", external_user_id: "wx-new" }, db);
      expect(state?.stage).toBe("auto");
      expect(state?.remindedAt).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("auto-provisioned family name can be updated later", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      const summary = autoProvisionFamilyForSpeaker({ platform: "weixin", external_user_id: "wx-new" }, db);
      const updated = updateFamilyName({ family_id: summary.family.id, name: "301 室" }, db);

      expect(updated.family.name).toBe("301 室");
      expect(getFamilySummary({ family_id: summary.family.id }, db)?.family.name).toBe("301 室");
    } finally {
      db.close();
    }
  });

  test("setSpeakerSelf renames placeholder in place, keeping owner_id stable", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      const provisioned = autoProvisionFamilyForSpeaker({ platform: "weixin", external_user_id: "wx-new" }, db);
      const ownerBefore = provisioned.settings.default_owner_id;

      const updated = setSpeakerSelf({ platform: "weixin", external_user_id: "wx-new", label: "爸爸", role: "parent" }, db);

      expect(updated.members).toHaveLength(1);
      expect(updated.members[0]!.label).toBe("爸爸");
      expect(updated.members[0]!.role).toBe("parent");
      // owner 池没变 → 之前记的内容不会丢
      expect(updated.settings.default_owner_id).toBe(ownerBefore);
      expect(updated.aliasContext.selfLabel).toBe("爸爸");
      // 说话人「我」解析到爸爸
      const self = updated.aliasContext.aliases?.find(a => a.alias === "我" && a.scope === "speaker");
      expect(self?.label).toBe("爸爸");
      // 占位 label 不再作为 global 别名残留
      expect(updated.aliasContext.aliases?.some(a => a.alias === PLACEHOLDER_SELF_LABEL)).toBe(false);

      const state = getSpeakerOnboardingState({ platform: "weixin", external_user_id: "wx-new" }, db);
      expect(state?.stage).toBe("self_set");
    } finally {
      db.close();
    }
  });

  test("legacy bound speaker without onboarding_stage is treated as self_set (no nagging)", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      upsertFamilyOnboarding({
        family_id: "fam-legacy",
        name: "老家庭",
        members: [{ label: "爸爸", role: "parent" }],
        speaker: { external_user_id: "wx-legacy", platform: "weixin", self_member_id: "爸爸" },
        settings: { default_owner_id: "wx-legacy" },
      }, db);

      const state = getSpeakerOnboardingState({ platform: "weixin", external_user_id: "wx-legacy" }, db);
      expect(state?.stage).toBe("self_set");
    } finally {
      db.close();
    }
  });

  test("markSpeakerReminded records a timestamp for throttling", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      autoProvisionFamilyForSpeaker({ platform: "weixin", external_user_id: "wx-new" }, db);
      const state = getSpeakerOnboardingState({ platform: "weixin", external_user_id: "wx-new" }, db)!;
      markSpeakerReminded(state.speakerId, db);
      const after = getSpeakerOnboardingState({ platform: "weixin", external_user_id: "wx-new" }, db);
      expect(after?.remindedAt).toBeTruthy();
    } finally {
      db.close();
    }
  });
});

describe("family invite & join (phase 2)", () => {
  function seedOwnerData(db: Database, owner: string, date: string) {
    db.prepare("INSERT INTO memory_events (id, summary, original_text, event_type, entities, user_id) VALUES (?, ?, ?, 'note', '[]', ?)")
      .run(crypto.randomUUID(), `s-${owner}`, `t-${owner}`, owner);
    db.prepare("INSERT INTO conversation_turns (id, owner_id, role, content, turn_date, source) VALUES (?, ?, 'user', ?, ?, 'log')")
      .run(crypto.randomUUID(), owner, `c-${owner}`, date);
  }

  test("invite creates a code; joining moves the joiner's pool to their own self, not the inviter's", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      // 邀请人（爸爸，已确认身份）
      autoProvisionFamilyForSpeaker({ platform: "weixin", external_user_id: "wx-dad" }, db);
      setSpeakerSelf({ platform: "weixin", external_user_id: "wx-dad", label: "爸爸", role: "parent" }, db);
      const dadFamily = getFamilySummary({ platform: "weixin", external_user_id: "wx-dad" }, db)!;
      const dadOwner = dadFamily.settings.default_owner_id!;
      seedOwnerData(db, dadOwner, "2026-06-19");

      // 加入者（妈妈）先各自记了点东西
      const momFamily = autoProvisionFamilyForSpeaker({ platform: "weixin", external_user_id: "wx-mom" }, db);
      setSpeakerSelf({ platform: "weixin", external_user_id: "wx-mom", label: "妈妈", role: "parent" }, db);
      const momOwnerBefore = getFamilySummary({ platform: "weixin", external_user_id: "wx-mom" }, db)!.settings.default_owner_id!;
      seedOwnerData(db, momOwnerBefore, "2026-06-20");

      const invite = createFamilyInvite({ platform: "weixin", external_user_id: "wx-dad" }, db)!;
      expect(invite.code).toMatch(/^\d{6}$/);
      expect(invite.familyId).toBe(dadFamily.family.id);

      const join = joinFamilyByInvite({ platform: "weixin", external_user_id: "wx-mom", code: invite.code }, db);
      expect(join.ok).toBe(true);

      // 妈妈现在属于爸爸的家庭，但有她自己的 self 与 owner 池
      const momAfter = getFamilySummary({ platform: "weixin", external_user_id: "wx-mom" }, db)!;
      expect(momAfter.family.id).toBe(dadFamily.family.id);
      expect(momAfter.aliasContext.selfLabel).toBe("妈妈");
      const momOwner = momAfter.aliasContext.selfMemberId!;
      expect(momOwner).not.toBe(dadOwner);

      // 妈妈加入前记的内容迁到了她在新家庭的 self 池，而不是并入爸爸的池
      expect((db.prepare("SELECT COUNT(*) AS c FROM memory_events WHERE user_id = ?").get(momOwner) as { c: number }).c).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS c FROM conversation_turns WHERE owner_id = ?").get(momOwner) as { c: number }).c).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS c FROM memory_events WHERE user_id = ?").get(momOwnerBefore) as { c: number }).c).toBe(0);
      // 爸爸的池只剩爸爸自己记的，没被妈妈的内容污染
      expect((db.prepare("SELECT COUNT(*) AS c FROM memory_events WHERE user_id = ?").get(dadOwner) as { c: number }).c).toBe(1);

      // 旧的妈妈家庭已删除
      expect(db.prepare("SELECT 1 FROM families WHERE id = ?").get(momFamily.family.id)).toBeNull();
      // 邀请码已消费
      expect((db.prepare("SELECT used_at FROM verification_codes WHERE code = ?").get(invite.code) as { used_at: string | null }).used_at).toBeTruthy();
    } finally {
      db.close();
    }
  });

  test("rejects expired / unknown codes and re-joining; invite reusable within TTL", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      autoProvisionFamilyForSpeaker({ platform: "weixin", external_user_id: "wx-dad" }, db);
      const fam = getFamilySummary({ platform: "weixin", external_user_id: "wx-dad" }, db)!;

      expect(joinFamilyByInvite({ platform: "weixin", external_user_id: "wx-mom", code: "ZZZZZZ" }, db).reason).toBe("code_not_found");

      // 过期码
      db.prepare("INSERT INTO verification_codes (code, purpose, family_id, expires_at) VALUES ('EXPIRE', 'invite', ?, ?)")
        .run(fam.family.id, new Date(Date.now() - 1000).toISOString());
      expect(joinFamilyByInvite({ platform: "weixin", external_user_id: "wx-mom", code: "EXPIRE" }, db).reason).toBe("expired");

      // 已在该家庭里
      const invite = createFamilyInvite({ platform: "weixin", external_user_id: "wx-dad" }, db)!;
      expect(joinFamilyByInvite({ platform: "weixin", external_user_id: "wx-dad", code: invite.code }, db).reason).toBe("already_in_family");

      // 有效期内可多人使用：妈妈用完，奶奶还能用同一个码
      const invite2 = createFamilyInvite({ platform: "weixin", external_user_id: "wx-dad" }, db)!;
      expect(joinFamilyByInvite({ platform: "weixin", external_user_id: "wx-mom", code: invite2.code }, db).ok).toBe(true);
      expect(joinFamilyByInvite({ platform: "weixin", external_user_id: "wx-new2", code: invite2.code }, db).ok).toBe(true);
    } finally {
      db.close();
    }
  });

  test("migrateOwnerPool keeps target rows on unique conflicts (daily_archives)", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      const from = "owner-from";
      const to = "owner-to";
      // 两边同一天都有归档 → 唯一约束冲突，应保留目标、丢弃来源
      db.prepare("INSERT INTO daily_archives (id, owner_id, archive_date, summary, status) VALUES (?, ?, '2026-06-20', 'from', 'done')").run(crypto.randomUUID(), from);
      db.prepare("INSERT INTO daily_archives (id, owner_id, archive_date, summary, status) VALUES (?, ?, '2026-06-20', 'to', 'done')").run(crypto.randomUUID(), to);
      db.prepare("INSERT INTO daily_archives (id, owner_id, archive_date, summary, status) VALUES (?, ?, '2026-06-21', 'from-only', 'done')").run(crypto.randomUUID(), from);

      migrateOwnerPool(from, to, db);

      const rows = db.prepare("SELECT archive_date, summary FROM daily_archives WHERE owner_id = ? ORDER BY archive_date").all(to) as Array<{ archive_date: string; summary: string }>;
      expect(rows.map(r => r.archive_date)).toEqual(["2026-06-20", "2026-06-21"]);
      expect(rows.find(r => r.archive_date === "2026-06-20")?.summary).toBe("to"); // 冲突日保留目标
      expect((db.prepare("SELECT COUNT(*) AS c FROM daily_archives WHERE owner_id = ?").get(from) as { c: number }).c).toBe(0);
    } finally {
      db.close();
    }
  });
});
