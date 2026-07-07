# xfeel 家庭记忆助手

[English](README.en.md)

xfeel 是一个面向家庭的长期记忆系统：家人可以像聊天一样记录孩子成长、日常照护、情绪变化和重要片段，系统会把零散消息沉淀成可检索、可回顾、可继续对话的结构化记忆。

它既是一个移动端优先的家庭日记入口，也是一个可自托管的记忆管线。适合用来做家庭成长档案、育儿协作记录、情绪回顾、微信消息归档和个人/家庭 AI 记忆底座。

## 产品亮点

- **随手记录**：通过网页、API 或微信公众号写入文字和图片，不要求用户整理格式。
- **自动沉淀**：识别成长里程碑、睡眠、喂养、健康、情绪和家庭成员关系，生成长期记忆事件。
- **带记忆的对话**：继续聊天时自动召回相关片段，让回复能接住上下文和过去经历。
- **日终归档**：把一天的连续对话总结为家庭日记，并回写到结构化事件库。
- **情绪与成长回顾**：按时间、人物、标签、情绪查看趋势，支持家庭成员视角对比。
- **本地优先**：SQLite + FTS5 即可运行，LLM 不可用时有规则兜底，适合自托管和私有化部署。

## 界面截图

### 家庭记忆用户端

移动端优先的信息流，展示当天对话、记忆回执、相关记忆召回和日终小结。

![家庭记忆用户端](docs/assets/app-mobile.png)

### 数据仪表盘

管理员视角查看全局事件、日记、情绪热力图、趋势和家庭成员数据。

![xfeel 数据仪表盘](docs/assets/dashboard-overview.png)

## 适合场景

- 给孩子建立持续成长档案：第一次站立、走路、说话、疫苗、睡眠变化等。
- 家庭成员协作记录照护细节：爸爸、妈妈、老人都能按各自视角补充。
- 回看情绪与生活阶段：从零散日记里看到压力、开心、疲惫和转折点。
- 搭建私有 AI 记忆底座：把微信、网页、脚本导入的数据统一进结构化记忆库。

## 架构

xfeel 的核心是“当天对话 -> 结构化抽取 -> 可检索记忆 -> 日终归档”的闭环。

```
用户消息 (微信/CLI/API)
  ↓
┌──────────────────────────────────┐
│  Memory Pipeline                  │
│                                    │
│  1. classify  → 消息分类           │
│     ├─ diary    (有记录价值)       │
│     ├─ command  (系统指令)         │
│     ├─ chat     (普通聊天)         │
│     └─ noise    (无意义消息)       │
│                                    │
│  2. extract   → 结构化抽取         │
│     ├─ event_type (sleep/feeding..)│
│     ├─ entities   (星星/妈妈..)    │
│     ├─ emotion    (崩溃/开心..)    │
│     ├─ tags       (夜醒/疫苗..)    │
│     └─ summary   (一句话摘要)      │
│                                    │
│  3. store     → 入库               │
│     ├─ memory_events (结构化事件)  │
│     ├─ entities      (人物实体)    │
│     └─ diaries       (原始日记)    │
│                                    │
│  4. recall    → 检索/对话响应       │
│     ├─ 结构化过滤 (实体/类型/情绪) │
│     ├─ 全文搜索   (FTS5)           │
│     └─ 组合查询                     │
│                                    │
│  5. daily archive → 当天总结归档    │
│     ├─ 汇总当天对话                 │
│     ├─ 归并情绪日志/成长记录        │
│     └─ 更新图谱/趋势/因果线索       │
└──────────────────────────────────┘
```

## 项目流程文档

- [docs/architecture-2026-06.md](docs/architecture-2026-06.md)：**最新**架构与数据流图（角色分模型、意图路由、检索意图识别、带工具的共情回复、BLOB embedding、可观测性）。
- [docs/project-flow.md](docs/project-flow.md)：面向项目 owner 的中文流程说明，覆盖模块职责、端到端数据流、核心表、关键 API、后台任务和排障入口。
- [docs/architecture.md](docs/architecture.md)：摄取/存储/eval 底盘说明（与最新对话/召回链路以 2026-06 篇为准）。

## 目录结构

```
xfeel-v3/
├── packages/
│   ├── domain/          # 类型定义 (Zod schemas)
│   ├── db/              # SQLite + FTS5 数据库层
│   ├── ai-client/       # LLM 调用封装 (Ollama/OpenAI)
│   ├── extractors/      # classify + extract
│   ├── pipeline/        # 管线编排
│   ├── conversation/    # 当天持续对话记录与记忆召回
│   ├── archive/         # 日终总结归档
│   ├── retrieval/       # 检索 API
│   └── analyzer/        # 去重、因果、时间分析
├── apps/
│   └── ingest-api/      # Fastify HTTP 服务
├── scripts/
│   ├── import-diaries.ts # 批量导入日记
│   ├── daily-archive.ts # 日终归档脚本
│   ├── test-e2e.ts      # 手工验证脚本
│   └── test-llm.ts      # LLM 抽取测试
├── data/
│   └── xfeel.db         # SQLite 数据库
└── .env                 # LLM 配置
```

## 快速开始

```bash
# 1. 安装依赖
bun install

# 2. 准备配置（默认走本地 Ollama，可改为任意 OpenAI-compatible 服务）
cp .env.example .env

# 3. 初始化数据库
bun run db:init

# 4. 启动 API 服务
bun run api

# 5. 测试摄取
curl -X POST http://localhost:3100/ingest \
  -H "Content-Type: application/json" \
  -d '{"text":"星星今天第一次站起来了！好开心","owner_id":"demo-mom-owner"}'

# 6. 检索记忆
curl -X POST http://localhost:3100/recall \
  -H "Content-Type: application/json" \
  -d '{"entities":["星星"]}'

# 7. 查看统计
curl http://localhost:3100/stats
```

启动后打开 `http://localhost:3100/app`（家人用移动端页面）或 `/dashboard`（管理台）。

想先看效果，可导入内置的合成 demo 日记：

```bash
bun run import:quick   # 20 篇虚构家庭日记，规则模式秒级完成
```

### Docker 部署

```bash
cp .env.example .env
docker compose up -d
# 或连容器化 Ollama 一起跑：
docker compose --profile ollama up -d
```

## LLM 配置

完整变量清单见 [.env.example](.env.example)。核心配置：

```bash
# Ollama 本地（默认，需要先启动 Ollama）
LLM_BASE_URL=http://localhost:11434
LLM_MODEL=gemma3:12b

# OpenAI-compatible 远程服务（备选）
LLM_BASE_URL=https://api.example.com/v1
LLM_MODEL=claude-sonnet-4-6
LLM_API_KEY=your_key_here
```

**降级策略**：LLM 不可用时自动切换到规则模式（关键词匹配 + 启发式），保证管线不中断。

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/ingest` | 摄取消息（完整管线） |
| POST | `/recall` | 检索记忆 |
| POST | `/conversation/turn` | 记录一条当天对话 |
| POST | `/conversation/chat` | 对话、召回记忆并生成回复 |
| GET | `/conversation/turns` | 查询当天对话 |
| GET | `/conversation/playground` | 对话闭环测试界面 |
| POST | `/archive/daily/run` | 日终总结归档并更新事件 |
| GET | `/archive/daily` | 查询日终归档 |
| GET | `/stats` | 统计信息 |
| GET | `/events` | 事件列表 |
| GET | `/events/:id` | 单个事件 |
| GET | `/entities` | 实体列表 |
| GET | `/diaries` | 日记列表 |
| GET | `/health` | 健康检查 |

### RecallQuery 参数

```json
{
  "text": "全文搜索词",
  "entities": ["星星", "妈妈"],
  "event_types": ["sleep", "feeding"],
  "emotions": ["崩溃", "焦虑"],
  "tags": ["夜醒", "疫苗"],
  "date_from": "2025-01-01",
  "date_to": "2025-12-31",
  "owner_id": "demo-mom-owner",
  "limit": 20,
  "order": "newest"  // newest | oldest | emotion_intensity
}
```

说明：
- `memory_events.user_id` 仍是数据库列名，但语义统一为 `owner_id`（日记/消息归属人）
- 已知 owner 映射：`demo-dad-owner=爸爸`，`demo-mom-owner=妈妈`
- 抽取时会把 `owner/speaker` 显式传给模型，帮助消解“我/自己”

## 批量导入

```bash
# 导入内置 demo 日记（examples/demo-diaries，默认）
bun run import

# 指定目录
bun run scripts/import-diaries.ts /path/to/diaries

# 仅规则模式（不调 LLM，快速）
bun run import:quick

# 试运行（只分类不入库）
bun run scripts/import-diaries.ts --dry-run

# 导入/验证时隔离数据库，避免写入现有 data/xfeel.db
XFEEL_DB_PATH=/tmp/xfeel-verify.db bun run scripts/import-diaries.ts --skip-llm /path/to/diaries
```

## 当天对话与日终归档

```bash
# 记录并响应一条对话
curl -X POST http://localhost:3100/conversation/chat \
  -H "Content-Type: application/json" \
  -d '{"text":"今天星星自己走了三步，我特别开心","owner_id":"demo-mom-owner"}'

# 对某一天做日终归档
curl -X POST http://localhost:3100/archive/daily/run \
  -H "Content-Type: application/json" \
  -d '{"date":"2026-05-12","owner_id":"demo-mom-owner"}'

# 或直接用脚本跑
bun run archive:daily --date=2026-05-12 --owner=demo-mom-owner

# 自动化 UI 闭环测试（启动隔离数据库和本地服务，用 Chrome 操作页面）
bun run test:ui
```

## 微信公众号通道

从零接入公众号（服务器配置、用户旅程、菜单与授权、二维码替换）见完整指南：[docs/wechat-channel.md](docs/wechat-channel.md)。

### 菜单与自动登录

网页入口可以挂到公众号自定义菜单。推荐菜单 URL 指向微信网页授权入口，而不是直接指向 `/app`：

```text
https://xfeel.today/wechat/oauth/start?next=/app
```

用户从微信内点击菜单后，服务端会通过 `snsapi_base` 静默授权拿到当前微信 `openid`，复用现有 Web JWT/session 机制签发登录态，再跳回 `/app?token=...`。前端会自动把 token 写入本地存储；如果用户还没有家庭，系统会沿用现有自动开户流程。

邀请码链接兼具登录能力：用户打开 `https://xfeel.today/wechat/oauth/start?next=/app&invite=邀请码` 时，会先用微信 OAuth 确认当前 `openid`，再用邀请码加入对应家庭并签发网页登录态。也就是说，对用户来说“点邀请码链接”就是“加入家庭并登录”。

发布菜单前需要在微信公众平台配置网页授权域名为 `xfeel.today`，并确保生产环境有：

```bash
WECHAT_APP_ID=...
WECHAT_APP_SECRET=...
XFEEL_WEB_URL=https://xfeel.today
XFEEL_JWT_SECRET=... # 多实例部署时必须固定
```

发布菜单：

```bash
bun run wechat:menu
```

可选覆盖：

```bash
XFEEL_WECHAT_MENU_NAME=家的记忆 \
XFEEL_WECHAT_MENU_URL='https://xfeel.today/wechat/oauth/start?next=/app' \
bun run wechat:menu
```

## 设计决策

- **不用向量库**：数据量 <10K，结构化查询 + FTS5 足够，避免引入独立向量数据库增加复杂度
- **LLM 降级**：classify 和 extract 都有规则兜底，确保管线不因 LLM 不可用而中断
- **SQLite + FTS5**：零部署成本，单文件数据库，WAL 模式支持并发读
- **每条消息 → 多个事件**：一条消息可能包含多个独立事件（如"星星夜醒+爸爸睡得好"）
- **实体标准化**：统一名称（星星/禾禾/妈妈/爸爸/外婆/宝宝们），自动追踪提及次数
- **当天对话 → 日终归档 → 更新图谱**：新版不再只是离线分析旧日记，而是在用户当天持续对话后生成总结、沉淀事件并更新知识图谱
- **多模态后置**：语音 ASR、图片理解、视频切段后续接入，产物仍然回到文本事件、日记和图谱

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。Issue / PR / 文档改进都欢迎。

## License

[MIT](LICENSE)
