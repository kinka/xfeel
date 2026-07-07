# 知识图谱（因果图 / 实体图）下线提案

状态：阶段 1–3 已落地（2026-06-22），阶段 4（DROP TABLE）**延后执行**。

## 背景与结论

项目早期从一个通用 "diary-knowledge-graph" 模板引入了显式知识图谱：
`entities` + `entity_events`（实体-事件二部图）、`causal_chains`（事件因果边，离线启发式发现）。

复盘结论：**这套图谱是错误的抽象**，对本产品（家庭记忆/共情助手）价值为负。

证据（2026-06-22，主库 `data/xfeel.db`）：

| 表 | 行数 | 判定 |
|---|---|---|
| `memory_events` | 6436 | 核心，保留 |
| `memory_open_facts` | 462 | **真在用**（回复链路 + profile 归纳），保留 |
| `entities` | 16 | 含「我/宝宝们/未知」等脏数据，仅分析读 |
| `entity_events` | 10532 | 写放大（比事件还多），线上从不读 |
| `causal_chains` | 2 | 整套 5 维打分引擎一共产出 2 条边，停在 2026-05-05 |

关键问题：
1. **因果图从不反哺对话**：`causal_chains` 只喂可视化看板，微信回复链路零引用。
2. **因果发现精度差且原则错位**：`causal.ts` 的 5 信号打分里，唯一表达因果的「关键词」信号非必需——「同一个人 + 同主题 + 时间近」即可成边，把相关/巧合当因果。
3. **稀疏个人日志撑不起因果归纳**：一个多月只发现 2 条边即是明证。
4. **实体双轨割裂**：`entities`（自由字符串）与 `family_members`（canonical 身份）无外键关联；检索宁可用 `entities LIKE` 子串扫描也不 join `entity_events`。

正确架构：本产品核心是 **召回 + reply LLM 即时推理 + 少量结构化聚合（open_facts）**。
因果/关联推理应在回复时由 LLM 在召回上下文上即时完成，而非离线预算一张低精度全局图。

## 阶段 1–3：已落地（本次改动，全部可逆）

- **停写**（`packages/pipeline/src/pipeline.ts`）：删除 entities/entity_events 写入循环及相关 prepared 语句。
  保留 stale 清理 DELETE——旧 `entity_events` 行随消息重处理逐步清空。
- **删因果引擎**：删除 `packages/analyzer/src/causal.ts`、`analyzer/src/index.ts` 的导出、
  `temporal.ts:getAnalyticsSummary` 的 `causal_chains` 计数、`dedup.ts` 合并时的 entity_events/causal_chains 迁移。
- **删因果 API**（`apps/ingest-api/src/server.ts`）：移除 `/analytics/causal/{discover,graph,stats}` 路由、
  导入、启动日志；同步更新 `DASHBOARD_HTML`（移除因果 fetch / 因果链按钮 / 因果链指标），避免看板 `Promise.all` 因 404 整体失败。

验证：`bun test packages/pipeline packages/analyzer apps/ingest-api packages/db packages/conversation packages/retrieval` 全绿（122 pass / 0 fail）。
tsc 残留报错均为预存在（基线一致），与本次无关——仓库以 `bun test` 为门禁。

## 阶段 4：DROP TABLE（延后，建议先观察 1–2 周）

确认线上稳定、`entity_events` 已随重处理收敛后，再执行不可逆删除。届时需一并处理：

- `DROP TABLE causal_chains; DROP TABLE entity_events; DROP TABLE entities;`（含 `schema.ts` 建表语句）
- 移除 `pipeline.ts` / `memory-events.ts` 中对这三张表的 DELETE 清理语句
- 移除 `analyzer/temporal.ts` 仍依赖 `entities` 的 `comparePersons` / `getEntityTimeline`（及对应 `/analytics/{compare,entity}` 路由、看板 owners/实体图谱面板），或改为基于 `memory_events.entities` JSON 重写
- 移除 `apps/ingest-api/src/server.ts` 的 `/graph`（`getEntityGraph`，依赖 `entity_events`）或改写
- 清理 `pipeline.test.ts` / `schema.test.ts` 中针对 causal_chains 的用例
- `scripts/eval-recall-hard.ts` 的 `DELETE FROM causal_chains/entity_events`

备份：删表前 `cp data/xfeel.db data/backups/xfeel.db.before-kg-drop-<date>.db`。
