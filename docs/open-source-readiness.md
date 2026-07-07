# 开源就绪度审计与路线图

> 2026-07-07 首次审计。目标：把 xfeel 做成可对外推广的开源产品。

## 已完成（本次落地）

- **秘密卫生审计**：`.env` 从未进入 git 历史；tracked 文件中无真实 key/token/appid。`.gitignore` 已覆盖 `.env*`、`*.db`、`data/`、媒体目录。
- **LICENSE**：MIT。
- **`.env.example`**：覆盖 LLM、embedding、存储、服务、鉴权、微信、关怀调参全部环境变量，README 快速开始已引用。
- **默认域名去私有化**：`XFEEL_WEB_URL` 不再回退到 `xfeel.today`——服务端回退 `http://localhost:PORT`，`publish-wechat-menu.ts` 未设置时直接报错（微信授权域名必须显式指定）。
- **一次性私人数据修复脚本已删除**：`fix-alias-laopozai.ts`、`fix-records-2026-06-18.ts`、`fix-records-2026-06-25.ts`（git 历史可找回）。
- **命名统一**：`package.json` 与启动日志从 `xfeel-v2` 改为 `xfeel`，补 `"license": "MIT"`。

## 待办（按优先级）

### ✅ P0：实体词表去硬编码（已完成）

规则兜底路径（分类关键词、实体归一、检索意图、关键词召回、查询扩展）原先硬编码
demo 家人名，现改为**运行时从 `family_members`/`member_aliases` 派生**：

- db 层 `getEntityLexiconForOwner(ownerId)`：按 owner 取本家庭 global 别名映射 + 孩子列表
- domain 归一只内置通用亲属称谓（父亲→爸爸 等）；无 profile 时昵称原样保留、集合称呼不臆测展开
- `expandRecallQuery(text, family?)` 接受运行时词典；`recall()` 按 owner 自动加载
- 测试用 fixture aliasContext；已用真实家庭数据验证词典派生正确

### ✅ P1：发布准备（已完成）

- **git 历史已重开**（2026-07-07）：orphan 单提交 init，旧历史（含真实家庭数据引用）
  完整备份在仓库外 `../xfeel-v3-history-backup-2026-07-07.bundle`，仓库内旧对象已 GC 清除，
  push 到任何 remote 都不会带出旧历史。**该 bundle 勿入任何公开位置。**
- 测试/注释中残留的真实家人昵称已替换为虚构 demo 名
- `docs/assets/*.png` 两张截图确认为 demo 数据；`data/eval/*.json` 此前已 sanitized
- 部署者注意：`apps/ingest-api/src/web/mp-qr.png` 是作者公众号二维码（公开物料非隐私），
  自部署时应替换为自己的

### ✅ P2：推广配套（已完成）

- **README.en.md**（英文版，与中文版互链；注明产品目前中文优先，i18n 在路线图）
- **CONTRIBUTING.md**（开发环境、结构速览、提交约定含隐私红线）
- **Dockerfile + docker-compose.yml + .dockerignore**（bun 镜像，data 卷持久化，
  可选 `--profile ollama`；YAML 语法已校验，镜像构建待有 Docker 的环境验证）
- **内置 demo 数据**：`examples/demo-diaries/demo.json` 20 篇合成家庭日记，
  `bun run import:quick` 秒级导入（已端到端验证）；import 默认路径不再指向仓库外私人目录
- **docs/wechat-channel.md**：公众号从零接入全流程（服务器配置、用户旅程、
  OAuth 菜单、二维码替换、5 秒超时与异步回复）

## 发布前最后一手（可选增强）

- GitHub 仓库配置：About 简介、topics、issue 模板、社交预览图
- 在有 Docker 的环境跑一次 `docker compose up` 全流程
- 首个 release tag（如 v0.1.0）+ 变更说明
