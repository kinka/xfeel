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
| 服务器地址 URL | `https://your-domain.example/weixin/message` |
| Token | 与环境变量 `WECHAT_TOKEN` 一致（默认 `xfeel`，建议改随机串） |
| 消息加解密方式 | 明文模式 |

环境变量（参见 `.env.example`）：

```bash
WECHAT_APP_ID=wx开头的AppID
WECHAT_APP_SECRET=公众号密钥
WECHAT_TOKEN=与平台配置一致
XFEEL_WEB_URL=https://your-domain.example   # OAuth 回跳与帮助文案里的网页入口
XFEEL_JWT_SECRET=一串长随机字符串             # 网页登录态签名
```

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
