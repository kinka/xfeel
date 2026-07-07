# Extraction Field Redesign Notes

> 目的：如果重新设计 xfeel 的记忆抽取字段，避免依赖穷举词表，同时保留可检索、可统计、可迁移的结构化能力。

## 背景问题

当前 `MemoryEvent` 里 `event_type`、`emotion.primary`、`tags` 都比较像“封闭词表”。这在早期便于过滤和测试，但真实家庭日记有长尾：

- 症状、食物、地点、活动、玩具、工作场景无法穷举；
- 长段落经常混合多个事件，单一 `event_type` 容易把整段压扁；
- tag 既承担分类、症状、主题、物品、行为等多种职责，边界变模糊；
- 新词表一加，baseline recall 可能被隐式扩展污染；
- 旧数据重抽取时 schema 变动成本高。

## 核心原则

### 1. 少量稳定枚举 + 大量开放 slot

不要试图穷举所有词。只把真正稳定、用于权限/路由/高层筛选的字段做枚举：

- owner / actor
- event frame / domain
- time
- source/provenance
- valence / salience

其余信息保留为开放短语、span、属性和值。

### 2. 把“分类”和“事实”拆开

`event_type=health` 是分类；`symptom=呕吐` 是事实。

不要让 tag 同时承担所有角色。更推荐把标签拆成若干 typed facets：

- symptoms
- activities
- objects
- foods
- places
- people/entities
- topics
- routines
- developmental_skills
- work_contexts

### 3. 所有开放词都带 evidence span

开放字段必须能回到原文：

```json
{
  "kind": "symptom",
  "value": "呕吐",
  "surface": "吐了好几次",
  "span": [18, 24],
  "confidence": 0.92
}
```

这样即使 normalization 错了，也可以重放和修正，而不是只能相信 canonical tag。

### 4. 抽取层负责“记录事实”，检索层负责“扩展语义”

抽取不要为了 recall 过度补同义词。抽取记录原文事实：

- surface: `吐了好几次`
- canonical: `呕吐`
- kind: `symptom`

检索时再决定：`上吐下泻` 是否扩展到 `呕吐 + 腹泻`。

这可以避免 baseline recall 被词表污染。

### 5. 把复合段落拆成 atomic events，同时保留 episode

一条日记可以对应一个 episode，episode 下有多个 atomic events：

```text
raw_message
  -> episode: 周五下班接娃和晚间活动
      -> event: 接娃时孩子兴奋
      -> event: 路上看柯基
      -> event: 晚饭抢虾抢青菜并吃完
      -> event: 玩磁力片
```

检索可以召回 atomic event，也可以回到 episode 读上下文。

## 建议的新结构

### MemoryEpisode

面向“原始日记段落/一次记录”的上层容器。

```ts
interface MemoryEpisode {
  id: string;
  raw_message_id: string;
  owner_id: string;
  title?: string;
  summary: string;
  original_text: string;
  event_date?: string;
  event_time_range?: { start?: string; end?: string };
  location_mentions?: ExtractedMention[];
  participants: EntityRef[];
  salience: number;
  source: SourceInfo;
  extraction: ExtractionInfo;
}
```

### AtomicMemoryEvent

面向检索/统计的最小事实事件。

```ts
interface AtomicMemoryEvent {
  id: string;
  episode_id: string;
  raw_message_id: string;
  owner_id: string;

  // 稳定高层分类：少而粗
  frame: EventFrame;
  subframe?: string; // 开放短语，如 "接娃", "海边玩水", "客户付款"

  // 事件语义
  predicate: string; // 开放动词/动作短语，如 "呕吐", "抢虾", "哄睡", "感慨"
  summary: string;
  original_span: TextSpan;

  // 参与者和角色，不只是 entities 平铺
  participants: EventParticipant[];

  // typed facts，开放但有 kind
  facts: ExtractedFact[];

  // 情绪独立建模
  affect?: Affect;

  // 时间地点
  time?: TimeValue;
  place?: PlaceRef;

  // 可检索文本与版本
  search_text: string;
  extraction: ExtractionInfo;
}
```

### EventFrame：稳定粗粒度枚举

建议比现在更少、更抽象，避免不断加 `travel`、`play`、`study`：

```ts
type EventFrame =
  | "body_health"      // 身体健康、症状、医疗
  | "care_routine"     // 照护、吃喝拉撒睡、接送
  | "development"      // 成长能力、语言、运动、认知
  | "relationship"     // 互动、冲突、亲子、手足、社交
  | "activity"         // 玩耍、出行、旅行、购物、活动
  | "work_life"        // 工作、职业、业绩、同事
  | "inner_world"      // 情绪、反思、自我叙事
  | "environment"      // 天气、空间、外部条件
  | "meta"             // 计划、回顾、归档、非日记命令
  | "other";
```

重点：`travel` 不一定要成为 frame，它可以是：

```json
{
  "frame": "activity",
  "subframe": "旅行",
  "facts": [
    { "kind": "place", "value": "鲘门" },
    { "kind": "activity", "value": "看海浪" }
  ]
}
```

### ExtractedFact：开放事实槽

```ts
interface ExtractedFact {
  kind:
    | "symptom"
    | "food"
    | "activity"
    | "object"
    | "place"
    | "skill"
    | "routine"
    | "work_topic"
    | "social_relation"
    | "quantity"
    | "state"
    | "quote"
    | "topic"
    | "other";
  value: string;       // canonical if available, otherwise clean surface
  surface: string;     // 原文表达
  span?: TextSpan;
  attributes?: Record<string, unknown>;
  confidence: number;
}
```

这比单个 `tags: string[]` 更清楚：

```json
[
  { "kind": "food", "value": "冰激凌", "surface": "冰激凌" },
  { "kind": "symptom", "value": "呕吐", "surface": "吐了好几次" },
  { "kind": "symptom", "value": "腹泻", "surface": "又拉" }
]
```

### EventParticipant：实体 + 角色

不要只存 `entities: ["爸爸", "星星"]`，否则不知道谁做了什么。

```ts
interface EventParticipant {
  entity_id?: string;
  canonical_name: string;
  surface?: string;
  role:
    | "experiencer"   // 症状/情绪承受者
    | "actor"         // 行为发起者
    | "caregiver"
    | "observer"
    | "speaker"
    | "recipient"
    | "mentioned";
  confidence: number;
}
```

例：冰激凌吐了：

```json
[
  { "canonical_name": "星星", "role": "experiencer" },
  { "canonical_name": "爸爸", "role": "caregiver" },
  { "canonical_name": "禾禾", "role": "mentioned" }
]
```

### Affect：从事件情绪变成“谁的情绪”

现在 `emotion` 容易混淆：是爸爸疲惫？星星难受？妈妈焦虑？

建议：

```ts
interface Affect {
  holder?: EntityRef; // 谁的情绪，未知可空
  label: string;      // 开放/规范化均可
  valence: "positive" | "negative" | "mixed" | "neutral";
  arousal?: number;
  intensity: number;
  surface?: string;
  confidence: number;
}
```

一个 event 可以有多个 affect：孩子兴奋、爸爸疲惫。

## 对当前 case 的映射

### 冰激凌吐了

旧结构容易变成：

```json
{ "event_type": "feeding", "entities": ["爸爸"], "tags": ["育儿压力"] }
```

新结构：

```json
{
  "frame": "body_health",
  "subframe": "饮食后不适",
  "predicate": "呕吐",
  "participants": [
    { "canonical_name": "星星", "role": "experiencer" },
    { "canonical_name": "爸爸", "role": "caregiver" }
  ],
  "facts": [
    { "kind": "food", "value": "冰激凌", "surface": "冰激凌" },
    { "kind": "symptom", "value": "呕吐", "surface": "吐了好几次" }
  ],
  "affect": [{ "holder": { "name": "爸爸" }, "label": "焦虑", "valence": "negative" }]
}
```

### 接娃 + 柯基 + 晚饭 + 磁力片

一个 episode，多 event：

- `care_routine / 接娃`
- `activity / 观察柯基`
- `care_routine / 晚饭进食`
- `activity / 玩磁力片`

每个 event 有自己的 span、participants、facts。

### 鲘门海浪

不要压成 `sleep`：

```json
{
  "frame": "activity",
  "subframe": "旅行/海边活动",
  "predicate": "看海浪",
  "place": { "value": "鲘门" },
  "facts": [
    { "kind": "place", "value": "鲘门" },
    { "kind": "activity", "value": "看海浪" }
  ]
}
```

如果同一段还有哄睡，则另拆一个：

```json
{ "frame": "care_routine", "subframe": "哄睡", "predicate": "哄睡" }
```

## 检索设计配套

### 存储三层文本

1. `original_text`：完整原文
2. `event_span_text`：该 atomic event 的原文片段
3. `canonical_search_text`：规范化可检索文本

`canonical_search_text` 可以包含：

```text
frame subframe predicate participants facts affect place summary
```

但要记录 `search_text_version`，方便重建。

### Expansion 不写入事实层

例如 query `上吐下泻`：

- query expansion 临时扩展：`呕吐`, `腹泻`, `拉肚子`
- 不把这些全写回 event facts

这样不会污染历史事实。

### Eval 分成三类

- extraction miss：事实没抽出来，如 `呕吐` 不在 facts
- normalization miss：surface 有，但 canonical 错，如 `吐了` 没归到 `呕吐`
- retrieval miss：facts 对，但没召回/排序低

## 迁移策略

不建议一次性推翻。可以渐进式：

1. 保留当前 `memory_events` 表；
2. 新增 JSON 字段或旁表：`event_facts`, `event_participants`, `episode_id`, `frame`, `subframe`, `predicate`；
3. 当前 `event_type/tags/entities/emotion` 作为兼容投影，由新结构生成；
4. 新抽取器同时输出 legacy + v2；
5. eval 同时比较 legacy recall 与 v2 recall；
6. 确认收益后再批量 reprocess。

## 最小落地版本

如果只做小改动，不动大 schema，建议先加：

```ts
facts: ExtractedFact[]
participants: EventParticipant[]
frame?: string
subframe?: string
predicate?: string
episode_id?: string
```

并保留：

```ts
event_type
tags
entities
emotion
```

作为兼容字段。

这能立刻解决：

- tag 不可穷举；
- entities 无角色；
- 情绪不知道属于谁；
- 复合段落无法表示；
- travel/play/work_detail 等长尾概念无限加 enum 的问题。

## 结论

重做字段设计时，不应该追求“穷举所有词”。更合理的是：

- enum 只表达少量稳定框架；
- facts 保存开放事实槽；
- 每个事实都有 surface/span/evidence；
- episode 保留上下文，atomic event 服务检索；
- legacy 字段作为投影，而不是唯一真相。
