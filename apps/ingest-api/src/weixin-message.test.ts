import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import crypto from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

mock.module("../../../packages/ai-client/src/llm", () => ({
  getLLM() {
    return {
      async chat() {
        throw new Error("LLM unavailable in test");
      },
      async chatJSON(...args: unknown[]) {
        const serialized = JSON.stringify(args);
        if (serialized.includes("超慢处理")) {
          await new Promise(resolve => setTimeout(resolve, 700));
        } else if (serialized.includes("慢处理")) {
          await new Promise(resolve => setTimeout(resolve, 260));
        }
        throw new Error("LLM unavailable in test");
      },
    };
  },
}));

process.env.XFEEL_AUTH_DISABLED = "1"; // 测试内直连数据接口，旁路 JWT 登录门
process.env.WECHAT_RETRY_HOLD_TIMEOUT_MS = "150";
process.env.WECHAT_FINAL_RETRY_REPLY_TIMEOUT_MS = "300";
process.env.WECHAT_DISPLAYABLE_ATTEMPT = "3";

const { buildApp } = await import("./server");
const { closeDB, getDB } = await import("../../../packages/db/src/database");

const WEIXIN_USER = "wx-dad";
const MEMORY_OWNER = "demo-dad-owner";
function entitiesFromRows(rows: Array<{ entities: string }>) {
  return new Set(rows.flatMap(row => JSON.parse(row.entities) as string[]));
}

function wechatXml(content: string, msgType = "text", msgId = "1234567890", extraFields = "") {
  return `<xml>
<ToUserName><![CDATA[gh_xfeel]]></ToUserName>
<FromUserName><![CDATA[${WEIXIN_USER}]]></FromUserName>
<CreateTime>1718000000</CreateTime>
<MsgType><![CDATA[${msgType}]]></MsgType>
<Content><![CDATA[${content}]]></Content>
<MsgId>${msgId}</MsgId>
${extraFields}
</xml>`;
}

function wechatVoiceXml(recognition: string, msgId = "voice-msg-1") {
  return wechatXml("", "voice", msgId, `<MediaId><![CDATA[media-${msgId}]]></MediaId>\n<Format><![CDATA[amr]]></Format>\n<Recognition><![CDATA[${recognition}]]></Recognition>`);
}

function validWechatSignature(timestamp: string, nonce: string, token = "xfeel") {
  return crypto.createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex");
}

describe("wechat message entry", () => {
  let dbPath = "";
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-weixin-${crypto.randomUUID()}.db`);
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

  async function onboardWeixinSpeaker() {
    const onboarding = await app.inject({
      method: "POST",
      url: "/onboarding/family",
      payload: {
        family_id: "fam-weixin",
        name: "微信测试家庭",
        members: [
          // 按人分池：爸爸 speaker 的 self 成员 id 即其 owner 池 id，与 default_owner_id 保持一致
          { id: MEMORY_OWNER, label: "爸爸", role: "parent", aliases: ["老公"] },
          { label: "妈妈", role: "parent", aliases: ["老婆"] },
          { label: "小禾", role: "child", aliases: ["禾禾", "阿禾"] },
          { label: "小星", role: "child", aliases: ["星星", "阿星"] },
        ],
        speaker: {
          external_user_id: WEIXIN_USER,
          platform: "weixin",
          self_member_id: "爸爸",
          display_name: "爸爸微信",
          aliases: [
            { alias: "我老婆", member_id: "妈妈", scope: "speaker" },
            { alias: "我老公", member_id: "爸爸", scope: "speaker" },
          ],
        },
        settings: { default_owner_id: MEMORY_OWNER, record_mode: "balanced" },
      },
    });
    expect(onboarding.statusCode).toBe(200);
  }

  test("greets a new follower with help on /wechat subscribe event", async () => {
    const xml = `<xml>
<ToUserName><![CDATA[gh_xfeel]]></ToUserName>
<FromUserName><![CDATA[wx-follower]]></FromUserName>
<CreateTime>1718000000</CreateTime>
<MsgType><![CDATA[event]]></MsgType>
<Event><![CDATA[subscribe]]></Event>
</xml>`;
    const res = await app.inject({ method: "POST", url: "/wechat", headers: { "content-type": "text/xml" }, payload: xml });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("欢迎关注");
    expect(res.body).toContain("邀请");
  });

  test("web login: start → wechat claims passphrase → redeem 1y token", async () => {
    // 网页申请登录，拿到暗号
    const start = await app.inject({ method: "POST", url: "/web/login/start" });
    expect(start.statusCode).toBe(200);
    const { code } = JSON.parse(start.body) as { code: string };
    expect(code).toMatch(/^\d{6}$/);

    // 未认领前不能兑换
    const early = await app.inject({ method: "POST", url: "/web/login/redeem", payload: { code } });
    expect(early.statusCode).toBe(409);
    expect(JSON.parse(early.body).status).toBe("pending");

    // 用户在公众号回复暗号 → 认领
    const claim = await app.inject({
      method: "POST", url: "/wechat", headers: { "content-type": "text/xml" },
      payload: wechatXml(code, "text", "web-login-claim"),
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.body).toContain("已确认");

    // 网页轮询看到 claimed
    const status = await app.inject({ method: "GET", url: `/web/login/status?code=${encodeURIComponent(code)}` });
    expect(JSON.parse(status.body).status).toBe("claimed");

    // 兑换 token
    const redeem = await app.inject({ method: "POST", url: "/web/login/redeem", payload: { code } });
    expect(redeem.statusCode).toBe(200);
    const redeemBody = JSON.parse(redeem.body) as { status: string; token: string; owner_id: string };
    expect(redeemBody.status).toBe("authorized");
    expect(redeemBody.token).toBeTruthy();
    expect(redeemBody.owner_id).toBeTruthy();

    // 一次性：再次兑换失败
    const again = await app.inject({ method: "POST", url: "/web/login/redeem", payload: { code } });
    expect(again.statusCode).toBe(409);
    expect(JSON.parse(again.body).status).toBe("used");
  });

  test("keeps original /wechat verification path compatible", async () => {
    const timestamp = "1718000000";
    const nonce = "nonce-1";
    const echostr = "hello-xfeel";
    const signature = validWechatSignature(timestamp, nonce);
    const res = await app.inject({
      method: "GET",
      url: `/wechat?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}&echostr=${echostr}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(echostr);
  });

  test("accepts original /wechat XML webhook and applies alias context", async () => {
    await onboardWeixinSpeaker();

    const log = await app.inject({
      method: "POST",
      url: "/wechat",
      headers: { "content-type": "text/xml" },
      payload: wechatXml("记：今天我老婆带阿星出门，阿星很开心。"),
    });
    expect(log.statusCode).toBe(200);
    expect(log.headers["content-type"]).toContain("application/xml");
    expect(log.body).toContain("<xml>");
    expect(log.body).toContain("ToUserName><![CDATA[wx-dad]]");
    expect(log.body).toContain("FromUserName><![CDATA[gh_xfeel]]");

    const rows = getDB().prepare("SELECT entities FROM memory_events WHERE user_id = ?").all(MEMORY_OWNER) as Array<{ entities: string }>;
    const entitySet = entitiesFromRows(rows);
    expect(entitySet).toContain("妈妈");
    expect(entitySet).toContain("小星");
    expect(entitySet).not.toContain("小禾");
  });

  test("auto-provisions a fresh /wechat voice user and records instead of blocking on bind", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/wechat",
      headers: { "content-type": "text/xml" },
      payload: wechatVoiceXml("记：今天阿星夜醒。", "voice-unbound-1"),
    });

    expect(res.statusCode).toBe(200);
    // 不再硬拦截，改为轻提醒
    expect(res.body).not.toContain("绑定爸爸");
    expect(res.body).toContain("我是爸爸");
    // 自动开户：建了 speaker_profile，记录归属到自动家庭而非裸 openid
    expect(getDB().prepare("SELECT COUNT(*) AS c FROM speaker_profiles WHERE external_user_id = ?").get(WEIXIN_USER) as { c: number }).toEqual({ c: 1 });
    expect(getDB().prepare("SELECT COUNT(*) AS c FROM memory_events WHERE user_id = ?").get(WEIXIN_USER) as { c: number }).toEqual({ c: 0 });
  });

  test("reuses the in-flight /wechat promise for duplicate Weixin retries", async () => {
    await onboardWeixinSpeaker();

    const content = "记：今天我老婆带阿星去公园，阿星很开心。";
    const [first, retry] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/wechat",
        headers: { "content-type": "text/xml" },
        payload: wechatXml(content, "text", "retry-msg-1"),
      }),
      app.inject({
        method: "POST",
        url: "/wechat",
        headers: { "content-type": "text/xml" },
        payload: wechatXml(content, "text", "retry-msg-2"),
      }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(first.body).toBe(retry.body);

    const eventCount = getDB().prepare("SELECT COUNT(*) AS c FROM memory_events WHERE user_id = ?").get(MEMORY_OWNER) as { c: number };
    expect(eventCount.c).toBe(1);
    const turnCount = getDB().prepare("SELECT COUNT(*) AS c FROM conversation_turns WHERE owner_id = ?").get(MEMORY_OWNER) as { c: number };
    expect(turnCount.c).toBe(2);
  });

  test("holds early WeChat retries and replies on the third retry window", async () => {
    await onboardWeixinSpeaker();

    const payload = "记：慢处理 今天我老婆带阿星去公园，阿星很开心。";
    const firstStarted = performance.now();
    const first = await app.inject({
      method: "POST",
      url: "/wechat",
      headers: { "content-type": "text/xml" },
      payload: wechatXml(payload, "text", "slow-msg-1"),
    });
    const firstElapsed = performance.now() - firstStarted;

    expect(first.statusCode).toBe(200);
    expect(firstElapsed).toBeGreaterThanOrEqual(120);
    expect(firstElapsed).toBeLessThan(300);
    expect(first.body).toBe("");

    const secondStarted = performance.now();
    const second = await app.inject({
      method: "POST",
      url: "/wechat",
      headers: { "content-type": "text/xml" },
      payload: wechatXml(payload, "text", "slow-msg-2"),
    });
    const secondElapsed = performance.now() - secondStarted;
    expect(second.statusCode).toBe(200);
    expect(secondElapsed).toBeGreaterThanOrEqual(120);
    expect(secondElapsed).toBeLessThan(300);
    expect(second.body).toBe("");

    const thirdStarted = performance.now();
    const third = await app.inject({
      method: "POST",
      url: "/wechat",
      headers: { "content-type": "text/xml" },
      payload: wechatXml(payload, "text", "slow-msg-3"),
    });
    const thirdElapsed = performance.now() - thirdStarted;
    expect(third.statusCode).toBe(200);
    expect(thirdElapsed).toBeLessThan(350);
    expect(third.body).toContain("记下来了");

    const eventCount = getDB().prepare("SELECT COUNT(*) AS c FROM memory_events WHERE user_id = ?").get(MEMORY_OWNER) as { c: number };
    expect(eventCount.c).toBe(1);
  }, 16_000);

  test("returns a slow-processing note on the third WeChat retry if the final reply is still pending", async () => {
    await onboardWeixinSpeaker();

    const payload = "记：超慢处理 今天我老婆带阿星去公园，阿星很开心。";
    const first = await app.inject({
      method: "POST",
      url: "/wechat",
      headers: { "content-type": "text/xml" },
      payload: wechatXml(payload, "text", "very-slow-msg-1"),
    });
    expect(first.statusCode).toBe(200);
    expect(first.body).toBe("");

    const second = await app.inject({
      method: "POST",
      url: "/wechat",
      headers: { "content-type": "text/xml" },
      payload: wechatXml(payload, "text", "very-slow-msg-2"),
    });
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe("");

    const thirdStarted = performance.now();
    const third = await app.inject({
      method: "POST",
      url: "/wechat",
      headers: { "content-type": "text/xml" },
      payload: wechatXml(payload, "text", "very-slow-msg-3"),
    });
    const thirdElapsed = performance.now() - thirdStarted;
    expect(third.statusCode).toBe(200);
    expect(thirdElapsed).toBeGreaterThanOrEqual(250);
    expect(thirdElapsed).toBeLessThan(450);
    expect(third.body).toContain("我收到了，只是处理得比较久");
  }, 16_000);
});
