# ingest-api

职责：

- 暴露统一写入口
- 接收文本消息、owner 信息和对话上下文
- 调用 classify / extract / recall
- 写入 SQLite 记忆库
- 暴露统计、图谱、归档相关查询
- 为当天持续对话提供记忆召回

当前接口：

- `POST /ingest`
- `POST /ingest/batch`
- `POST /recall`
- `POST /conversation/chat`
- `GET /conversation/turns`
- `GET /conversation/playground`
- `POST /archive/daily/run`
- `GET /archive/daily`
- `GET /graph`
- `GET /analytics/*`
- `GET /dashboard`
- `GET /health`

第一阶段可以同步处理文本日志。多模态、长耗时归档或批量重算再拆到 worker。
