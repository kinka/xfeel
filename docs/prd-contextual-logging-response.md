# xfeel-v2「记录即对话：日志后自动 recall 并回应」PRD

> **For Codex:** Implement this PRD with strict TDD where practical. Do not commit. Do not print secrets. Preserve owner semantics.

## 1. 背景与目标

xfeel-v2 已经具备统一 HTTP API、SQLite 结构化入库、`memory_events`、`conversation_turns`、`recall`、`events-query`、dashboard、analytics 等基础能力。现在要把它从“日志入库系统”升级为“会记得上下文的家庭记忆伙伴”。

核心体验：用户输入一条家庭/孩子成长日志后，系统不仅保存日志，还会自动根据日志内容 recall 相关历史记忆，并给出简短、温暖、具体、有引用依据的回应。

示例：

用户：
> 今天星星又夜醒了三次，我真的有点崩溃。

系统：
> 记下来了。最近关于星星睡眠的记录确实比较密集：上周也有几次夜醒相关片段。你这条我会和最近睡眠记录一起放进本周回顾里。今晚先别急着复盘，你已经很累了。

## 2. 用户价值

1. **输入有即时反馈**：不再只是“已保存”，用户会感到系统真的记得过去。
2. **自动 recall，而非等待用户提问**：日志本身触发相关记忆回流。
3. **构建连续叙事**：把碎片化日记变成“这件事最近出现了几次/和哪些历史片段相关”。
4. **保留双 owner 语义**：爸爸 `demo-dad-owner`、妈妈 `demo-mom-owner` 的视角必须区分，不能把“我”混在一起。
5. **为每周家庭信和记忆问答打基础**：本功能是最高频触点。

## 3. 范围

### 3.1 本期必须完成

实现一个可用闭环：

```text
POST /conversation/log
  -> record user turn
  -> processMessage 抽取并存储 memory_events
  -> 根据当前日志和抽取事件自动 recall 相关历史
  -> 生成简短回应
  -> record assistant turn
  -> 返回 structured result
```

### 3.2 本期接口

新增或等价实现：

`POST /conversation/log`

请求：

```json
{
  "text": "今天星星又夜醒了三次，我真的有点崩溃。",
  "owner_id": "demo-mom-owner",
  "date": "2026-06-12",
  "force": true,
  "limit": 6
}
```

响应：

```json
{
  "mode": "log_with_contextual_reply",
  "pipeline": {
    "message_id": "...",
    "stored": 1,
    "events": []
  },
  "user_turn": {},
  "assistant_turn": {},
  "reply": "记下来了...",
  "context": {
    "current_event_summaries": ["..."],
    "recalled": [
      { "id": "...", "summary": "...", "event_time": "...", "event_type": "sleep", "emotion": "疲惫" }
    ],
    "signals": {
      "has_related_history": true,
      "has_negative_emotion": true,
      "owner_id": "demo-mom-owner"
    }
  }
}
```

### 3.3 兼容已有接口

- 保留 `/conversation/chat`：主动问答/普通聊天用。
- 保留 `/ingest`：只入库、不回应用。
- 新接口 `/conversation/log`：记录日志 + 自动 recall + 回应。

## 4. 产品行为规则

### 4.1 自动 recall 策略

根据当前日志抽取出的事件，组合 4 类 recall：

1. **同类事件**：当前 event_type，例如 `sleep` / `health` / `feeding` / `milestone`。
2. **同实体事件**：当前 entities，例如 `星星`、`禾禾`、`妈妈`。
3. **同情绪/负向情绪趋势**：当前 emotion primary 或 valence，尤其 negative。
4. **全文相似**：用当前 text 调用现有 `recall({ text })`。

MVP 不需要高级向量检索，先用现有 SQLite LIKE / JSON 字段筛选即可。

### 4.2 回应长度与语气

- 默认 1-4 句，微信可读。
- 不要长篇分析。
- 不要医疗诊断。
- 不要编造事实。
- 如果 recall 很弱，不要硬解释：
  - “记下来了。我暂时没有找到特别接近的历史片段，但会把这条放进今天的成长/情绪记录里。”
- 如果发现负向情绪：
  - 语气优先共情，不要教育。
- 如果涉及爸爸/妈妈对比：
  - 不要指责，避免“爸爸没记录/妈妈记录更多所以...”这种表达。

### 4.3 LLM fallback

- LLM 失败时必须返回 deterministic reply，不让接口失败。
- deterministic reply 应包含：已记录 + 如果有 recall，提及最相关的一条。

## 5. AI API 配置要求

用户要求涉及 AI API 的配置从 `~/.codex` 提取。

OpenAI-compatible 远程服务可按如下方式配置：

- `~/.codex/config.toml`
  - `model_provider = "openai_compatible"`
  - `model = "<model-name>"`
  - `[model_providers.custom]`
  - `base_url = "https://api.example.com/v1"`
  - `requires_openai_auth = true`
- `~/.codex/auth.json`
  - 包含 `OPENAI_API_KEY` 字段
  - 不得打印或写入日志

实现要求：

1. `packages/ai-client/src/llm.ts` 增加安全读取 Codex config 的 fallback：
   - 如果环境变量 `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` 已设置，优先用环境变量。
   - 如果未设置，再读取 `~/.codex/config.toml` 和 `~/.codex/auth.json`。
   - 只读取需要字段，不输出 key。
2. 支持 OpenAI-compatible chat completions。
3. `~/.codex` 读取失败时回退当前默认 Ollama 配置，不抛致命错误。
4. 不引入大依赖；TOML 可用简单解析，只支持本文件所需字段。

## 6. 技术设计

### 6.1 建议新增文件

- `packages/conversation/src/contextual-response.ts`
- `packages/conversation/src/contextual-response.test.ts`

### 6.2 建议修改文件

- `packages/conversation/src/conversation.ts`
- `packages/conversation/src/index.ts`
- `apps/ingest-api/src/server.ts`
- `packages/ai-client/src/llm.ts`
- 可选：`packages/ai-client/src/llm.test.ts`
- 可选：`apps/ingest-api/README.md`

### 6.3 核心 API

```ts
export interface LogWithContextInput {
  text: string;
  owner_id?: string;
  user_id?: string;
  date?: string;
  force?: boolean;
  limit?: number;
}

export interface ContextualLogResult {
  mode: "log_with_contextual_reply";
  pipeline: PipelineResult;
  user_turn: ConversationTurn;
  assistant_turn: ConversationTurn;
  reply: string;
  context: {
    current_event_summaries: string[];
    recalled: RecalledMemory[];
    signals: {
      has_related_history: boolean;
      has_negative_emotion: boolean;
      owner_id?: string;
    };
  };
}

export async function logWithContextualReply(input: LogWithContextInput): Promise<ContextualLogResult>
```

### 6.4 执行顺序

1. normalize owner。
2. record user turn，source=`log`。
3. processMessage(text, { ownerId, force })。
4. 基于 pipeline.events 构建 recall queries。
5. 去重 recalled events，排除当前 message 的新事件（按 raw_message_id/message_id）。
6. build contextual reply：
   - 优先调用 LLM。
   - 失败则 deterministic fallback。
7. record assistant turn，source=`contextual_log_reply`，metadata 包含 recalled ids、pipeline message id、signals。
8. 返回结果。

## 7. TDD / 验收测试

### 7.1 必须有单测

新增 `packages/conversation/src/contextual-response.test.ts`，至少覆盖：

1. **deterministic fallback**：LLM 抛错时仍返回 reply。
2. **owner 语义**：妈妈输入只优先 recall 妈妈 owner 的相关事件；不能把爸爸“我”的事件混在同 owner recall 中。
3. **同类/同实体 recall**：当前 sleep + 星星日志能 recall 历史 sleep/星星事件。
4. **去重**：当前刚写入的事件不要作为“历史相关记忆”返回。
5. **负向情绪 signal**：当前 emotion valence negative 时 `has_negative_emotion=true`。

### 7.2 必须跑的命令

```bash
bun test packages/conversation/src/contextual-response.test.ts
bun test
bun build apps/ingest-api/src/server.ts --target=bun --outfile /tmp/xfeel-v2-server-check.js
bun build packages/conversation/src/contextual-response.ts --target=bun --outfile /tmp/xfeel-v2-contextual-response-check.js
bun build packages/ai-client/src/llm.ts --target=bun --outfile /tmp/xfeel-v2-llm-check.js
```

### 7.3 API smoke

如果服务可用，重启 `xfeel-v2-ingest` 后用 Python urllib 验证：

```text
POST /conversation/log
```

期望：

- HTTP 200
- `reply` 非空
- `pipeline.stored >= 0`
- `context.signals.owner_id` 等于输入 owner

## 8. 非目标

- 本期不做每周家庭信。
- 本期不做照片多模态。
- 本期不做复杂 causal graph。
- 本期不提交 git。

## 9. 交付标准

交付时必须给出：

1. 修改文件列表。
2. 新接口说明。
3. 测试/build/smoke 实际输出摘要。
4. 是否读取 Codex 配置成功（只能说成功/失败，不能输出 key）。
5. 剩余风险和下一步建议。
