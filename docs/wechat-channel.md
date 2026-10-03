# 微信公众号通道部署指南

xfeel 的微信通道让家人直接在公众号对话里记录和回忆。本文覆盖从零接入的全流程。
不接微信也可以只用网页端（`/app`）和 HTTP API。

## 前置条件

- 一个微信公众号（订阅号即可收发消息；**服务号**才有客服接口，可发「异步处理完成」的推送）
- 一台有公网 HTTPS 域名的服务器（微信要求 80/443 端口、备案域名）
- xfeel 已部署并可通过该域名访问（反代到 `PORT`，默认 8000）

## 1. 配置服务器对接

微信公众平台 → 设置与开发 → 基本配置：

| 配置项 | 填写 |
|---|---|
| 服务器地址 URL | `https://your-domain.example/wechat` |
| Token | 与环境变量 `WECHAT_TOKEN` 一致（必须使用随机串） |
| 消息加解密方式 | 明文模式 |

环境变量（参见 `.env.example`）：

```bash
WECHAT_APP_ID=wx开头的AppID
WECHAT_APP_SECRET=公众号密钥
WECHAT_TOKEN=与平台配置一致
XFEEL_WEB_URL=https://your-domain.example   # OAuth 回跳与帮助文案里的网页入口
XFEEL_JWT_SECRET=一串长随机字符串             # 网页登录态签名
```

`WECHAT_TOKEN` 为必填密钥，未设置时 `/wechat` 会拒绝所有回调。GET 服务器验证和
POST 消息回调都会验证微信 SHA-1 签名，并默认只接受与服务器时间相差 5 分钟内的请求。
不要把真实 Token 提交到 Git；更换 Token 时要同步更新公众平台后台和服务运行环境。

## 2. 用户旅程（开箱即用，无需额外配置）

- **首条消息自动开户**：新 openid 发来第一条消息时自动建家庭并绑定占位身份
- **确认身份**：回复「我是爸爸」「我是妈妈」
- **添加孩子**：回复「孩子叫××」，之后消息里的昵称会自动归一到这个孩子
- **邀请家人**：回复「邀请」获取邀请码，家人回复「加入 邀请码」进入同一家庭
- **记录**：直接说事（文字或图片），系统自动分类、抽取、入库
- **回忆**：直接问「上周孩子看医生了吗」「这个月我经历了什么」
- **帮助**：回复「帮助」随时查看指令说明

## 3. 网页授权与自定义菜单（可选）

让用户从公众号菜单一键进入网页版（免登录）：

1. 公众号后台配置**网页授权域名**为你的部署域名
2. 发布菜单：

```bash
XFEEL_WEB_URL=https://your-domain.example bun run wechat:menu

# 可选覆盖菜单名与链接
XFEEL_WECHAT_MENU_NAME=家的记忆 \
XFEEL_WECHAT_MENU_URL='https://your-domain.example/wechat/oauth/start?next=/app' \
bun run wechat:menu
```

菜单 URL 指向 `/wechat/oauth/start?next=/app`：微信内点击后走 `snsapi_base` 静默授权
拿 openid，复用 Web JWT 签发登录态，跳回 `/app`。

邀请链接同理：`https://your-domain.example/wechat/oauth/start?next=/app&invite=邀请码`
对用户来说「点链接 = 加入家庭并登录」。

## 4. 替换登录页二维码

网页登录页会展示公众号二维码引导关注：把
`apps/ingest-api/src/web/mp-qr.png` 替换为你自己公众号的二维码图片。

## 5. 超时与异步回复

微信要求 5 秒内回包。xfeel 默认在窗口内直接回复；图片转写等慢操作会先回
「收到正在处理」，处理完再通过客服接口推送结果（需要服务号）。相关调参见
`.env.example` 的 `WECHAT_*` 项。

订阅号没有客服接口，重试窗口耗尽时只能回一句「我收到了，只是处理得比较久」。
这句兜底回复后面会附一条**免登录直达链接**（仅在配置了 `XFEEL_WEB_URL` 时出现）：

```
我收到了，只是处理得比较久。
处理好就会出现在网页版，点这里直接看（无需登录）：
https://your-domain.example/app?k=al_xxxxxxxx&from=wechat
```

- `k=` 是一张一次性直达票据。公众号侧此刻已确知说话人 openid，所以直接签票，
  用户点开网页即 `POST /web/login/exchange` 换成正式会话 token，省掉「网页取暗号 → 回微信回暗号」的往返。
- 票据是 144 bit 随机串（不可枚举）、一次性、默认 30 分钟过期（`XFEEL_AUTOLOGIN_TTL_MS` 可调）；
  过期或已用则静默降级到普通暗号登录门。
- `from=wechat` 让 `/app` 知道回复可能还在算：落到当天信息流底部后挂一个「正在输入」，
  轮询到回复落库即自动刷新（最多等 2 分钟）。
