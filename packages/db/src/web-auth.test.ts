import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "./schema";
import { createFamilyInvite, getFamilySummary, upsertFamilyOnboarding } from "./family";
import {
  createWebLoginCode, claimWebLoginCode, getWebLoginStatus, redeemWebLoginCode, getWebSession, normalizeLoginCode,
  authorizeWebSessionForWechat,
} from "./web-auth";

describe("web login (phase 3)", () => {
  test("full flow: web code → wechat claim → redeem 1y token", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      const { code } = createWebLoginCode(db);
      expect(code).toMatch(/^\d{6}$/);
      expect(getWebLoginStatus(code, db)).toBe("pending");
      // 未认领时不能兑换
      expect(redeemWebLoginCode(code, db).status).toBe("pending");

      // 用户在公众号发暗号（容忍小写/缺横线）→ 认领并自动开户
      const claim = claimWebLoginCode({ platform: "weixin", external_user_id: "wx-user", code: code.toLowerCase().replace("-", "") }, db);
      expect(claim.ok).toBe(true);
      expect(getWebLoginStatus(code, db)).toBe("claimed");

      const redeem = redeemWebLoginCode(code, db);
      expect(redeem.status).toBe("authorized");
      expect(redeem.token).toBeTruthy();
      // 自动开户的家庭 owner 与该 openid 对齐
      const family = getFamilySummary({ platform: "weixin", external_user_id: "wx-user" }, db)!;
      expect(redeem.familyId).toBe(family.family.id);
      expect(redeem.ownerId).toBe(family.settings.default_owner_id);

      // 暗号一次性：兑换后置为已用
      expect(getWebLoginStatus(code, db)).toBe("used");
      expect(redeemWebLoginCode(code, db).status).toBe("used");

      // token 可校验，且携带身份
      const session = getWebSession(redeem.token!, db);
      expect(session?.externalUserId).toBe("wx-user");
      expect(session?.familyId).toBe(family.family.id);
      expect(getWebSession("bogus-token", db)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("claim binds an existing family without provisioning a new one", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      // 已有家庭
      upsertFamilyOnboarding({
        family_id: "fam-x",
        name: "X 家庭",
        members: [{ label: "爸爸", role: "parent" }],
        speaker: { external_user_id: "wx-dad", platform: "weixin", self_member_id: "爸爸" },
        settings: { default_owner_id: "owner-x" },
      }, db);

      const { code } = createWebLoginCode(db);
      expect(claimWebLoginCode({ platform: "weixin", external_user_id: "wx-dad", code }, db).familyName).toBe("X 家庭");
      const redeem = redeemWebLoginCode(code, db);
      expect(redeem.familyId).toBe("fam-x");
      expect(redeem.ownerId).toBe("owner-x");
      expect(redeem.speakerLabel).toBe("爸爸");
      // 没有多建家庭
      expect((db.prepare("SELECT COUNT(*) AS c FROM families").get() as { c: number }).c).toBe(1);
    } finally {
      db.close();
    }
  });

  test("oauth login can reuse an existing invite code to join a family", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      upsertFamilyOnboarding({
        family_id: "fam-x",
        name: "X 家庭",
        members: [{ label: "爸爸", role: "parent" }],
        speaker: { external_user_id: "wx-dad", platform: "weixin", self_member_id: "爸爸" },
        settings: { default_owner_id: "owner-x" },
      }, db);
      const invite = createFamilyInvite({ platform: "weixin", external_user_id: "wx-dad" }, db)!;

      const login = authorizeWebSessionForWechat({
        platform: "weixin",
        external_user_id: "wx-mom",
        invite_code: invite.code,
      }, db);

      expect(login.status).toBe("authorized");
      expect(login.joinedInvite).toBe(true);
      expect(login.familyId).toBe("fam-x");
      expect(login.token).toBeTruthy();
      expect(getWebSession(login.token!, db)?.familyId).toBe("fam-x");
      expect(getFamilySummary({ platform: "weixin", external_user_id: "wx-mom" }, db)?.family.id).toBe("fam-x");
    } finally {
      db.close();
    }
  });

  test("rejects expired / double claim, and normalizes input format", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      expect(normalizeLoginCode(" 12 3456 ")).toBe("123456");   // 容忍中间空格
      expect(normalizeLoginCode("记：今天天气不错")).toBeNull();
      expect(normalizeLoginCode("12345")).toBeNull();            // 非 6 位
      expect(normalizeLoginCode("XF-1234")).toBeNull();          // 不再接受字母/中划线

      expect(claimWebLoginCode({ platform: "weixin", external_user_id: "wx-user", code: "999999" }, db).reason).toBe("code_not_found");

      // 过期暗号
      db.prepare("INSERT INTO verification_codes (code, purpose, expires_at) VALUES ('111111', 'web_login', ?)")
        .run(new Date(Date.now() - 1000).toISOString());
      expect(claimWebLoginCode({ platform: "weixin", external_user_id: "wx-user", code: "111111" }, db).reason).toBe("expired");

      // 二次认领被拒
      const { code } = createWebLoginCode(db);
      expect(claimWebLoginCode({ platform: "weixin", external_user_id: "wx-a", code }, db).ok).toBe(true);
      expect(claimWebLoginCode({ platform: "weixin", external_user_id: "wx-b", code }, db).reason).toBe("already_claimed");
    } finally {
      db.close();
    }
  });

  test("locks web login code after repeated failed redeem attempts", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      const { code } = createWebLoginCode(db);

      // 未认领的暗号兑换返回 pending，不增加失败计数
      for (let i = 0; i < 10; i++) {
        expect(redeemWebLoginCode(code, db).status).toBe("pending");
      }

      // 让暗号过期，之后每次兑换都是失败，累计 5 次后锁定
      db.prepare("UPDATE verification_codes SET expires_at = ? WHERE code = ?")
        .run(new Date(Date.now() - 1000).toISOString(), code);

      for (let i = 0; i < 5; i++) {
        expect(redeemWebLoginCode(code, db).status).toBe("expired");
      }

      // 第 6 次触发锁定
      expect(redeemWebLoginCode(code, db).status).toBe("locked");
      expect(getWebLoginStatus(code, db)).toBe("locked");
    } finally {
      db.close();
    }
  });

  test("locks web login code after repeated failed claim attempts", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      // 先创建一个已认领的暗号
      const { code } = createWebLoginCode(db);
      expect(claimWebLoginCode({ platform: "weixin", external_user_id: "wx-a", code }, db).ok).toBe(true);

      // 其他微信号反复尝试认领该暗号，5 次失败后锁定
      for (let i = 0; i < 5; i++) {
        const result = claimWebLoginCode({ platform: "weixin", external_user_id: `wx-b-${i}`, code }, db);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("already_claimed");
      }

      const locked = claimWebLoginCode({ platform: "weixin", external_user_id: "wx-b-5", code }, db);
      expect(locked.ok).toBe(false);
      expect(locked.reason).toBe("locked");
      expect(getWebLoginStatus(code, db)).toBe("locked");
    } finally {
      db.close();
    }
  });

  test("successful claim clears failed attempt counter", () => {
    const db = new Database(":memory:");
    try {
      initSchema(db);
      const { code } = createWebLoginCode(db);

      // 先让暗号过期并失败 2 次
      db.prepare("UPDATE verification_codes SET expires_at = ? WHERE code = ?")
        .run(new Date(Date.now() - 1000).toISOString(), code);
      for (let i = 0; i < 2; i++) {
        expect(redeemWebLoginCode(code, db).status).toBe("expired");
      }

      // 重新创建一张新的有效暗号（旧暗号已过期），避免无法 claim
      // 这里直接更新原暗号让它重新有效，并继续测试
      db.prepare("UPDATE verification_codes SET expires_at = ? WHERE code = ?")
        .run(new Date(Date.now() + 10 * 60 * 1000).toISOString(), code);

      // 成功认领应清空失败计数
      expect(claimWebLoginCode({ platform: "weixin", external_user_id: "wx-user", code }, db).ok).toBe(true);
      const row = db.prepare("SELECT attempt_count, locked_until FROM verification_codes WHERE code = ?").get(code) as { attempt_count: number; locked_until: string | null };
      expect(row.attempt_count).toBe(0);
      expect(row.locked_until).toBeNull();
    } finally {
      db.close();
    }
  });
});
