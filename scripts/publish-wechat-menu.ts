type WechatTokenResponse = {
  access_token?: string;
  expires_in?: number;
  errcode?: number;
  errmsg?: string;
};

type WechatApiResponse = {
  errcode?: number;
  errmsg?: string;
};

function env(name: string): string {
  return process.env[name]?.trim() || "";
}

function webBase(): string {
  const base = env("XFEEL_WEB_URL");
  if (!base) {
    throw new Error("missing XFEEL_WEB_URL（发布菜单前必须指定部署域名，微信内只能打开备案过的授权域名）");
  }
  return base.replace(/\/+$/, "");
}

function menuUrl(): string {
  const explicit = env("XFEEL_WECHAT_MENU_URL");
  if (explicit) return explicit;
  const url = new URL(`${webBase()}/wechat/oauth/start`);
  url.searchParams.set("next", "/app");
  return url.toString();
}

async function getAccessToken(): Promise<string> {
  const appId = env("WECHAT_APP_ID") || env("WEIXIN_APP_ID");
  const secret = env("WECHAT_APP_SECRET") || env("WEIXIN_APP_SECRET");
  if (!appId || !secret) {
    throw new Error("missing WECHAT_APP_ID/WECHAT_APP_SECRET");
  }

  const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
  url.searchParams.set("grant_type", "client_credential");
  url.searchParams.set("appid", appId);
  url.searchParams.set("secret", secret);

  const res = await fetch(url);
  const body = await res.json().catch(() => ({})) as WechatTokenResponse;
  if (!res.ok || !body.access_token) {
    throw new Error(`failed to get access_token: ${body.errmsg || body.errcode || res.status}`);
  }
  return body.access_token;
}

async function publishMenu(accessToken: string) {
  const body = {
    button: [
      {
        type: "view",
        name: env("XFEEL_WECHAT_MENU_NAME") || "家的记忆",
        url: menuUrl(),
      },
    ],
  };

  const url = new URL("https://api.weixin.qq.com/cgi-bin/menu/create");
  url.searchParams.set("access_token", accessToken);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await res.json().catch(() => ({})) as WechatApiResponse;
  if (!res.ok || (result.errcode ?? 0) !== 0) {
    throw new Error(`failed to publish menu: ${result.errmsg || result.errcode || res.status}`);
  }
  return { body, result };
}

async function main() {
  const accessToken = await getAccessToken();
  const { body, result } = await publishMenu(accessToken);
  console.log(JSON.stringify({
    ok: true,
    menu_url: body.button[0].url,
    menu_name: body.button[0].name,
    wechat: result,
  }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
