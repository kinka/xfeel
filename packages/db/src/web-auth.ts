import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { getDB } from "./database";
import { autoProvisionFamilyForSpeaker, getFamilySummary, joinFamilyByInvite } from "./family";
import { signWebToken } from "./web-jwt";

/**
 * 网页登录（无客服推送版）：
 *   1. 网页 createWebLoginCode() 拿到一个 6 位纯数字暗号，显示给用户；
 *   2. 用户在公众号把暗号发给我们 → claimWebLoginCode() 用其 openid 认领并回填家庭；
 *   3. 网页轮询 getWebLoginStatus()，看到 "claimed" 后 redeemWebLoginCode() 兑换一个 1 年 token。
 * 暗号与家庭邀请码共用 verification_codes 表（purpose 区分）。
 */

const WEB_LOGIN_TTL_MS = 10 * 60 * 1000;          // 暗号 10 分钟有效
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000; // token 1 年有效
/** 暗号 = 6 位纯数字（无前缀、无中划线，方便微信里念/输）。 */
const CODE_LENGTH = 6;

function randomDigits(length = CODE_LENGTH): string {
  let s = "";
  for (let i = 0; i < length; i++) s += Math.floor(Math.random() * 10);
  return s;
}

/**
 * 把用户在微信里输入的暗号规整成标准形态（容忍中间空格）。非 6 位纯数字返回 null。
 * 注意：因为是裸数字，任何恰好 6 位纯数字的消息都会被当成登录暗号尝试认领（happy path 里
 * 用户登录就发这串数字；加入家庭走「加入 XXXXXX」不会撞车）。
 */
export function normalizeLoginCode(raw: string): string | null {
  const cleaned = raw.trim().replace(/\s+/g, "");
  return /^\d{6}$/.test(cleaned) ? cleaned : null;
}

export interface WebLoginCode {
  code: string;
  expiresAt: string;
}

export function createWebLoginCode(db: Database = getDB()): WebLoginCode {
  let code = randomDigits();
  for (let i = 0; i < 5 && db.prepare("SELECT 1 FROM verification_codes WHERE code = ?").get(code); i++) {
    code = randomDigits();
  }
  const expiresAt = new Date(Date.now() + WEB_LOGIN_TTL_MS).toISOString();
  db.prepare("INSERT INTO verification_codes (code, purpose, expires_at) VALUES (?, 'web_login', ?)").run(code, expiresAt);
  return { code, expiresAt };
}

interface CodeRow {
  code: string;
  family_id: string | null;
  expires_at: string;
  claimed_by_openid: string | null;
  claimed_at: string | null;
  used_at: string | null;
}

function loadLoginCode(db: Database, code: string): CodeRow | undefined {
  return db.prepare(`
    SELECT code, family_id, expires_at, claimed_by_openid, claimed_at, used_at
    FROM verification_codes WHERE code = ? AND purpose = 'web_login'
  `).get(code) as CodeRow | undefined;
}

export interface ClaimResult {
  ok: boolean;
  reason?: "code_not_found" | "expired" | "already_claimed" | "already_used";
  familyName?: string;
}

/** 公众号入站认领：用发暗号者的 openid 绑定该暗号，未开户则自动开户。 */
export function claimWebLoginCode(input: { platform?: string; external_user_id: string; code: string }, db: Database = getDB()): ClaimResult {
  const platform = input.platform?.trim() || "weixin";
  const externalUserId = input.external_user_id.trim();
  const normalized = normalizeLoginCode(input.code);
  if (!normalized) return { ok: false, reason: "code_not_found" };

  const row = loadLoginCode(db, normalized);
  if (!row) return { ok: false, reason: "code_not_found" };
  if (row.used_at) return { ok: false, reason: "already_used" };
  if (Date.parse(row.expires_at) < Date.now()) return { ok: false, reason: "expired" };
  if (row.claimed_at) return { ok: false, reason: "already_claimed" };

  let family = getFamilySummary({ platform, external_user_id: externalUserId }, db);
  if (!family) family = autoProvisionFamilyForSpeaker({ platform, external_user_id: externalUserId }, db);

  db.prepare(`
    UPDATE verification_codes
    SET claimed_by_openid = ?, claimed_by_platform = ?, family_id = ?, claimed_at = datetime('now')
    WHERE code = ?
  `).run(externalUserId, platform, family.family.id, normalized);

  return { ok: true, familyName: family.family.name };
}

export type WebLoginStatus = "not_found" | "pending" | "claimed" | "expired" | "used";

/** 网页轮询用：只读，不消费。 */
export function getWebLoginStatus(code: string, db: Database = getDB()): WebLoginStatus {
  const normalized = normalizeLoginCode(code);
  if (!normalized) return "not_found";
  const row = loadLoginCode(db, normalized);
  if (!row) return "not_found";
  if (row.used_at) return "used";
  if (Date.parse(row.expires_at) < Date.now()) return "expired";
  return row.claimed_at ? "claimed" : "pending";
}

export interface RedeemResult {
  status: "authorized" | "pending" | "expired" | "used" | "not_found";
  token?: string;
  expiresAt?: string;
  familyId?: string;
  ownerId?: string;
  speakerLabel?: string;
}

function issueWebSessionForSpeaker(input: {
  platform?: string;
  externalUserId: string;
  familyId: string;
}, db: Database): RedeemResult {
  const platform = input.platform?.trim() || "weixin";
  const externalUserId = input.externalUserId.trim();
  const family = getFamilySummary({ family_id: input.familyId }, db);
  const ownerId = family?.settings.default_owner_id || externalUserId;
  const speakerLabel = family?.aliasContext.selfLabel;

  // 派发一个自包含的 HS256 JWT（无状态校验用），同时把它作为 web_sessions.token 落库，
  // 保留吊销/审计能力。jti 让签名内容唯一，避免同一秒同一身份签出完全相同的串。
  const jti = randomBytes(12).toString("base64url");
  const { token, expiresAt } = signWebToken(
    { sub: ownerId, fam: input.familyId, uid: externalUserId, plat: platform, label: speakerLabel, jti },
    SESSION_TTL_MS,
  );

  db.prepare(`
    INSERT INTO web_sessions (token, platform, external_user_id, family_id, owner_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(token, platform, externalUserId, input.familyId, ownerId, expiresAt);

  return {
    status: "authorized",
    token,
    expiresAt,
    familyId: input.familyId,
    ownerId,
    speakerLabel,
  };
}

/** 网页兑换：暗号被认领后签发 1 年 token，并把暗号置为已用（一次性）。 */
export function redeemWebLoginCode(code: string, db: Database = getDB()): RedeemResult {
  const normalized = normalizeLoginCode(code);
  if (!normalized) return { status: "not_found" };
  const row = loadLoginCode(db, normalized);
  if (!row) return { status: "not_found" };
  if (row.used_at) return { status: "used" };
  if (Date.parse(row.expires_at) < Date.now()) return { status: "expired" };
  if (!row.claimed_by_openid || !row.family_id) return { status: "pending" };

  let result: RedeemResult | undefined;
  const tx = db.transaction(() => {
    result = issueWebSessionForSpeaker({ platform: "weixin", externalUserId: row.claimed_by_openid!, familyId: row.family_id! }, db);
    db.prepare("UPDATE verification_codes SET used_at = datetime('now') WHERE code = ?").run(normalized);
  });
  tx();

  return result!;
}

export interface OAuthLoginResult extends RedeemResult {
  joinedInvite?: boolean;
  joinReason?: "code_not_found" | "expired" | "already_used" | "already_in_family";
}

/** 微信网页授权回调：用 openid 直接签发网页 session；可选邀请码用于自动加入目标家庭。 */
export function authorizeWebSessionForWechat(input: {
  platform?: string;
  external_user_id: string;
  invite_code?: string;
}, db: Database = getDB()): OAuthLoginResult {
  const platform = input.platform?.trim() || "weixin";
  const externalUserId = input.external_user_id.trim();
  if (!externalUserId) return { status: "not_found" };

  let joinedInvite = false;
  let joinReason: OAuthLoginResult["joinReason"];
  const invite = input.invite_code?.trim();
  if (invite) {
    const joined = joinFamilyByInvite({ platform, external_user_id: externalUserId, code: invite }, db);
    joinedInvite = joined.ok;
    joinReason = joined.reason;
  }

  let family = getFamilySummary({ platform, external_user_id: externalUserId }, db);
  if (!family) family = autoProvisionFamilyForSpeaker({ platform, external_user_id: externalUserId }, db);
  return {
    ...issueWebSessionForSpeaker({ platform, externalUserId, familyId: family.family.id }, db),
    joinedInvite,
    joinReason,
  };
}

export interface WebSession {
  token: string;
  platform: string;
  externalUserId: string;
  familyId?: string;
  ownerId?: string;
  expiresAt: string;
}

/** 校验 token：未吊销且未过期才返回会话。 */
export function getWebSession(token: string, db: Database = getDB()): WebSession | null {
  const row = db.prepare(`
    SELECT token, platform, external_user_id, family_id, owner_id, expires_at, revoked
    FROM web_sessions WHERE token = ?
  `).get(token) as
    | { token: string; platform: string; external_user_id: string; family_id: string | null; owner_id: string | null; expires_at: string; revoked: number }
    | undefined;
  if (!row || row.revoked) return null;
  if (Date.parse(row.expires_at) < Date.now()) return null;
  return {
    token: row.token,
    platform: row.platform,
    externalUserId: row.external_user_id,
    familyId: row.family_id || undefined,
    ownerId: row.owner_id || undefined,
    expiresAt: row.expires_at,
  };
}
