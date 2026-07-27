import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import crypto from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("../../../packages/ai-client/src/llm", () => ({
  getLLM() {
    return {
      async chat() { throw new Error("LLM unavailable in test"); },
      async chatJSON() { throw new Error("LLM unavailable in test"); },
    };
  },
}));

// 本套件专门验证 JWT 登录门 + 多租户隔离，确保鉴权开启
delete process.env.XFEEL_AUTH_DISABLED;
process.env.XFEEL_JWT_SECRET = "auth-gate-test-secret";
process.env.XFEEL_ADMIN_TOKEN = "admin-secret-token";

const { buildApp } = await import("./server");
const { closeDB, getDB } = await import("../../../packages/db/src/database");
const { claimWebLoginCode } = await import("../../../packages/db/src/web-auth");

/** 跑完整登录流，返回 { token, ownerId }。 */
async function login(app: Awaited<ReturnType<typeof buildApp>>, openid: string) {
  const start = await app.inject({ method: "POST", url: "/web/login/start" });
  const code = start.json().code as string;
  claimWebLoginCode({ platform: "weixin", external_user_id: openid, code });
  const redeem = await app.inject({ method: "POST", url: "/web/login/redeem", payload: { code } });
  return { token: redeem.json().token as string, ownerId: redeem.json().owner_id as string };
}

describe("web JWT auth gate + multi-tenant isolation", () => {
  let dbPath = "";
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-authgate-${crypto.randomUUID()}.db`);
    process.env.XFEEL_DB_PATH = dbPath;
    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    closeDB();
    delete process.env.XFEEL_DB_PATH;
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });

  test("public routes stay open without a token", async () => {
    for (const url of ["/health", "/conversation/playground", "/web/auth.js"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
    }
  });

  test("wechat oauth start redirects to snsapi_base authorization", async () => {
    process.env.WECHAT_APP_ID = "wx-test-app";
    process.env.XFEEL_WEB_URL = "https://xfeel.today";
    const res = await app.inject({ method: "GET", url: "/wechat/oauth/start?next=/app&invite=ABC123" });
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain("https://open.weixin.qq.com/connect/oauth2/authorize");
    expect(location).toContain("appid=wx-test-app");
    expect(location).toContain("scope=snsapi_base");
    expect(decodeURIComponent(location)).toContain("redirect_uri=https://xfeel.today/wechat/oauth/callback");
    delete process.env.WECHAT_APP_ID;
    delete process.env.XFEEL_WEB_URL;
  });

  test("wechat oauth callback issues a web token and redirects to app", async () => {
    process.env.WECHAT_APP_ID = "wx-test-app";
    process.env.WECHAT_APP_SECRET = "wx-test-secret";
    process.env.XFEEL_WEB_URL = "https://xfeel.today";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ openid: "wx-oauth-user" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    try {
      const res = await app.inject({ method: "GET", url: "/wechat/oauth/callback?code=oauth-code" });
      expect(res.statusCode).toBe(302);
      const location = new URL(res.headers.location as string);
      expect(location.origin + location.pathname).toBe("https://xfeel.today/app");
      const token = location.searchParams.get("token");
      expect(token).toBeTruthy();
      const me = await app.inject({
        method: "GET",
        url: "/web/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().admin).toBe(false);
      expect(me.json().family_id).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.WECHAT_APP_ID;
      delete process.env.WECHAT_APP_SECRET;
      delete process.env.XFEEL_WEB_URL;
    }
  });

  test("protected data route returns 401 without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/conversation/turns?owner_id=whatever&date=2026-06-22" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "unauthorized" });
  });

  test("retired JSON Weixin endpoint is not publicly reachable", async () => {
    const res = await app.inject({ method: "POST", url: "/weixin/message", payload: { from_user_id: "spoofed", text: "帮助" } });
    expect(res.statusCode).toBe(401);
  });

  test("login issues a JWT that unlocks the caller's OWN owner (header only)", async () => {
    const { token, ownerId } = await login(app, "wx-owner-self");
    expect(token.split(".")).toHaveLength(3);

    const viaHeader = await app.inject({
      method: "GET",
      url: `/conversation/turns?owner_id=${encodeURIComponent(ownerId)}&date=2026-06-22`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(viaHeader.statusCode).toBe(200);

    // URL 查询参数会进日志/缓存/Referer：?token= 一律不再打开数据接口，只放行读单张媒体
    const viaQuery = await app.inject({
      method: "GET",
      url: `/conversation/turns?owner_id=${encodeURIComponent(ownerId)}&date=2026-06-22&token=${encodeURIComponent(token)}`,
    });
    expect(viaQuery.statusCode).toBe(401);

    const forged = await app.inject({
      method: "GET",
      url: `/conversation/turns?owner_id=${encodeURIComponent(ownerId)}&date=2026-06-22`,
      headers: { authorization: "Bearer not.a.jwt" },
    });
    expect(forged.statusCode).toBe(401);
  });

  test("media short token: fetches /media/:id via ?token= but opens nothing else", async () => {
    const { token, ownerId } = await login(app, "wx-media-user");
    const issued = await app.inject({ method: "GET", url: "/web/media-token", headers: { authorization: `Bearer ${token}` } });
    expect(issued.statusCode).toBe(200);
    const mediaToken = issued.json().token as string;
    expect(mediaToken.split(".")).toHaveLength(3);

    // 走查询参数读媒体：通过鉴权（资产不存在 → 404 而非 401）
    const media = await app.inject({ method: "GET", url: `/media/nonexistent-id?token=${encodeURIComponent(mediaToken)}` });
    expect(media.statusCode).toBe(404);

    // media-scope token 即使走 Authorization 头也开不了数据接口
    const data = await app.inject({
      method: "GET",
      url: `/conversation/turns?owner_id=${encodeURIComponent(ownerId)}&date=2026-06-22`,
      headers: { authorization: `Bearer ${mediaToken}` },
    });
    expect(data.statusCode).toBe(401);

    // 长期会话 token 走查询参数取媒体仍然可用（旧 <img> 兼容），但仅限媒体路径
    const legacyMedia = await app.inject({ method: "GET", url: `/media/nonexistent-id?token=${encodeURIComponent(token)}` });
    expect(legacyMedia.statusCode).toBe(404);
  });

  test("web self-label: placeholder user sets 称呼 without switching owner pool", async () => {
    const { token, ownerId } = await login(app, "wx-set-label");

    // 自动开户后：占位「本人」，onboarding 停在 auto
    const before = await app.inject({ method: "GET", url: "/web/me", headers: { authorization: `Bearer ${token}` } });
    expect(before.json()).toMatchObject({ onboarding_stage: "auto", speaker_label: "本人" });

    const set = await app.inject({
      method: "POST", url: "/web/profile/self",
      headers: { authorization: `Bearer ${token}` },
      payload: { label: "爸爸" },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ ok: true, label: "爸爸" });

    // 不用重新登录：/web/me 立即反映新称呼；owner id 不变（原地改名，记忆池连续）
    const after = await app.inject({ method: "GET", url: "/web/me", headers: { authorization: `Bearer ${token}` } });
    const me = after.json();
    expect(me).toMatchObject({ onboarding_stage: "self_set", speaker_label: "爸爸" });
    expect(me.owners).toEqual([{ id: ownerId, label: "爸爸" }]);

    // 非法称呼被拒
    const bad = await app.inject({
      method: "POST", url: "/web/profile/self",
      headers: { authorization: `Bearer ${token}` },
      payload: { label: "我是一个非常长的称呼哈哈" },
    });
    expect(bad.statusCode).toBe(400);
  });

  test("web family profile: caller can rename only their own family", async () => {
    const { token } = await login(app, "wx-family-profile");

    const before = await app.inject({ method: "GET", url: "/web/me", headers: { authorization: `Bearer ${token}` } });
    expect(before.statusCode).toBe(200);
    expect(before.json().family_name).toMatch(/^家庭-/);

    const set = await app.inject({
      method: "POST", url: "/web/profile/family",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "301 室" },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ ok: true, name: "301 室" });

    const after = await app.inject({ method: "GET", url: "/web/me", headers: { authorization: `Bearer ${token}` } });
    expect(after.json().family_name).toBe("301 室");

    const bad = await app.inject({
      method: "POST", url: "/web/profile/family",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "301 室!" },
    });
    expect(bad.statusCode).toBe(400);
  });

  test("admin can rename the selected family by family_id", async () => {
    await login(app, "wx-admin-family-a");
    await login(app, "wx-admin-family-b");
    const admin = { authorization: "Bearer admin-secret-token" };

    const before = await app.inject({ method: "GET", url: "/web/me", headers: admin });
    expect(before.statusCode).toBe(200);
    const target = before.json().owner_groups[1];

    const set = await app.inject({
      method: "POST", url: "/web/profile/family",
      headers: admin,
      payload: { family_id: target.family_id, name: "测试家庭 B" },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ ok: true, name: "测试家庭 B" });

    const after = await app.inject({ method: "GET", url: "/web/me", headers: admin });
    expect(after.json().owner_groups.find((g: { family_id: string }) => g.family_id === target.family_id).family_name).toBe("测试家庭 B");
  });

  test("isolation: a user cannot read another family's owner", async () => {
    const a = await login(app, "wx-family-a");
    const b = await login(app, "wx-family-b");
    expect(a.ownerId).not.toBe(b.ownerId);

    // A 用自己的 token 查 B 家庭的 owner → 403
    const cross = await app.inject({
      method: "GET",
      url: `/conversation/turns?owner_id=${encodeURIComponent(b.ownerId)}&date=2026-06-22`,
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(cross.statusCode).toBe(403);
    expect(cross.json()).toMatchObject({ reason: "owner_scope" });
  });

  test("isolation: resource ids and scope arrays cannot bypass family ownership", async () => {
    const a = await login(app, "wx-resource-family-a");
    const b = await login(app, "wx-resource-family-b");
    const db = getDB();
    db.prepare("INSERT INTO memory_events (id, summary, original_text, event_type, user_id) VALUES (?, ?, ?, ?, ?)")
      .run("foreign-event", "B 家私密事件", "B 家私密事件", "other", b.ownerId);
    db.prepare("INSERT INTO memory_events (id, summary, original_text, event_type, user_id) VALUES (?, ?, ?, ?, ?)")
      .run("own-event", "A 家事件", "A 家事件", "other", a.ownerId);
    db.prepare("INSERT INTO conversation_turns (id, owner_id, role, content, turn_date) VALUES (?, ?, 'user', ?, ?)")
      .run("foreign-turn", b.ownerId, "B 家私密对话", "2026-06-22");
    db.prepare("INSERT INTO conversation_turns (id, owner_id, role, content, turn_date) VALUES (?, ?, 'user', ?, ?)")
      .run("own-turn", a.ownerId, "A 家对话", "2026-06-22");
    const headers = { authorization: `Bearer ${a.token}` };

    const event = await app.inject({ method: "GET", url: "/events/foreign-event", headers });
    expect(event.statusCode).toBe(404);

    const recall = await app.inject({
      method: "POST", url: "/recall", headers,
      payload: { owner_id: a.ownerId, scope_owner_ids: [b.ownerId], text: "B 家私密事件" },
    });
    expect(recall.statusCode).toBe(403);
    expect(recall.json()).toMatchObject({ reason: "owner_scope" });

    const deletion = await app.inject({
      method: "POST", url: "/conversation/turns/delete", headers,
      payload: { turn_id: "foreign-turn" },
    });
    expect(deletion.statusCode).toBe(403);
    expect((db.prepare("SELECT COUNT(*) AS c FROM conversation_turns WHERE id = ?").get("foreign-turn") as { c: number }).c).toBe(1);

    const ownEvent = await app.inject({ method: "GET", url: "/events/own-event", headers });
    expect(ownEvent.statusCode).toBe(200);

    const ownDeletion = await app.inject({
      method: "POST", url: "/conversation/turns/delete", headers,
      payload: { turn_id: "own-turn" },
    });
    expect(ownDeletion.statusCode).toBe(200);
    expect((db.prepare("SELECT COUNT(*) AS c FROM conversation_turns WHERE id = ?").get("own-turn") as { c: number }).c).toBe(0);
  });

  test("isolation: global dashboard endpoints are admin-only", async () => {
    const a = await login(app, "wx-normal");
    const stats = await app.inject({ method: "GET", url: "/stats", headers: { authorization: `Bearer ${a.token}` } });
    expect(stats.statusCode).toBe(403);
    expect(stats.json()).toMatchObject({ reason: "admin_only" });
  });

  test("admin token sees everything (any owner + global dashboard)", async () => {
    const b = await login(app, "wx-someone");
    const admin = { authorization: "Bearer admin-secret-token" };

    const anyOwner = await app.inject({
      method: "GET",
      url: `/conversation/turns?owner_id=${encodeURIComponent(b.ownerId)}&date=2026-06-22`,
      headers: admin,
    });
    expect(anyOwner.statusCode).toBe(200);

    const stats = await app.inject({ method: "GET", url: "/stats", headers: admin });
    expect(stats.statusCode).toBe(200);
  });

  test("/web/me returns the caller's own family owners", async () => {
    const { token, ownerId } = await login(app, "wx-me");
    const me = await app.inject({ method: "GET", url: "/web/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.admin).toBe(false);
    expect(body.owners.map((o: { id: string }) => o.id)).toContain(ownerId);
  });

  test("rate limit: excessive web login start requests are throttled per IP", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: "POST", url: "/web/login/start" });
      expect(res.statusCode).toBe(200);
    }
    const res = await app.inject({ method: "POST", url: "/web/login/start" });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: "too_many_requests" });
  });

  test("rate limit: excessive web login redeem attempts are throttled per IP", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await app.inject({ method: "POST", url: "/web/login/redeem", payload: { code: "999999" } });
      expect(res.statusCode).toBe(409);
    }
    const res = await app.inject({ method: "POST", url: "/web/login/redeem", payload: { code: "999999" } });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: "too_many_requests" });
  });
});
