import type { Database } from "bun:sqlite";
import { buildCanonicalSearchText } from "../../domain/src/search-text";
import {
  EXTRACTOR_VERSION,
  SEARCH_TEXT_VERSION,
  VOCAB_VERSION,
} from "../../domain/src/provenance";

export type MemoryEventsFtsTokenizer = "trigram" | "unicode61";

export interface MemoryEventsFtsStatus {
  tokenizer: MemoryEventsFtsTokenizer;
  recreated: boolean;
  rebuilt: boolean;
  backfilledCanonicalRows: number;
  eventCount: number;
  ftsCount: number;
}

export function initSchema(db: Database): MemoryEventsFtsStatus {
  db.exec(`
    -- 记忆事件表（核心）
    CREATE TABLE IF NOT EXISTS memory_events (
      id TEXT PRIMARY KEY,
      raw_message_id TEXT,
      summary TEXT NOT NULL,
      original_text TEXT NOT NULL,
      event_type TEXT NOT NULL,
      entities TEXT NOT NULL DEFAULT '[]',
      emotion TEXT NOT NULL DEFAULT '{}',
      tags TEXT NOT NULL DEFAULT '[]',
      open_facts TEXT NOT NULL DEFAULT '[]',
      canonical_search_text TEXT NOT NULL DEFAULT '',
      event_index INTEGER,
      original_span TEXT,
      event_date TEXT DEFAULT NULL,
      extractor_version TEXT NOT NULL DEFAULT '${EXTRACTOR_VERSION}',
      vocab_version TEXT NOT NULL DEFAULT '${VOCAB_VERSION}',
      search_text_version TEXT NOT NULL DEFAULT '${SEARCH_TEXT_VERSION}',
      source_archive_id TEXT,
      location TEXT,
      event_time TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      source TEXT NOT NULL DEFAULT 'user',
      source_layer TEXT NOT NULL DEFAULT 'extracted',
      user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 实体表
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'person',
      aliases TEXT NOT NULL DEFAULT '[]',
      attributes TEXT NOT NULL DEFAULT '{}',
      first_seen TEXT,
      last_seen TEXT,
      mention_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 实体-事件关联
    CREATE TABLE IF NOT EXISTS entity_events (
      entity_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      role TEXT DEFAULT 'involved',
      PRIMARY KEY (entity_id, event_id),
      FOREIGN KEY (entity_id) REFERENCES entities(id),
      FOREIGN KEY (event_id) REFERENCES memory_events(id)
    );

    -- 因果链
    CREATE TABLE IF NOT EXISTS causal_chains (
      id TEXT PRIMARY KEY,
      cause_event_id TEXT NOT NULL,
      effect_event_id TEXT NOT NULL,
      relation_type TEXT NOT NULL DEFAULT 'triggers',
      strength REAL NOT NULL DEFAULT 0.5,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (cause_event_id) REFERENCES memory_events(id),
      FOREIGN KEY (effect_event_id) REFERENCES memory_events(id)
    );

    -- 日记表
    CREATE TABLE IF NOT EXISTS diaries (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      content TEXT NOT NULL,
      diary_date TEXT,
      source TEXT NOT NULL DEFAULT 'import',
      event_ids TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 当天持续对话原始记录
    CREATE TABLE IF NOT EXISTS conversation_turns (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      turn_date TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'chat',
      metadata TEXT NOT NULL DEFAULT '{}',
      archive_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 日终归档结果
    CREATE TABLE IF NOT EXISTS daily_archives (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      archive_date TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_turn_ids TEXT NOT NULL DEFAULT '[]',
      event_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'done',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner_id, archive_date)
    );

    -- 记忆理解画像快照（L3 长期理解 / L2 近期状态）：离线归纳预计算，在线只读最新一条。
    -- content 为 JSON，按 layer 区分结构（见 memory/profile-types.ts）。
    CREATE TABLE IF NOT EXISTS memory_profiles (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      layer TEXT NOT NULL CHECK(layer IN ('long_term', 'recent')),
      content TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      covers_from TEXT,
      covers_to TEXT,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      source_model TEXT,
      generated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner_id, layer)
    );

    -- 用户对长期理解的最终解释权。反馈独立于画像快照保存，重建不会覆盖用户选择。
    CREATE TABLE IF NOT EXISTS understanding_feedback (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      understanding_key TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('confirm', 'reject', 'retract', 'correct')),
      original_statement TEXT NOT NULL,
      replacement_statement TEXT,
      category TEXT NOT NULL,
      subject TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private', 'family')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner_id, understanding_key)
    );

    -- 管线状态
    CREATE TABLE IF NOT EXISTS pipeline_status (
      message_id TEXT PRIMARY KEY,
      stage TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      result TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_events_type ON memory_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_time ON memory_events(event_time);
    CREATE INDEX IF NOT EXISTS idx_events_user ON memory_events(user_id);
    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
    CREATE INDEX IF NOT EXISTS idx_diaries_date ON diaries(diary_date);
    CREATE INDEX IF NOT EXISTS idx_conversation_owner_date ON conversation_turns(owner_id, turn_date);
    CREATE INDEX IF NOT EXISTS idx_conversation_archive ON conversation_turns(archive_id);
    CREATE INDEX IF NOT EXISTS idx_daily_archives_owner_date ON daily_archives(owner_id, archive_date);
    CREATE INDEX IF NOT EXISTS idx_memory_profiles_owner_layer ON memory_profiles(owner_id, layer);
    CREATE INDEX IF NOT EXISTS idx_understanding_feedback_owner ON understanding_feedback(owner_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_pipeline_stage ON pipeline_status(stage, status);

    CREATE TABLE IF NOT EXISTS memory_open_facts (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      owner_id TEXT,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      surface TEXT NOT NULL,
      evidence_start INTEGER,
      evidence_end INTEGER,
      confidence REAL NOT NULL DEFAULT 0.75,
      polarity TEXT NOT NULL DEFAULT 'actual',
      actor_id TEXT,
      experiencer_id TEXT,
      observer_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (event_id) REFERENCES memory_events(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_open_facts_event ON memory_open_facts(event_id);
    CREATE INDEX IF NOT EXISTS idx_open_facts_owner_kind ON memory_open_facts(owner_id, kind);
    CREATE INDEX IF NOT EXISTS idx_open_facts_value ON memory_open_facts(value);
  `);

  ensureFamilyOnboardingSchema(db);
  ensureMediaSchema(db);
  ensureCareSchema(db);
  return ensureMemoryEventsFts(db);
}

/**
 * 跟进式关怀队列：离线预计算"该对这个人说的一句话"，在线只做查表投递。
 * kind: echo=相似旧事回声；concern=未闭环担忧的回访；anticipation=用户自述未来安排的事后跟进。
 * 状态机：pending →(微信搭便车/网页卡片消费) delivered / (用户关闭) closed / (过期) expired。
 * trigger_after/expires_at 为 ISO 时间或 YYYY-MM-DD（字符串比较即可，date-only 约等于当天早八点生效）。
 */
export function ensureCareSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_care (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('echo', 'concern', 'anticipation')),
      topic TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      source_event_id TEXT,
      related_event_ids TEXT NOT NULL DEFAULT '[]',
      trigger_after TEXT NOT NULL,
      expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'closed', 'expired')),
      delivered_at TEXT,
      delivered_via TEXT,
      closed_reason TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pending_care_owner_status ON pending_care(owner_id, status, trigger_after);
    CREATE INDEX IF NOT EXISTS idx_pending_care_source_event ON pending_care(source_event_id);

    -- 里程碑策展快照：候选事件由 LLM 离线做"负向过滤 + 同能力去重 + 标题提炼"后的结果。
    -- signature = 候选集指纹（数量+最新时间），变了才重建；content 为 JSON 数组。
    CREATE TABLE IF NOT EXISTS milestone_snapshots (
      owner_id TEXT PRIMARY KEY,
      content TEXT NOT NULL DEFAULT '[]',
      signature TEXT NOT NULL DEFAULT '',
      source_count INTEGER NOT NULL DEFAULT 0,
      curated INTEGER NOT NULL DEFAULT 0,
      generated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * 多媒体资产表：微信图片/语音/（未来）视频下载落地后的记录。
 * 设计为 kind 可扩展（image|voice|video），原始 source_url（微信 PicUrl）几天后会失效，
 * 故必须及时下载到 local_path 持久化；caption 是 vision 转写出的中文描述，
 * 通过 message_id 关联到它生成的对话 turn / 记忆事件。
 */
export function ensureMediaSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_assets (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      kind TEXT NOT NULL DEFAULT 'image',
      source_platform TEXT,
      source_url TEXT,
      source_media_id TEXT,
      local_path TEXT NOT NULL,
      mime TEXT,
      bytes INTEGER,
      sha256 TEXT,
      caption TEXT,
      message_id TEXT,
      status TEXT NOT NULL DEFAULT 'stored',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_media_owner ON media_assets(owner_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_media_message ON media_assets(message_id);
    CREATE INDEX IF NOT EXISTS idx_media_sha ON media_assets(sha256);
  `);
}

export function ensureMemoryEventsFts(
  db: Database,
  options: { forceRecreate?: boolean; forceRebuild?: boolean } = {},
): MemoryEventsFtsStatus {
  ensureMemoryEventsColumns(db);
  ensureMemoryEventsIndexes(db);

  const tokenizer = chooseMemoryEventsFtsTokenizer(db);
  const existing = getMemoryEventsFtsInfo(db);
  const triggersNeedRefresh = memoryEventsFtsTriggersNeedRefresh(db);
  const shouldRecreate = Boolean(
    options.forceRecreate ||
    !existing.exists ||
    !existing.isFts5 ||
    existing.tokenizer !== tokenizer ||
    !existing.hasExpectedColumns,
  );

  let recreated = false;
  let rebuilt = false;
  let backfilledCanonicalRows = 0;

  db.exec("BEGIN");
  try {
    dropMemoryEventsFtsTriggers(db);
    backfilledCanonicalRows = backfillCanonicalSearchText(db);

    if (shouldRecreate) {
      db.exec("DROP TABLE IF EXISTS memory_events_fts");
      createMemoryEventsFtsTable(db, tokenizer);
      recreated = true;
    }

    createMemoryEventsFtsTriggers(db);

    if (recreated || options.forceRebuild || triggersNeedRefresh || backfilledCanonicalRows > 0) {
      rebuildMemoryEventsFtsIndex(db);
      rebuilt = true;
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    tokenizer,
    recreated,
    rebuilt,
    backfilledCanonicalRows,
    eventCount: countRows(db, "memory_events"),
    ftsCount: countRows(db, "memory_events_fts"),
  };
}

export function rebuildMemoryEventsFts(db: Database): MemoryEventsFtsStatus {
  return ensureMemoryEventsFts(db, { forceRecreate: true, forceRebuild: true });
}

export function ensureFamilyOnboardingSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS families (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS family_members (
      id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL,
      label TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      birth_date TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(family_id, label),
      FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS member_aliases (
      id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global', 'speaker')),
      speaker_profile_id TEXT,
      relation TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE,
      FOREIGN KEY (member_id) REFERENCES family_members(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS speaker_profiles (
      id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'weixin',
      external_user_id TEXT NOT NULL,
      self_member_id TEXT,
      display_name TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(platform, external_user_id),
      FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE,
      FOREIGN KEY (self_member_id) REFERENCES family_members(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS family_settings (
      family_id TEXT PRIMARY KEY,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      record_mode TEXT NOT NULL DEFAULT 'conservative' CHECK(record_mode IN ('conservative', 'balanced', 'verbose')),
      default_owner_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_family_members_family ON family_members(family_id);
    CREATE INDEX IF NOT EXISTS idx_member_aliases_family_alias ON member_aliases(family_id, alias);
    CREATE INDEX IF NOT EXISTS idx_member_aliases_member ON member_aliases(member_id);
    CREATE INDEX IF NOT EXISTS idx_speaker_profiles_family ON speaker_profiles(family_id);
    CREATE INDEX IF NOT EXISTS idx_speaker_profiles_external ON speaker_profiles(platform, external_user_id);

    -- 一次性凭证：家庭邀请码（purpose='invite'）与网页登录暗号（purpose='web_login'）共用一张表。
    -- family_id 在 invite 时指向目标家庭；web_login 时认领后回填。
    CREATE TABLE IF NOT EXISTS verification_codes (
      code TEXT PRIMARY KEY,
      purpose TEXT NOT NULL DEFAULT 'invite' CHECK(purpose IN ('invite', 'web_login')),
      family_id TEXT,
      created_by TEXT,
      expires_at TEXT NOT NULL,
      claimed_by_openid TEXT,
      claimed_by_platform TEXT,
      claimed_at TEXT,
      used_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_verification_codes_expires ON verification_codes(expires_at);

    -- 网页登录会话：网页暗号被公众号认领后签发，默认 1 年有效。
    CREATE TABLE IF NOT EXISTS web_sessions (
      token TEXT PRIMARY KEY,
      platform TEXT NOT NULL DEFAULT 'weixin',
      external_user_id TEXT NOT NULL,
      family_id TEXT,
      owner_id TEXT,
      expires_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_web_sessions_external ON web_sessions(platform, external_user_id);
  `);
}

function ensureMemoryEventsColumns(db: Database) {
  const columns = db.prepare("PRAGMA table_info(memory_events)").all() as Array<{ name: string }>;
  const names = new Set(columns.map(column => column.name));

  if (!names.has("canonical_search_text")) {
    db.exec("ALTER TABLE memory_events ADD COLUMN canonical_search_text TEXT NOT NULL DEFAULT ''");
  }
  if (!names.has("open_facts")) {
    db.exec("ALTER TABLE memory_events ADD COLUMN open_facts TEXT NOT NULL DEFAULT '[]'");
  }
  if (!names.has("event_index")) {
    db.exec("ALTER TABLE memory_events ADD COLUMN event_index INTEGER");
  }
  if (!names.has("original_span")) {
    db.exec("ALTER TABLE memory_events ADD COLUMN original_span TEXT");
  }
  if (!names.has("event_date")) {
    db.exec("ALTER TABLE memory_events ADD COLUMN event_date TEXT DEFAULT NULL");
  }
  if (!names.has("extractor_version")) {
    db.exec("ALTER TABLE memory_events ADD COLUMN extractor_version TEXT NOT NULL DEFAULT 'legacy'");
  }
  if (!names.has("vocab_version")) {
    db.exec("ALTER TABLE memory_events ADD COLUMN vocab_version TEXT NOT NULL DEFAULT 'legacy'");
  }
  if (!names.has("search_text_version")) {
    db.exec("ALTER TABLE memory_events ADD COLUMN search_text_version TEXT NOT NULL DEFAULT 'legacy'");
  }
  if (!names.has("source_archive_id")) {
    db.exec("ALTER TABLE memory_events ADD COLUMN source_archive_id TEXT");
  }

  backfillMemoryEventsProvenanceColumns(db);
}

function ensureMemoryEventsIndexes(db: Database) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_raw_index ON memory_events(raw_message_id, event_index);
    CREATE INDEX IF NOT EXISTS idx_events_user_date ON memory_events(user_id, event_date);
    CREATE INDEX IF NOT EXISTS idx_events_source_archive ON memory_events(source_archive_id);
    CREATE INDEX IF NOT EXISTS idx_events_open_facts_expr ON memory_events(open_facts);
  `);
}

function backfillMemoryEventsProvenanceColumns(db: Database) {
  db.exec(`
    UPDATE memory_events
    SET
      event_date = COALESCE(
        NULLIF(event_date, ''),
        date(event_time),
        date(created_at, 'localtime'),
        substr(event_time, 1, 10),
        substr(created_at, 1, 10),
        date('now')
      ),
      original_span = COALESCE(NULLIF(original_span, ''), original_text, summary),
      extractor_version = COALESCE(NULLIF(extractor_version, ''), 'legacy'),
      vocab_version = COALESCE(NULLIF(vocab_version, ''), 'legacy'),
      search_text_version = COALESCE(NULLIF(search_text_version, ''), 'legacy')
    WHERE
      event_date IS NULL
      OR event_date = ''
      OR original_span IS NULL
      OR original_span = ''
      OR extractor_version = ''
      OR vocab_version = ''
      OR search_text_version = ''
  `);
}

function chooseMemoryEventsFtsTokenizer(db: Database): MemoryEventsFtsTokenizer {
  return isFtsTokenizerAvailable(db, "trigram") ? "trigram" : "unicode61";
}

function isFtsTokenizerAvailable(db: Database, tokenizer: MemoryEventsFtsTokenizer): boolean {
  const tableName = `__fts_tokenizer_probe_${tokenizer}_${Date.now().toString(36)}`;
  try {
    db.exec(`CREATE VIRTUAL TABLE temp.${tableName} USING fts5(value, tokenize='${tokenizer}')`);
    return true;
  } catch {
    return false;
  } finally {
    try {
      db.exec(`DROP TABLE IF EXISTS temp.${tableName}`);
    } catch {
      // Ignore cleanup failures for a temp probe table.
    }
  }
}

function getMemoryEventsFtsInfo(db: Database): {
  exists: boolean;
  isFts5: boolean;
  tokenizer: MemoryEventsFtsTokenizer | "unknown";
  hasExpectedColumns: boolean;
} {
  const table = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'memory_events_fts'
  `).get() as { sql?: string } | undefined;

  if (!table?.sql) {
    return { exists: false, isFts5: false, tokenizer: "unknown", hasExpectedColumns: false };
  }

  const columns = db.prepare("PRAGMA table_info(memory_events_fts)").all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map(column => column.name));
  const expected = ["summary", "original_text", "tags", "canonical_search_text"];

  return {
    exists: true,
    isFts5: /USING\s+fts5/i.test(table.sql),
    tokenizer: inferFtsTokenizer(table.sql),
    hasExpectedColumns: expected.every(column => columnNames.has(column)),
  };
}

function inferFtsTokenizer(sql: string): MemoryEventsFtsTokenizer | "unknown" {
  const normalized = sql.toLowerCase().replace(/\s+/g, " ");
  if (/tokenize\s*=\s*['"]?trigram['"]?/.test(normalized)) return "trigram";
  if (/tokenize\s*=\s*['"]?unicode61['"]?/.test(normalized)) return "unicode61";
  return "unknown";
}

function memoryEventsFtsTriggersNeedRefresh(db: Database): boolean {
  const rows = db.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'trigger'
      AND name IN ('memory_events_ai', 'memory_events_ad', 'memory_events_au')
  `).all() as Array<{ name: string; sql?: string }>;
  if (rows.length !== 3) return true;
  return rows.some(row => !row.sql?.includes("canonical_search_text"));
}

function dropMemoryEventsFtsTriggers(db: Database) {
  db.exec(`
    DROP TRIGGER IF EXISTS memory_events_ai;
    DROP TRIGGER IF EXISTS memory_events_ad;
    DROP TRIGGER IF EXISTS memory_events_au;
  `);
}

function createMemoryEventsFtsTable(db: Database, tokenizer: MemoryEventsFtsTokenizer) {
  db.exec(`
    CREATE VIRTUAL TABLE memory_events_fts USING fts5(
      summary,
      original_text,
      tags,
      canonical_search_text,
      content=memory_events,
      content_rowid=rowid,
      tokenize='${tokenizer}'
    );
  `);
}

function createMemoryEventsFtsTriggers(db: Database) {
  db.exec(`
    CREATE TRIGGER memory_events_ai AFTER INSERT ON memory_events BEGIN
      INSERT INTO memory_events_fts(rowid, summary, original_text, tags, canonical_search_text)
      VALUES (new.rowid, new.summary, new.original_text, new.tags, new.canonical_search_text);
    END;

    CREATE TRIGGER memory_events_ad AFTER DELETE ON memory_events BEGIN
      INSERT INTO memory_events_fts(memory_events_fts, rowid, summary, original_text, tags, canonical_search_text)
      VALUES ('delete', old.rowid, old.summary, old.original_text, old.tags, old.canonical_search_text);
    END;

    CREATE TRIGGER memory_events_au AFTER UPDATE ON memory_events BEGIN
      INSERT INTO memory_events_fts(memory_events_fts, rowid, summary, original_text, tags, canonical_search_text)
      VALUES ('delete', old.rowid, old.summary, old.original_text, old.tags, old.canonical_search_text);
      INSERT INTO memory_events_fts(rowid, summary, original_text, tags, canonical_search_text)
      VALUES (new.rowid, new.summary, new.original_text, new.tags, new.canonical_search_text);
    END;
  `);
}

function rebuildMemoryEventsFtsIndex(db: Database) {
  db.exec("INSERT INTO memory_events_fts(memory_events_fts) VALUES('rebuild')");
}

function backfillCanonicalSearchText(db: Database): number {
  const rows = db.prepare(`
    SELECT rowid, summary, original_text, event_type, entities, emotion, tags, user_id
    FROM memory_events
    WHERE canonical_search_text IS NULL OR trim(canonical_search_text) = ''
  `).all() as Array<{
    rowid: number;
    summary?: string;
    original_text?: string;
    event_type?: string;
    entities?: string;
    emotion?: string;
    tags?: string;
    user_id?: string;
  }>;

  if (rows.length === 0) return 0;

  const update = db.prepare("UPDATE memory_events SET canonical_search_text = ? WHERE rowid = ?");
  for (const row of rows) {
    update.run(buildCanonicalSearchText({
      summary: row.summary,
      original_text: row.original_text,
      event_type: row.event_type,
      entities: parseJsonArray(row.entities),
      tags: parseJsonArray(row.tags),
      emotion: parseJsonObject(row.emotion) as { primary?: string; secondary?: string; valence?: string },
      user_id: row.user_id,
    }), row.rowid);
  }

  return rows.length;
}

function parseJsonArray(value?: string): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value?: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function countRows(db: Database, table: "memory_events" | "memory_events_fts"): number {
  return (db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number }).count;
}
