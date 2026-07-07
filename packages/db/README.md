# db

SQLite/FTS5 数据库层。

- 默认数据库：`data/xfeel.db`
- 可通过 `XFEEL_DB_PATH=/tmp/xxx.db` 覆盖路径，用于测试和安全验证
- `memory_events.user_id` 是兼容旧命名的列，实际存储语义为 `owner_id`
- `conversation_turns` 保存当天持续对话原文
- `daily_archives` 保存日终总结归档及其关联事件
