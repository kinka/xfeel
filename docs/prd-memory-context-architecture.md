# xfeel-v3 记忆上下文分层架构 PRD

> 文档路径：`docs/prd-memory-context-architecture.md`
> 状态：Draft v2 · 负责人：核心团队 · 适用版本：xfeel-v3
> 下文第 0 节为 MVP 实现现状；第 1 节起为完整设计（部分为后续阶段目标）。

---

## 0. MVP 实现现状（已落地并通过回放验证）

目标：让助手**同时拥有**长期沉淀的理解、近期状态的较详细总结、当天对话的连续性，
从而“偶尔能像家人一样”回应——而不只是检索相似事件。

### 0.1 已建成的分层（复用既有 + 新增 L3）

| 层 | 时间尺度 | 来源 | 状态 |
|---|---|---|---|
| L1 当天 | 今天 | `session-context`（recentTurns + 当天 snippets） | 既有，已接入理解层 |
| L2 近期状态 | 最近约三周 | `memory_profiles(layer='recent')`，离线归纳 | **新增** |
| L3 长期理解 | 全历史 | `memory_profiles(layer='long_term')`，离线归纳 | **新增** |
| L0 事件证据 | 任意 | `memory_events` + recall（按意图召回） | 既有 |

### 0.2 关键设计决策（融合 Opus + Codex 意见后的取舍）

1. **理解是“可被当下推翻的假设”**：理解层注入回复时统一加纪律——用于定调/方向，
   不可逐字当事实复述；与用户当下陈述冲突时，顺着当下，不纠正、不编造具体事件。
2. **理解带生命周期**：`UnderstandingItem` 含 `status(active/superseded/retracted)`、
   `kind(observed/inferred)`、`support`（证据数/新鲜度/一致性/用户确认）拆解的置信度、
   `supportDates`、`lastConfirmedAt`。retracted 不注入；低置信度注入时标“暂不确定”。
3. **共情可执行优先**：理解类目里 `comfort_strategy/interaction_preference/sensitivity`
   排在传记类（persona/values/...）之前注入——直接回答“该怎么回应这个人”。
4. **主动好奇（缺口检测）**：L3 维护 `openQuestions`，记录“对这个人重要但还不了解”的事。
5. **来源是“持续对话和日志”**：长期/近期归纳读 `diaries`（含历史导入日记 + 日终归档），
   这是最完整的日志沉淀；长期归纳跨全历史**均匀抽样**避免偏向近期。
6. **防摘要漂移/过度概括**：每条 understanding 必须有 ≥2 个真实存在的 `supportDates`，
   否则丢弃；归纳 prompt 禁止把单次/微弱信号升格为稳定理解，禁止写入具体数字/某天事件。
7. **MVP 简化**：用**单表 `memory_profiles`**（owner×layer 各一条、version 自增、在线只读最新）
   替代设计稿里的三表；暂不做 7d/30d 双窗口与独立 job 表，离线归纳挂在 nightly 后。

### 0.3 文件与命令

- 数据：`packages/db/src/schema.ts` 新增 `memory_profiles` 表。
- 模块：`packages/conversation/src/memory/`
  - `profile-types.ts` 类型（含生命周期/置信度拆解/openQuestions）
  - `profile-repository.ts` 读写（upsert + version 自增 + owner 隔离）
  - `profile-builder.ts` 离线归纳（recent 摘要 + long-term 理解，含防漂移校验）
  - `profile-context.ts` 在线注入（理解层文本 + 纪律 + 称呼表 + 特性开关）
- 接入：`conversation.ts`、`contextual-response.ts` 回复路径注入理解层；
  `scripts/nightly-worker.ts` 归档后重建画像。
- 命令：`bun run scripts/build-profile.ts --owner=<id>`（手动归纳）；
  `bun run scripts/replay-profile.ts`（有/无理解层 A/B 回放）。
- 特性开关：`XFEEL_UNDERSTANDING_DISABLED=1` 一键关闭理解层（灰度/回滚/A-B）。

### 0.4 回放验证结论

在真实库拷贝上对 owner“爸爸”（2024–2026 共 ~280 天日志）归纳出 12 条长期理解
（每条 4–5 条跨年支撑）+ 近期状态摘要。对情绪倾诉类消息做 A/B：
- 无理解层：泛泛回应，甚至退化为元回复；
- 有理解层：开口即用其“先承认辛苦再看见进展”的安抚策略、尊重“孩子生病=高敏感”、
  用昵称称呼孩子、并呼应近期状态。共情明显更贴合“懂这个人”。

单测：`packages/conversation/src/memory/profile.test.ts`（round-trip / 版本 / owner 隔离 /
注入纪律 / 特性开关）+ 全 conversation 套件 56 passing。

---

## 1. 目标与非目标

### 1.1 背景

xfeel-v3 是家庭记忆助手。当前 recall 的实现把“找到相同/类似的历史事件”当成目标（事件级向量召回），这是一个**手段被误当成目的**的错误。

用户已明确：**recall 的根本目的不是检索相似事件，而是增加系统对用户的理解，从而生成更准确、更有温度的共情回复。** 相似事件检索只是其中一种低层证据来源，不应主导上下文。

同时，事件级在线向量召回在数据量增长后会带来**响应超时**风险，且容易把弱关联的历史事件错误地当成“事实”塞进 prompt，造成串台与幻觉。

### 1.2 目标（Goals）

1. 建立 **L0/L1/L2/L3 四层上下文模型**，把“理解”与“证据”分离。
2. 长期理解（L3）与近期理解（L2）通过**离线归纳 job 预计算**，在线只读快照，杜绝在线超时。
3. 事件级 recall 从“主召回”**降级为 evidence/detail lookup**，只在需要具体事实/日期/锚点时调用。
4. 在线 context builder 在固定 token 预算内，按“理解优先、证据按需”的策略组装 prompt。
5. 建立明确的**事实纪律**：理解层不可被当作具体事实引用，只有 evidence 层可回答具体历史。
6. 解决 owner/speaker 串台、昵称/称呼一致性问题。

### 1.3 非目标（Non-Goals）

- 不在本期重做 ASR / 多模态输入管线。
- 不在本期引入新的向量库或更换 embedding 模型。
- 不做跨用户/跨家庭的知识共享或联邦学习。
- 不做实时（流式 token 级）归纳；归纳一律走离线 job。
- L3 长期画像不追求“完整人物传记”，只维护对共情有用的稳定特征。

---

## 2. 产品原则

| 原则 | 含义 | 落地约束 |
|---|---|---|
| **理解优先（Understanding-first）** | 上下文首先服务于“我懂这个人”，而非“我记得这件事” | context builder 先装 L3/L2 理解层，再按需补 L0 evidence |
| **证据纪律（Evidence discipline）** | 任何具体事实（日期、数字、人名、事件经过）只能来自 evidence 层并附 source | 理解层文本进入 prompt 时标注 `confidence` 与 `as_understanding`，禁止逐字当事实复述 |
| **不过度概括（No over-generalization）** | 归纳必须基于足量证据，单次/弱信号不得升格为“稳定特征” | 每条 L2/L3 结论需 `evidence_count ≥ 阈值` 且记录 `support_event_ids` |
| **owner/speaker 防串台** | 区分“记忆归属人（owner）”与“说话人（speaker）”，避免把家庭成员 A 的事安到 B 头上 | 所有 snapshot / evidence 强制带 `owner_id` 与 `subject`，归纳 job 按 owner 分桶 |
| **昵称/称呼一致** | 对每个家庭成员使用用户习惯的称呼（“宝宝”/“老大”/真名），全程一致 | L3 维护 `address_book`（称呼映射），回复生成读取并强制使用 |

补充原则：
- **弱关联不引用**：相似度/关联度低于阈值的 evidence 不进入 prompt，更不得被表述为“你之前说过……”。
- **可解释**：每条进入 prompt 的理解都能回溯到 `support_event_ids`，便于审计与纠错。

---

## 3. 上下文分层（L0 / L1 / L2 / L3）

### 3.1 层级定义

| 层 | 名称 | 时间范围 | 内容 | 生成方式 | 进入 prompt 方式 | Token 预算（默认） |
|---|---|---|---|---|---|---|
| **L0** | 事件级证据 Evidence | 任意历史 | 单条事件/对话的具体事实：日期、地点、人物、原话、数值 | 在线按需检索（向量 + 结构化过滤） | **按需**，仅当意图需要具体事实/验证锚点时 | ≤ 400 |
| **L1** | 当天上下文 Today | 当天 | 当天对话 turns + 当天刚记录事件 | 在线实时拼装（会话状态） | 始终注入（裁剪后） | ≤ 500 |
| **L2** | 近期理解 Recent | 滚动 7 天 / 30 天 | 生活节奏、反复主题、情绪变化、关键事件、open threads | 离线 job 预计算快照 | 始终注入（读最新快照） | ≤ 600 |
| **L3** | 长期理解 Long-term Profile | 全历史（稳定） | 用户画像、家庭关系、价值观、常见压力源、养育风格、成员特征、称呼表 | 离线 job 周期归纳快照 | 始终注入（读最新快照） | ≤ 500 |

总注入预算目标：**理解层（L1+L2+L3）≤ 1600 token**，evidence（L0）按需 ≤ 400 token，给系统指令/回复留足空间。预算可通过 feature flag 配置。

### 3.2 各层职责边界

- **L3 回答“他是谁/他在乎什么”** —— 稳定、低频更新、最高优先注入。
- **L2 回答“他最近怎么样”** —— 中频更新，承接 L3 与当天之间的桥梁。
- **L1 回答“他此刻在说什么”** —— 实时，决定本轮共情焦点。
- **L0 回答“具体那件事到底是什么”** —— 只在需要事实核对/引用时调用，是唯一可作为“事实来源”的层。

> 关键区分：**L2/L3 是“理解”，L0 是“事实”。** 理解可以指导语气与方向，事实才能被具体引用。

---

## 4. 数据模型

存储建议：快照与证据落 SQLite/关系库（结构化 + 可索引），向量仍在现有 vector database。下列为 TypeScript interface 与必要字段。

### 4.1 `memory_context_snapshots`

预计算的理解层快照（L2/L3），在线只读最新一条。

```typescript
type SnapshotLayer = 'L2_recent' | 'L3_long_term';
type SnapshotWindow = 'rolling_7d' | 'rolling_30d' | 'all_time';

interface MemoryContextSnapshot {
  id: string;                     // uuid
  ownerId: string;                // 记忆归属人（家庭成员），防串台核心键
  householdId: string;            // 家庭维度
  layer: SnapshotLayer;
  window: SnapshotWindow;

  content: SnapshotContent;       // 归纳后的结构化理解（不是原始事件）

  version: number;                // 单 (ownerId, layer, window) 维度递增
  isCurrent: boolean;             // 当前生效快照（同维度只有一条 true）
  evidenceCount: number;          // 支撑此快照的事件总数
  supportEventIds: string[];      // 抽样/关键支撑事件，可回溯
  generatedByJobId: string;       // 来源 job 运行
  sourceModel: string;            // 归纳所用模型 id
  contentHash: string;            // 输入指纹，用于幂等
  tokenEstimate: number;          // 注入预算控制

  coversFrom: string;             // ISO，覆盖数据起点
  coversTo: string;               // ISO，覆盖数据终点
  createdAt: string;
}

interface SnapshotContent {
  understandings: UnderstandingItem[];
  addressBook?: AddressEntry[];    // 仅 L3：称呼映射
  openThreads?: OpenThread[];      // 仅 L2：未闭合话题
}

interface UnderstandingItem {
  category:
    | 'persona' | 'relationship' | 'values'
    | 'stressor' | 'parenting_style' | 'member_trait'
    | 'life_rhythm' | 'recurring_theme' | 'emotional_trend'
    | 'key_event';
  subject: string;                 // 描述对象（owner 自己 / 某家庭成员 id）
  statement: string;               // 理解性陈述（非逐字事实）
  confidence: number;              // 0..1
  evidenceCount: number;
  supportEventIds: string[];
  firstSeenAt?: string;
  lastSeenAt?: string;
}

interface AddressEntry {
  memberId: string;
  preferredAddress: string;
  aliases: string[];
  relationToOwner: string;
}

interface OpenThread {
  topic: string;
  status: 'open' | 'watching';
  lastMentionedAt: string;
  supportEventIds: string[];
}
```

### 4.2 `memory_context_evidence`

事件级证据索引（L0）。是连接结构化事实与向量召回的中间层；具体事实引用以此为准。

```typescript
interface MemoryContextEvidence {
  id: string;
  eventId: string;                 // 关联原始事件/对话记录
  ownerId: string;                 // 记忆归属人
  speakerId: string;               // 说话人（可能 ≠ owner），防串台
  householdId: string;
  subjects: string[];              // 该证据涉及的成员

  factText: string;                // 可被引用的具体事实陈述
  factType: 'date' | 'quote' | 'metric' | 'event_detail' | 'preference';
  occurredAt?: string;             // 事件发生时间（事实日期）
  recordedAt: string;              // 记录时间

  embeddingRef?: string;           // 指向 vector db 的向量 id
  salience: number;                // 重要度 0..1
  retrievalCount: number;          // 被召回次数（可用于热度）
  createdAt: string;
}
```

### 4.3 `memory_context_jobs`

归纳 job 运行记录，支撑幂等、重试、可观测。

```typescript
type JobType = 'daily_summary' | 'recent_summary' | 'long_term_profile';
type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

interface MemoryContextJob {
  id: string;
  jobType: JobType;
  ownerId: string;
  householdId: string;

  status: JobStatus;
  inputHash: string;               // 输入数据指纹，幂等关键
  inputEventRange: { from: string; to: string };
  inputEventCount: number;

  outputSnapshotId?: string;       // 成功时产出的 snapshot
  model: string;
  attempt: number;                 // 重试次数
  lastError?: string;

  scheduledFor: string;            // 计划运行时间
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}
```

**索引建议**：`(ownerId, layer, isCurrent)`、`(ownerId, occurredAt)`、`(jobType, status, scheduledFor)`、`evidence(ownerId, factType, occurredAt)`。

---

## 5. 归纳 Job 设计

三类 job 均为**离线异步**，按 owner 分桶执行，输出写入 `memory_context_snapshots`，运行记录写 `memory_context_jobs`。

### 5.1 `daily_summary`（产出当天浓缩，喂给 L2）

> 说明：L1 当天上下文在线实时拼装；`daily_summary` 的作用是把“当天”固化为可被 recent 归纳消费的浓缩单元，避免 recent job 每次重读全部原始 turns。

- **频率**：每日一次（建议家庭本地时间凌晨低峰），或当天会话结束触发。
- **输入**：当天该 owner 的全部对话 turns + 当天新增事件。
- **输出 schema**：

```typescript
interface DailySummaryOutput {
  ownerId: string;
  date: string;                    // YYYY-MM-DD（本地时区）
  emotionalTone: string;           // 当天主导情绪
  highlights: string[];            // 关键时刻（含 supportEventIds）
  newEvidence: Array<{ eventId: string; factText: string; factType: string }>;
  unresolved: string[];            // 当天遗留 open thread 候选
  supportEventIds: string[];
}
```

### 5.2 `recent_summary`（L2，7d / 30d）

- **频率**：每日增量更新 7d 窗口；每周重算 30d 窗口。
- **输入**：窗口内的 `daily_summary` 输出集合（而非原始 turns）+ 现行 L2 快照。
- **输出**：`SnapshotContent`（`understandings` 聚焦 life_rhythm / recurring_theme / emotional_trend / key_event + `openThreads`）。

### 5.3 `long_term_profile`（L3）

- **频率**：每周一次，或累计新增证据超过阈值（如 ≥ N 条高 salience evidence）触发。
- **输入**：现行 L3 快照 + 近一周 `recent_summary` 输出 +（首次构建时）历史抽样证据。**增量合并，不每次重建。**
- **输出**：`SnapshotContent`（persona / relationship / values / stressor / parenting_style / member_trait + `addressBook`）。

### 5.4 通用机制

**幂等**
- 以 `inputHash`（owner + 窗口 + 输入事件集指纹）判重；相同 `inputHash` 且已有成功快照 → 状态置 `skipped`，不重复消耗模型。
- 快照按 `(ownerId, layer, window)` 维度，写入时把旧 `isCurrent` 翻为 false，新条置 true，`version` 递增（保留历史，可回滚）。

**失败策略**
- 指数退避重试（建议最多 3 次），记录 `attempt` 与 `lastError`。
- 终态失败：**保留上一版 `isCurrent` 快照继续服务**（在线读永远有可用快照），并产出告警。
- 单 owner 失败不影响其他 owner（按 owner 分桶、独立事务）。

**防幻觉 / 防过度概括**
- 归纳 prompt 强约束：每条 `UnderstandingItem` 必须给出 `supportEventIds` 与 `evidenceCount`；无支撑则不得输出。
- `evidenceCount < 阈值`（如 L3 默认 3、L2 默认 2）的结论降级或丢弃。
- 结构化输出（受控 `category` 枚举）+ 输出后校验：`supportEventIds` 必须真实存在于该 owner 的 evidence；不存在则整条作废。
- 归纳模型禁止引入输入中不存在的具体数字/日期/人名（这些只能来自 evidence 层）。

---

## 6. 在线 Context Builder

在线只做“读快照 + 拼装 + 按需补 evidence”，**不做任何在线归纳**，保证延迟可控。

### 6.1 组装流程

1. **读取理解层（始终）**：按 `(ownerId, layer, isCurrent=true)` 取 L3、L2(7d)、L1(当天实时)。
2. **意图判断**：复用 `intent-classifier` / `intent-router`。判断本轮是否需要**具体事实**（日期、数字、“上次那件事”、验证类问题）。
3. **按需补 L0 evidence**：仅当 (2) 判定需要事实时，调用 event evidence 检索（向量 + `ownerId`/`subject`/`factType`/时间过滤）。否则**完全不查 L0**。
4. **排序**：L3 > L2 > L1 > L0(evidence)。理解层在前确立“我懂你”，evidence 在后提供锚点。层内按 `confidence × salience × recency` 排序。
5. **裁剪**：按各层 token 预算从低分项截断；超预算优先保留高 confidence 的 L3/L2 与高 salience 的 evidence。
6. **标记**：理解层文本注入时打 `as_understanding`（指导语气，不可逐字当事实）；evidence 打 `as_fact` 并附 `source(eventId, occurredAt)`。

### 6.2 何时调用 event evidence（L0）

调用，当且仅当本轮满足任一：
- 意图为事实查询 / 时间查询 / “上次/那次”指代具体事件；
- 需要验证锚点（用户陈述与系统理解可能冲突，需核对）；
- 用户显式要求回忆某具体事件。

**不调用**：纯情绪倾诉、寻求安慰、开放式聊天 —— 这些只靠 L1/L2/L3 理解层即可共情，避免无谓延迟与弱关联污染。

### 6.3 Fallback

- L2/L3 快照缺失（新用户/job 未跑）→ 用现有 evidence 实时做**极简降级摘要**（限量、限时），或仅用 L1，并标记 `degraded=true`。
- evidence 检索超时 → 放弃 L0，仅用理解层回复，绝不阻塞回复生成。
- 弱关联（相似度 < 阈值）evidence → 丢弃，不进入 prompt。

---

## 7. 回复策略（事实纪律）

| 层 | 在回复中的角色 | 允许 | 禁止 |
|---|---|---|---|
| L3 长期 | 定调：语气、关切点、称呼 | “我知道你一直很重视陪伴孩子的时间” | 编造具体事件/日期 |
| L2 近期 | 方向：呼应近期状态与 open threads | “最近这阵子你好像压力比较大” | 把“反复主题”说成“你昨天具体说过X” |
| L1 当天 | 焦点：回应此刻 | 引用当天对话内容 | —— |
| L0 evidence | 唯一事实来源 | “你上周三提到孩子发烧到 39 度”（附 source） | 引用未召回/弱关联事件 |

核心规则：
1. **理解层不可被表述为具体事实。** L2/L3 文本用于指导共情，禁止以“你说过/你提到”句式逐字复述。
2. **只有 L0 evidence 能回答“具体那件事”**，且回复中具体数字/日期/原话必须有 evidence source 支撑。
3. **无 evidence 支撑时，宁可不说具体**：以理解性、开放性表达替代捏造（“我记得你最近为这事操心，能再和我说说细节吗？”）。
4. **称呼一致**：对家庭成员统一使用 L3 `addressBook.preferredAddress`。
5. **冲突时以用户当下陈述为准**，并可温和用 evidence 求证，不强行纠正。

---

## 8. 测试与验收标准（Acceptance Criteria）

1. **AC1 共情质量**：在情绪倾诉场景下，回复正确使用 L2/L3 理解（语气/关切点匹配），且**未调用 L0**。
2. **AC2 事实纪律 — 不捏造**：当无 evidence 支撑某具体事实时，回复不得出现具体日期/数字/原话；以理解性或追问表达替代。固定用例 0 捏造。
3. **AC3 事实纪律 — 正确引用**：事实查询场景下，回复中的具体事实 100% 可回溯到被召回的 evidence source。
4. **AC4 性能 — 在线无超时**：理解层快照命中时，context 构建 P95 < 300ms，不触发任何在线归纳；端到端回复延迟不因记忆层超时。
5. **AC5 owner/speaker 防串台**：多成员家庭用例中，归属成员 A 的事实不出现在对成员 B 的回复里；snapshot/evidence 的 `ownerId` 隔离 100% 正确。
6. **AC6 称呼一致**：对每个成员的称呼全程使用 `addressBook.preferredAddress`，跨多轮一致，无真名/昵称混用。
7. **AC7 弱关联不引用**：注入相似度低于阈值的诱导事件时，回复不引用该事件，也不以“你之前说过”句式提及。
8. **AC8 不过度概括**：单次弱信号事件不得在 L2/L3 升格为“稳定特征”；归纳产出的每条 understanding 均带足够 evidence 且 `supportEventIds` 真实存在。
9. **AC9 job 幂等与韧性**：相同输入重复运行不产生重复快照（命中 `skipped`）；job 失败时在线仍读到上一版 `isCurrent` 快照，回复不降级失败。
10. **AC10 fallback**：无 L2/L3 快照的新用户仍能产出合理共情回复（degraded 路径），不报错、不超时。

---

## 9. 渐进实施路线

| Phase | 目标 | 范围 | 上线判据 |
|---|---|---|---|
| **Phase 1** | Schema + Shadow snapshots | 建三张表与 TS 类型；写入路径上线但**不影响线上回复**（影子模式）；从历史数据回填 evidence | 表结构/索引就位；snapshot 可被离线检查 |
| **Phase 2** | 归纳 Jobs | 实现 daily/recent/long_term 三 job，含幂等、重试、防幻觉校验、按 owner 分桶；产出快照仍仅影子可见 | 三 job 稳定产出快照；AC8/AC9 通过；人工抽检快照质量 |
| **Phase 3** | Context Builder（feature flag） | 新 context builder 读取 L3/L2/L1，feature flag 灰度；旧事件召回路径并存 | flag 开启下 AC1/AC4/AC5/AC6 通过；灰度回归共情得分提升 |
| **Phase 4** | 降级 Event Recall | 把事件召回改为“按意图按需”的 L0 evidence lookup，移除“相似事件主召回”；明确事实纪律 | AC2/AC3/AC7 通过；旧主召回路径下线 |
| **Phase 5** | 性能优化 | 快照缓存、token 预算调优、evidence 检索剪枝、归纳模型成本优化 | P95 延迟与模型成本达标；负载测试通过 |

每个 Phase 都保持“在线只读、归纳离线”的不变式，可独立回滚（feature flag + 快照 version 回退）。

---

## 10. 文件影响清单

**新增 — 数据与类型**
- `packages/conversation/src/memory/types.ts` — 上述所有 interface（snapshots/evidence/jobs/SnapshotContent 等）。
- `packages/conversation/src/memory/schema.sql`（或 migration）— 三张表与索引。
- `packages/conversation/src/memory/snapshot-repository.ts` — 快照读写（含 isCurrent 切换、version 递增）。
- `packages/conversation/src/memory/evidence-repository.ts` — evidence 写入/检索（结构化过滤 + 向量）。
- `packages/conversation/src/memory/job-repository.ts` — job 运行记录与状态机。

**新增 — 归纳 jobs**
- `packages/conversation/src/memory/jobs/daily-summary.ts`
- `packages/conversation/src/memory/jobs/recent-summary.ts`
- `packages/conversation/src/memory/jobs/long-term-profile.ts`
- `packages/conversation/src/memory/jobs/summarization-guard.ts` — 防幻觉/防过度概括校验（supportEventIds 校验、evidenceCount 阈值）。
- `packages/conversation/src/memory/jobs/runner.ts` — 调度、幂等(inputHash)、重试、按 owner 分桶。

**新增 — 在线 context builder**
- `packages/conversation/src/memory/context-builder.ts` — 读 L3/L2/L1、排序、裁剪、fallback、按需触发 evidence。
- `packages/conversation/src/memory/token-budget.ts` — 各层预算与裁剪策略。

**改造 — 现有文件**
- `packages/conversation/src/recall-intent.ts` — 由“相似事件召回”改为“按意图触发 L0 evidence lookup”（Phase 4）。
- `packages/conversation/src/tool-recall.ts` / `tool-recall.test.ts` — recall 工具语义改为 evidence/detail lookup。
- `packages/conversation/src/relevance-gate.ts` — 弱关联阈值过滤，接入“弱关联不引用”。
- `packages/conversation/src/intent-classifier.ts` / `intent-router.ts` / `intent-router.test.ts` / `intent-router-smart.test.ts` — 增加“是否需要具体事实”的意图判定，决定是否调 L0。
- `packages/conversation/src/contextual-response.ts` / `contextual-response.test.ts` — 接入新 context builder 与事实纪律（理解 vs 事实标记、称呼一致）。
- `packages/conversation/src/conversation.ts` — 串联 context builder，feature flag 灰度（Phase 3）。

**新增 — 测试**
- `packages/conversation/src/memory/*.test.ts` — repository/job/guard 单测。
- `packages/conversation/src/memory/acceptance/` — AC1–AC10 回归对话集 + LLM-judge 评分脚手架。

**配置 / 可观测**
- feature flag：`memory_context_v2_enabled`、各层 token 预算、evidence 相似度阈值、evidenceCount 阈值。
- 为 job 运行、快照切换、evidence 命中/丢弃、degraded fallback 打点。
