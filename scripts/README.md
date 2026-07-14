# scripts

仓库内的手工导入、对比和验证脚本。

- `import-diaries.ts`：导入已有日记，支持 `--skip-llm`、`--dry-run`
- `inspect-today.ts`：只读输出当天日志、归档、抽取事件字段、open facts 和管线状态
- `purge-message.ts`：干净删除一条错误记录，连带清掉它散落在所有表的痕迹
- `test-e2e.ts`、`test-llm.ts`：开发期手工验证脚本
- `eval-wisdom.ts`：智慧干预 A/B 评测（关/开各跑一遍真实回复路径，LLM 盲评 + 确定性闸门指标）
  - `bun run scripts/eval-wisdom.ts`，用例见 `data/eval/wisdom-cases.json`（全合成，无真实家庭数据）
  - 跑在临时库上，不碰生产库；报告可用 `--out=<path>` 落盘
- 需要隔离数据库时可设置 `XFEEL_DB_PATH`

## 删除错误记录

一条「记录」会散落在 7 处：`memory_events`（+ FTS 触发器）、`entity_events`、
`memory_open_facts`、`causal_chains`、向量库 `memory_embeddings`、`pipeline_status`、
`conversation_turns`（日记 turn + 紧随的助手回复气泡）。直接删主表会留孤儿，
用 `purge-message.ts` 以 pipeline message_id 为单位一次清干净（底层函数
`packages/db/src/purge.ts` 的 `purgeMessage` / `planPurge` 可在代码里复用）。

```bash
# message_id 来源：面板卡片上的 “msg xxxxxxxx” 短码、memory_events.raw_message_id，
# 或 conversation_turns.metadata.pipeline_message_id

DRY_RUN=1 bun run scripts/purge-message.ts <msgId> [msgId...]   # 先预览将删什么（支持短码前缀）
bun run scripts/purge-message.ts <msgId> [msgId...]             # 确认后执行
OWNER=<ownerId> bun run scripts/purge-message.ts <msgId>        # 可选：限定 owner
```

> 删除不可逆，执行前务必先跑一遍 `DRY_RUN=1` 核对计划。
