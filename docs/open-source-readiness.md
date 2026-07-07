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

### P0：实体词表去硬编码（通用性核心坎）

家人昵称「星星/禾禾」及其别名表硬编码在六处核心逻辑中：

| 文件 | 内容 |
|---|---|
| `packages/domain/src/normalization.ts` | `KNOWN_ENTITY_LABELS`、别名→规范名映射、"宝宝们"展开 |
| `packages/extractors/src/classify.ts` | 分类规则兜底的实体关键词 |
| `packages/extractors/src/extract.ts` | 抽取提示词里的已知实体列表 |
| `packages/conversation/src/recall-intent.ts` | 规则兜底 surface→实体映射 |
| `packages/conversation/src/conversation.ts` | 召回别名扩展 |
| `packages/retrieval/src/query-expansion.ts` | 查询扩展别名组 |

**改法**：数据库已有 `family_members` + `member_aliases` 表和 `getAliasContextForSpeaker()`（LLM 抽取已在用）。把上述规则兜底和提示词的实体词表改为**运行时从家庭别名表派生**，只保留通用角色词（妈妈/爸爸/外婆/宝宝…）为内置。测试改用虚构 fixture 家庭。demo/文档中的「星星/禾禾」作为示例数据保留无妨。

### P1：发布准备

- **git 历史决策**：现无 remote。历史含真实家庭对话片段引用（修复脚本、commit 信息）。建议**首发时 squash 或以孤儿分支重开历史**，老历史留在私有备份。→ 需要 owner 决定
- `docs/` 里的 PRD/架构文档含真实使用数据截图与片段，发布前过一遍（`docs/assets/*.png` 两张截图确认无隐私）。
- `data/eval/*.json` 两个 eval 集含真实日记查询语句，发布前替换为合成数据或移除。

### P2：推广配套

- 英文 README（或双语），CONTRIBUTING.md，issue 模板
- 一键部署路径：Dockerfile / docker-compose（bun + Ollama 可选）
- Demo 模式：内置合成家庭数据 + `XFEEL_AUTH_DISABLED` 的演示指引
- 微信通道文档独立成篇（申请公众号、配域名、菜单发布全流程）
