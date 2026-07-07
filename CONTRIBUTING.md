# 参与贡献 / Contributing

感谢你对 xfeel 的兴趣！Issue、PR、文档改进、使用反馈都欢迎。

English speakers: issues and PRs in English are welcome — code comments and docs are
currently Chinese-first, but we're happy to discuss in either language.

## 开发环境

- [Bun](https://bun.sh) ≥ 1.1（运行时 + 包管理 + 测试）
- SQLite（Bun 内置 `bun:sqlite`，无需单独安装）
- 可选：[Ollama](https://ollama.com)（本地 LLM 与 embedding；没有也能跑，规则兜底）

```bash
bun install
cp .env.example .env
bun run db:init
bun test            # 全部单测（不依赖外部 LLM，网络隔离可跑）
bun run api         # 启动 API + 网页端
```

## 代码结构速览

- `packages/domain` —— 纯类型与归一化逻辑（Zod schema、词表），不依赖 db/LLM
- `packages/db` —— SQLite 存取层（含家庭/别名/鉴权）
- `packages/extractors` / `packages/pipeline` —— 消息分类、结构化抽取、入库管线
- `packages/retrieval` / `packages/conversation` —— 召回、对话与记忆工具
- `apps/ingest-api` —— Fastify 服务 + 网页端（/app 用户页、/dashboard 管理台）
- 详细数据流见 `docs/architecture-2026-06.md` 与 `docs/project-flow.md`

## 提交约定

1. **测试**：改动产品逻辑请附带/更新对应 `*.test.ts`；`bun test` 必须全绿。
2. **LLM 双路径**：管线各环节都有「LLM + 规则兜底」两条路径，改动时两条都要照顾到。
3. **不要硬编码具体家庭**：家人名/昵称一律走 `family_members`/`member_aliases`
   运行时词典（见 `getEntityLexiconForOwner`）；测试用虚构 fixture 家庭（星星/禾禾）。
4. **隐私红线**：不要在代码、测试、文档、commit message 中出现任何真实个人数据。
5. **秘密卫生**：密钥只进 `.env`（已 gitignore），新增环境变量同步补到 `.env.example`。

## 提 Issue

- Bug：附复现步骤、期望/实际行为、`bun --version` 与操作系统
- 功能建议：说明使用场景，家庭记忆产品优先考虑「普通家人用得顺手」而非功能堆叠
