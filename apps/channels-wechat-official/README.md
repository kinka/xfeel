# channels-wechat-official

职责：

- 微信签名验证
- XML 请求解析与响应
- 把公众号消息转换为统一 ingest payload

约束：

- 必须独立于核心记忆状态
- 超时处理只做到平台兼容，不在这里保存系统主状态
