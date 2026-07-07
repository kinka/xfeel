# xfeel-v3 SQLite 数据表及关系

本文依据 `packages/db/src/schema.ts` 以及本地 `data/xfeel.db` 的真实 `sqlite_master` schema 推断。重点覆盖主 SQLite 库中的事实表、归档表、家庭/说话人表和检索索引；向量库中的 `memory_embeddings` 不在本文范围内。

## ER 图

```mermaid
erDiagram
  CONVERSATION_TURNS {
    TEXT id PK
    TEXT owner_id
    TEXT role
    TEXT content
    TEXT turn_date
    TEXT source
    TEXT metadata_JSON
    TEXT archive_id
    TEXT created_at
  }

  DAILY_ARCHIVES {
    TEXT id PK
    TEXT owner_id
    TEXT archive_date
    TEXT summary
    TEXT source_turn_ids_JSON
    TEXT event_ids_JSON
    TEXT status
    TEXT error
    TEXT created_at
    TEXT updated_at
  }

  MEMORY_EVENTS {
    TEXT id PK
    TEXT raw_message_id
    TEXT summary
    TEXT original_text
    TEXT event_type
    TEXT entities_JSON
    TEXT emotion_JSON
    TEXT tags_JSON
    TEXT open_facts_JSON
    TEXT canonical_search_text
    INTEGER event_index
    TEXT original_span
    TEXT event_date
    TEXT extractor_version
    TEXT vocab_version
    TEXT search_text_version
    TEXT source_archive_id
    TEXT location
    TEXT event_time
    REAL confidence
    TEXT source
    TEXT source_layer
    TEXT user_id
    TEXT created_at
    TEXT updated_at
  }

  MEMORY_EVENTS_FTS {
    VIRTUAL id "FTS5/search index"
    TEXT summary
    TEXT original_text
    TEXT tags
    TEXT canonical_search_text
  }

  MEMORY_OPEN_FACTS {
    TEXT id PK
    TEXT event_id FK
    TEXT owner_id
    TEXT kind
    TEXT value
    TEXT surface
    INTEGER evidence_start
    INTEGER evidence_end
    REAL confidence
    TEXT polarity
    TEXT actor_id
    TEXT experiencer_id
    TEXT observer_id
    TEXT created_at
    TEXT updated_at
  }

  ENTITIES {
    TEXT id PK
    TEXT name UK
    TEXT type
    TEXT aliases_JSON
    TEXT attributes_JSON
    TEXT first_seen
    TEXT last_seen
    INTEGER mention_count
    TEXT created_at
  }

  ENTITY_EVENTS {
    TEXT entity_id PK, FK
    TEXT event_id PK, FK
    TEXT role
  }

  CAUSAL_CHAINS {
    TEXT id PK
    TEXT cause_event_id FK
    TEXT effect_event_id FK
    TEXT relation_type
    REAL strength
    TEXT description
    TEXT created_at
  }

  DIARIES {
    TEXT id PK
    TEXT user_id
    TEXT content
    TEXT diary_date
    TEXT source
    TEXT event_ids_JSON
    TEXT created_at
  }

  PIPELINE_STATUS {
    TEXT message_id PK
    TEXT stage
    TEXT status
    TEXT error
    TEXT result_JSON
    TEXT created_at
    TEXT updated_at
  }

  MEMORY_PROFILES {
    TEXT id PK
    TEXT owner_id
    TEXT layer
    TEXT content_JSON
    INTEGER version
    TEXT covers_from
    TEXT covers_to
    INTEGER evidence_count
    TEXT source_model
    TEXT generated_at
    TEXT updated_at
  }

  FAMILIES {
    TEXT id PK
    TEXT name
    TEXT created_at
    TEXT updated_at
  }

  FAMILY_MEMBERS {
    TEXT id PK
    TEXT family_id FK
    TEXT label
    TEXT role
    TEXT birth_date
    TEXT metadata_JSON
    TEXT created_at
    TEXT updated_at
  }

  MEMBER_ALIASES {
    TEXT id PK
    TEXT family_id FK
    TEXT member_id FK
    TEXT alias
    TEXT scope
    TEXT speaker_profile_id
    TEXT relation
    TEXT created_at
    TEXT updated_at
  }

  SPEAKER_PROFILES {
    TEXT id PK
    TEXT family_id FK
    TEXT platform
    TEXT external_user_id
    TEXT self_member_id FK
    TEXT display_name
    TEXT metadata_JSON
    TEXT created_at
    TEXT updated_at
  }

  FAMILY_SETTINGS {
    TEXT family_id PK, FK
    TEXT timezone
    TEXT record_mode
    TEXT default_owner_id
    TEXT metadata_JSON
    TEXT updated_at
  }

  ENTITIES ||--o{ ENTITY_EVENTS : "entity_id FK"
  MEMORY_EVENTS ||--o{ ENTITY_EVENTS : "event_id FK"
  MEMORY_EVENTS ||--o{ MEMORY_OPEN_FACTS : "event_id FK, cascade"
  MEMORY_EVENTS ||--o{ CAUSAL_CHAINS : "cause_event_id FK"
  MEMORY_EVENTS ||--o{ CAUSAL_CHAINS : "effect_event_id FK"
  FAMILIES ||--o{ FAMILY_MEMBERS : "family_id FK, cascade"
  FAMILIES ||--o{ MEMBER_ALIASES : "family_id FK, cascade"
  FAMILY_MEMBERS ||--o{ MEMBER_ALIASES : "member_id FK, cascade"
  FAMILIES ||--o{ SPEAKER_PROFILES : "family_id FK, cascade"
  FAMILY_MEMBERS ||--o{ SPEAKER_PROFILES : "self_member_id FK, set null"
  FAMILIES ||--|| FAMILY_SETTINGS : "family_id PK/FK, cascade"

  MEMORY_EVENTS ||--o{ MEMORY_EVENTS_FTS : "rowid content index, not FK"
  DAILY_ARCHIVES }o--o{ CONVERSATION_TURNS : "source_turn_ids/archive_id weak"
  DAILY_ARCHIVES }o--o{ MEMORY_EVENTS : "event_ids/source_archive_id weak"
  DIARIES }o--o{ MEMORY_EVENTS : "event_ids JSON weak"
  PIPELINE_STATUS }o--o{ MEMORY_EVENTS : "message_id/raw_message_id weak"
  MEMORY_PROFILES }o--o{ DAILY_ARCHIVES : "owner_id/time range weak"
```

## 关系说明

数据库真正声明的外键只有这些：

| 子表 | 字段 | 父表 | 删除行为 |
| --- | --- | --- | --- |
| `entity_events` | `entity_id` | `entities.id` | 默认 |
| `entity_events` | `event_id` | `memory_events.id` | 默认 |
| `causal_chains` | `cause_event_id` | `memory_events.id` | 默认 |
| `causal_chains` | `effect_event_id` | `memory_events.id` | 默认 |
| `memory_open_facts` | `event_id` | `memory_events.id` | `ON DELETE CASCADE` |
| `family_members` | `family_id` | `families.id` | `ON DELETE CASCADE` |
| `member_aliases` | `family_id` | `families.id` | `ON DELETE CASCADE` |
| `member_aliases` | `member_id` | `family_members.id` | `ON DELETE CASCADE` |
| `speaker_profiles` | `family_id` | `families.id` | `ON DELETE CASCADE` |
| `speaker_profiles` | `self_member_id` | `family_members.id` | `ON DELETE SET NULL` |
| `family_settings` | `family_id` | `families.id` | `ON DELETE CASCADE` |

以下是逻辑引用或 JSON 弱关系，不是数据库外键，SQLite 不会自动校验或级联：

| 字段 | 弱关系含义 |
| --- | --- |
| `conversation_turns.archive_id` | 通常指向 `daily_archives.id`，用于标记 turn 已归档，但没有 FK。 |
| `daily_archives.source_turn_ids` | JSON 数组，保存参与归档的 `conversation_turns.id`。 |
| `daily_archives.event_ids` | JSON 数组，保存归档抽取出的 `memory_events.id`。 |
| `diaries.event_ids` | JSON 数组，保存日记或导入内容对应的事件 id。 |
| `memory_events.raw_message_id` | 管线输入 id，常与 `pipeline_status.message_id`、对话 turn id、导入批次 id 或归档 id 对齐。 |
| `memory_events.source_archive_id` | 归档抽取事件通常记录来源 `daily_archives.id`。 |
| `memory_events.user_id`、`conversation_turns.owner_id`、`daily_archives.owner_id`、`memory_open_facts.owner_id`、`memory_profiles.owner_id` | 同一个 owner 概念在不同表中的列名；没有统一 owner 表约束。 |
| `memory_events.entities` | JSON 数组；与 `entities`/`entity_events` 有冗余表达，但不是 FK。 |
| `memory_events.open_facts` | JSON 数组；与 `memory_open_facts` 是冗余/派生表达，不是 FK。 |
| `memory_open_facts.actor_id`、`experiencer_id`、`observer_id` | open fact 内部参与者标识；当前 schema 没有指向成员或实体表的 FK。 |
| `member_aliases.speaker_profile_id` | 当 `scope='speaker'` 时表示别名作用域，但当前 schema 没有 FK 到 `speaker_profiles.id`。 |
| `family_settings.default_owner_id` | 默认 owner 标识；当前 schema 没有 FK 到 `speaker_profiles` 或独立 owner 表。 |
| `pipeline_status.result`、`conversation_turns.metadata`、`memory_profiles.content`、`family_* .metadata` | JSON 文本，可能包含更多 id 或状态信息，均非 FK。 |

## 核心表用途

| 表 | 用途 | 关键约束/索引 |
| --- | --- | --- |
| `conversation_turns` | 当天持续对话和日志原文。 | `role` 限定为 `user/assistant/system`；索引 `idx_conversation_owner_date(owner_id, turn_date)`、`idx_conversation_archive(archive_id)`。 |
| `daily_archives` | owner 某天的日终归档结果。 | `UNIQUE(owner_id, archive_date)`；索引 `idx_daily_archives_owner_date(owner_id, archive_date)`。 |
| `memory_events` | 长期记忆事件事实主表。 | 主键 `id`；索引覆盖 `event_type`、`event_time`、`user_id`、`raw_message_id/event_index`、`user_id/event_date`、`source_archive_id`。 |
| `memory_open_facts` | 从事件中规范化出的 typed open facts。 | `event_id` 外键级联删除；索引 `event_id`、`owner_id/kind`、`value`。 |
| `entities` | 实体字典，按 `name` 去重。 | `name` 唯一；索引 `idx_entities_name(name)`。 |
| `entity_events` | 实体和事件的多对多关联。 | 复合主键 `(entity_id, event_id)`；两个字段均为 FK。 |
| `causal_chains` | 事件之间的因果或触发关系。 | `cause_event_id`、`effect_event_id` 都指向 `memory_events.id`。 |
| `diaries` | 导入日记或日终归档生成的日记文本。 | 索引 `idx_diaries_date(diary_date)`；`event_ids` 是 JSON 弱引用。 |
| `pipeline_status` | 记录每条管线输入的当前阶段、状态、错误和 JSON 结果。 | 主键 `message_id`；索引 `idx_pipeline_stage(stage, status)`。 |
| `memory_profiles` | L3 长期理解 / L2 近期状态画像快照。 | `layer` 限定为 `long_term/recent`；`UNIQUE(owner_id, layer)`。 |
| `families` | 家庭根实体。 | 主键 `id`。 |
| `family_members` | 家庭成员。 | `UNIQUE(family_id, label)`；`family_id` 级联到 `families`。 |
| `member_aliases` | 成员别名和称呼，支持全局或说话人作用域。 | `scope` 限定为 `global/speaker`；`family_id`、`member_id` 均级联。 |
| `speaker_profiles` | 外部平台用户和家庭成员的映射。 | `UNIQUE(platform, external_user_id)`；`self_member_id` 删除时置空。 |
| `family_settings` | 家庭配置。 | `family_id` 同时是 PK 和 FK；`record_mode` 限定为 `conservative/balanced/verbose`。 |

## `memory_events_fts`

`memory_events_fts` 是 SQLite FTS5 虚表，不是事实源。真实库中定义为：

- 列：`summary`、`original_text`、`tags`、`canonical_search_text`
- `content=memory_events`
- `content_rowid=rowid`
- tokenizer 当前为 `trigram`；代码会在不支持 `trigram` 时回退到 `unicode61`

它由三个触发器维护：

| 触发器 | 时机 | 作用 |
| --- | --- | --- |
| `memory_events_ai` | `AFTER INSERT ON memory_events` | 插入对应 FTS 行。 |
| `memory_events_ad` | `AFTER DELETE ON memory_events` | 向 FTS 写入 delete 指令。 |
| `memory_events_au` | `AFTER UPDATE ON memory_events` | 先删除旧 FTS 行，再插入新 FTS 行。 |

因此查询可以把 `memory_events_fts.rowid` 与 `memory_events.rowid` 对齐，但这不是外键关系，也不应把 FTS 表当作独立事实表修改。
