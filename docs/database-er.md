# 数据库表关系图

Schema 来源：

- 主 SQLite 库：`packages/db/src/schema.ts`
- 向量 sidecar 库：`packages/db/src/database.ts`

图例：

- 实线表示 SQLite schema 中声明的外键；`memory_events_fts` 例外，它是由触发器维护的 FTS5 content table。
- 虚线表示应用层引用：JSON ID 数组、同 owner 关联、跨库关联，数据库不会强制校验。
- `memory_events.user_id` 是历史列名，实际语义等同 API 层的 `owner_id`。

## 主库

```mermaid
erDiagram
    memory_events {
      text id PK
      text raw_message_id
      text summary
      text original_text
      text event_type
      text entities
      text emotion
      text tags
      text open_facts
      text canonical_search_text
      text event_date
      text event_time
      text source_archive_id
      text user_id "owner_id semantics"
    }

    entities {
      text id PK
      text name UK
      text type
      text aliases
      text attributes
      integer mention_count
    }

    entity_events {
      text entity_id PK, FK
      text event_id PK, FK
      text role
    }

    causal_chains {
      text id PK
      text cause_event_id FK
      text effect_event_id FK
      text relation_type
      real strength
    }

    memory_open_facts {
      text id PK
      text event_id FK
      text owner_id
      text kind
      text value
      text surface
      text actor_id
      text experiencer_id
      text observer_id
    }

    memory_events_fts {
      text summary
      text original_text
      text tags
      text canonical_search_text
    }

    conversation_turns {
      text id PK
      text owner_id
      text role
      text content
      text turn_date
      text metadata
      text archive_id
    }

    daily_archives {
      text id PK
      text owner_id
      text archive_date
      text summary
      text source_turn_ids "JSON array"
      text event_ids "JSON array"
      text status
    }

    diaries {
      text id PK
      text user_id "owner_id semantics"
      text content
      text diary_date
      text source
      text event_ids "JSON array"
    }

    memory_profiles {
      text id PK
      text owner_id
      text layer
      text content
      integer version
      text covers_from
      text covers_to
      integer evidence_count
    }

    pipeline_status {
      text message_id PK
      text stage
      text status
      text result
    }

    families {
      text id PK
      text name
    }

    family_members {
      text id PK
      text family_id FK
      text label
      text role
      text birth_date
      text metadata
    }

    member_aliases {
      text id PK
      text family_id FK
      text member_id FK
      text alias
      text scope
      text speaker_profile_id
      text relation
    }

    speaker_profiles {
      text id PK
      text family_id FK
      text platform
      text external_user_id
      text self_member_id FK
      text display_name
      text metadata
    }

    family_settings {
      text family_id PK, FK
      text timezone
      text record_mode
      text default_owner_id
      text metadata
    }

    entities ||--o{ entity_events : entity_id
    memory_events ||--o{ entity_events : event_id
    memory_events ||--o{ causal_chains : cause_event_id
    memory_events ||--o{ causal_chains : effect_event_id
    memory_events ||--o{ memory_open_facts : event_id
    memory_events ||--|| memory_events_fts : "content rowid"

    daily_archives ||..o{ conversation_turns : "archive_id / source_turn_ids"
    daily_archives ||..o{ memory_events : source_archive_id
    daily_archives ||..o{ diaries : "daily:{archive_id}"
    daily_archives ||..o{ memory_events : "event_ids JSON"
    diaries ||..o{ memory_events : "event_ids JSON"
    pipeline_status ||..o{ memory_events : raw_message_id

    families ||--o{ family_members : family_id
    families ||--o{ member_aliases : family_id
    family_members ||--o{ member_aliases : member_id
    families ||--o{ speaker_profiles : family_id
    family_members ||--o{ speaker_profiles : self_member_id
    families ||--o| family_settings : family_id
    speaker_profiles ||..o{ member_aliases : speaker_profile_id
```

## 向量 Sidecar 库

`memory_embeddings` 位于向量 sidecar 库中，默认文件是 `xfeel.vec.db`。它和主库分离，因此它到 `memory_events` 的关系由应用代码维护，不是 SQLite 外键。

```mermaid
erDiagram
    memory_events {
      text id PK
      text user_id "owner_id semantics"
      text summary
      text event_type
      text open_facts
      text tags
      text entities
      text location
    }

    memory_embeddings {
      text id PK
      text owner_id
      text target_type "event|fact|tag|entity|location"
      text target_id "memory_events.id"
      text fact_kind
      text embedding_model
      integer embedding_dim
      text embedding_text
      text embedding_json
      blob embedding_blob
      text source_updated_at
    }

    memory_events ||..o{ memory_embeddings : target_id
```

embedding 单元的 ID 由事件 ID 派生，例如：

- `${event_id}:event`
- `${event_id}:fact:${stable_key}`
- `${event_id}:tag:${stable_key}`
- `${event_id}:entity:${stable_key}`
- `${event_id}:location:${stable_key}`
