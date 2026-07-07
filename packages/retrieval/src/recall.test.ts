import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDB, closeEmbeddingDB, getDB } from "../../db/src/database";
import { initSchema } from "../../db/src/schema";
import { ftsBm25Boost, recall, recallHybrid } from "./recall";

const DAD = "demo-dad-owner";
const MOM = "demo-mom-owner";

describe("recall", () => {
  let dbPath = "";
  const originalVecPath = process.env.XFEEL_VEC_DB_PATH;

  beforeEach(() => {
    closeEmbeddingDB();
    closeDB();
    dbPath = join(tmpdir(), `xfeel-recall-${crypto.randomUUID()}.db`);
    const db = getDB(dbPath);
    initSchema(db);
  });

  afterEach(() => {
    closeEmbeddingDB();
    closeDB();
    if (originalVecPath === undefined) delete process.env.XFEEL_VEC_DB_PATH;
    else process.env.XFEEL_VEC_DB_PATH = originalVecPath;
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });

  test("matches Chinese semantic terms from stored canonical_search_text", () => {
    seedEvent({ id: "walk", canonical_search_text: "走路", event_time: "2026-06-10T09:00:00.000Z" });
    seedEvent({ id: "vaccine", canonical_search_text: "疫苗", event_time: "2026-06-11T09:00:00.000Z" });
    seedEvent({ id: "solids", canonical_search_text: "辅食", event_time: "2026-06-12T09:00:00.000Z" });
    seedEvent({ id: "decoy", canonical_search_text: "积木", event_time: "2026-06-13T09:00:00.000Z" });

    expect(recall({ owner_id: DAD, text: "大运动", limit: 1 }).events[0]?.id).toBe("walk");
    expect(recall({ owner_id: DAD, text: "打针", limit: 1 }).events[0]?.id).toBe("vaccine");
    expect(recall({ owner_id: DAD, text: "吃东西", limit: 1 }).events[0]?.id).toBe("solids");
  });

  test("uses expansion aliases for Chinese phrases before scoring", () => {
    seedEvent({
      id: "vomit-diarrhea",
      canonical_search_text: "呕吐 腹泻 拉肚子 宝宝们 妈妈",
      event_type: "health",
      entities: ["宝宝们", "妈妈"],
      tags: ["呕吐", "腹泻"],
      event_time: "2026-06-10T09:00:00.000Z",
    });
    seedEvent({
      id: "newer-decoy",
      canonical_search_text: "普通记录",
      event_type: "daily",
      event_time: "2026-06-13T09:00:00.000Z",
    });

    const noExpansion = recall({ owner_id: DAD, text: "上吐下泻", limit: 2 }, { expansion: false });
    expect(noExpansion.events.map(event => event.id)).toContain("vomit-diarrhea");
    expect(recall({ owner_id: DAD, text: "上吐下泻", limit: 1 }, { expansion: true }).events[0]?.id).toBe("vomit-diarrhea");
  });

  test("merges FTS and stored-text candidates before ranking semantic multi-term matches", () => {
    for (let i = 1; i <= 8; i++) {
      seedEvent({
        id: `feeling-${i}`,
        canonical_search_text: `焦虑 情绪 爸爸 ${i}`,
        event_type: "emotion",
        entities: ["爸爸"],
        tags: ["情绪"],
        event_time: `2026-06-1${i}T09:00:00.000Z`,
      });
    }
    seedEvent({
      id: "specific-work",
      canonical_search_text: "停止折腾代理 去干具体工作 压力 焦虑 爸爸 工作 育儿压力",
      event_type: "work",
      entities: ["爸爸"],
      tags: ["育儿压力"],
      event_time: "2026-06-09T09:00:00.000Z",
    });

    expect(recall({ owner_id: DAD, text: "爸爸折腾代理压力焦虑，想去干具体工作", limit: 1 }, { expansion: true }).events[0]?.id).toBe("specific-work");
  });

  test("ranks concrete query literal coverage above broad structural decoys", () => {
    for (let i = 1; i <= 5; i++) {
      seedEvent({
        id: `newer-walk-decoy-${i}`,
        canonical_search_text: `走路 宝宝们 爸爸 里程碑 ${i}`,
        event_type: "milestone",
        entities: ["宝宝们", "爸爸"],
        tags: ["走路"],
        event_time: `2026-06-1${i}T09:00:00.000Z`,
      });
    }
    seedEvent({
      id: "literal-walk-target",
      canonical_search_text: "小朋友们今天走路上学 一边走一边摸路灯杆子 捡树叶 挖坑 伴侣昵称很累 爸爸 宝宝们 走路 育儿压力",
      event_type: "milestone",
      entities: ["宝宝们", "爸爸"],
      tags: ["走路", "育儿压力"],
      event_time: "2026-06-09T09:00:00.000Z",
    });

    expect(recall({ owner_id: DAD, text: "小朋友走路上学，摸路灯杆子捡树叶", limit: 1 }, { expansion: true }).events[0]?.id).toBe("literal-walk-target");
  });

  test("segments travel and play phrases into useful aliases", () => {
    seedEvent({
      id: "japan-typhoon",
      canonical_search_text: "日本之行 航班被取消 改签 天气",
      event_type: "daily",
      event_time: "2026-06-10T09:00:00.000Z",
    });
    seedEvent({
      id: "magnetic-tiles",
      canonical_search_text: "玩具 亲子互动 早教",
      event_type: "care",
      event_time: "2026-06-11T09:00:00.000Z",
    });

    expect(recall({ owner_id: DAD, text: "日本台风航班取消", limit: 1 }, { expansion: true }).events[0]?.id).toBe("japan-typhoon");
    expect(recall({ owner_id: DAD, text: "磁力片", limit: 1 }, { expansion: true }).events[0]?.id).toBe("magnetic-tiles");
  });

  test("keeps owner_id as a hard filter when fallback relaxes other filters", () => {
    seedEvent({
      id: "dad-unrelated",
      canonical_search_text: "睡眠",
      event_type: "sleep",
      entities: ["星星"],
      emotion: { primary: "疲惫", valence: "negative", intensity: 0.6 },
      user_id: DAD,
      event_time: "2026-06-12T09:00:00.000Z",
    });
    seedEvent({
      id: "mom-vaccine",
      canonical_search_text: "疫苗",
      event_type: "health",
      entities: ["妈妈"],
      emotion: { primary: "开心", valence: "positive", intensity: 0.5 },
      user_id: MOM,
      event_time: "2026-06-13T09:00:00.000Z",
    });

    const result = recall({
      owner_id: DAD,
      text: "打针",
      entities: ["妈妈"],
      event_types: ["health"],
      valence: "positive",
      limit: 10,
    });

    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every(event => event.user_id === DAD)).toBe(true);
    expect(result.events.map(event => event.id)).not.toContain("mom-vaccine");
  });

  test("keeps owner_id as a hard filter under expansion", () => {
    seedEvent({
      id: "dad-decoy",
      canonical_search_text: "普通记录",
      event_type: "daily",
      user_id: DAD,
      event_time: "2026-06-12T09:00:00.000Z",
    });
    seedEvent({
      id: "mom-expanded-hit",
      canonical_search_text: "日本之行 航班被取消 改签 台风",
      event_type: "other",
      user_id: MOM,
      event_time: "2026-06-13T09:00:00.000Z",
    });

    const result = recall({ owner_id: DAD, text: "日本台风航班取消", limit: 10 }, { expansion: true });

    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every(event => event.user_id === DAD)).toBe(true);
    expect(result.events.map(event => event.id)).not.toContain("mom-expanded-hit");
  });

  test("family scope fans out recall across member pools", () => {
    // 爸爸记的家庭事
    seedEvent({
      id: "dad-recorded-kid",
      canonical_search_text: "阿星 发烧 看医生",
      event_type: "health",
      user_id: DAD,
      entities: ["阿星"],
      event_time: "2026-06-12T09:00:00.000Z",
    });
    // 无关的旁人池（不在 scope 内）
    seedEvent({
      id: "stranger-decoy",
      canonical_search_text: "阿星 发烧 看医生",
      event_type: "health",
      user_id: "stranger-owner",
      entities: ["阿星"],
      event_time: "2026-06-13T09:00:00.000Z",
    });

    // 妈妈提问，scope 含爸爸妈妈两个池 → 能召回到爸爸记的，但不会越界到 stranger
    const result = recall({ owner_id: MOM, scope_owner_ids: [MOM, DAD], text: "阿星上次发烧", limit: 10 });
    const ids = result.events.map(e => e.id);
    expect(ids).toContain("dad-recorded-kid");
    expect(ids).not.toContain("stranger-decoy");
  });

  test("without scope, recall stays scoped to the single speaker pool", () => {
    seedEvent({ id: "dad-only", canonical_search_text: "阿星 发烧 看医生", user_id: DAD, entities: ["阿星"], event_time: "2026-06-12T09:00:00.000Z" });
    seedEvent({ id: "mom-only", canonical_search_text: "阿星 发烧 看医生", user_id: MOM, entities: ["阿星"], event_time: "2026-06-13T09:00:00.000Z" });

    const result = recall({ owner_id: MOM, text: "阿星上次发烧", limit: 10 });
    expect(result.events.every(e => e.user_id === MOM)).toBe(true);
    expect(result.events.map(e => e.id)).not.toContain("dad-only");
  });

  test("self pool outranks family pool on equal matches", () => {
    // 两条近似匹配：妈妈自己记的 + 爸爸记的；说话人=妈妈，自己池应排前
    seedEvent({ id: "mom-self", canonical_search_text: "阿星 发烧 看医生", user_id: MOM, entities: ["阿星"], event_time: "2026-06-12T09:00:00.000Z" });
    seedEvent({ id: "dad-shared", canonical_search_text: "阿星 发烧 看医生", user_id: DAD, entities: ["阿星"], event_time: "2026-06-12T09:00:00.000Z" });

    const result = recall({ owner_id: MOM, scope_owner_ids: [MOM, DAD], text: "阿星上次发烧", limit: 10 });
    expect(result.events[0]?.id).toBe("mom-self");
    expect(result.events.map(e => e.id)).toContain("dad-shared");
  });

  test("uses type hints as boosts, not filters", () => {
    seedEvent({
      id: "daily-travel",
      canonical_search_text: "日本之行 航班被取消 改签 台风",
      event_type: "daily",
      event_time: "2026-06-10T09:00:00.000Z",
    });

    const result = recall({ owner_id: DAD, text: "日本台风航班取消", limit: 10 }, { expansion: true });

    expect(result.diagnostics?.query_expansion.expansion?.typeHints).toContain("other");
    expect(result.events.map(event => event.id)).toContain("daily-travel");
  });

  test("does not make broad generic recall worse than no-expansion", () => {
    seedEvent({
      id: "older-specific",
      canonical_search_text: "睡眠 夜醒",
      event_type: "sleep",
      event_time: "2026-06-10T09:00:00.000Z",
    });
    seedEvent({
      id: "newer-status",
      canonical_search_text: "普通日常 状态稳定",
      event_type: "daily",
      event_time: "2026-06-13T09:00:00.000Z",
    });

    const baseline = recall({ owner_id: DAD, text: "宝宝最近怎么样", limit: 1 }, { expansion: false });
    const expanded = recall({ owner_id: DAD, text: "宝宝最近怎么样", limit: 1 }, { expansion: true });

    expect(expanded.events[0]?.id).toBe(baseline.events[0]?.id);
    expect(expanded.diagnostics?.query_expansion.expansion?.debug.matches).toEqual([]);
    expect(expanded.diagnostics?.query_expansion.expansion?.aliases).toEqual([]);
    expect(expanded.diagnostics?.query_expansion.expansion?.entityHints).toEqual([]);
  });

  test("does not let broad parent entity text outrank a specific semantic match", () => {
    for (let i = 1; i <= 5; i++) {
      seedEvent({
        id: `mom-generic-${i}`,
        canonical_search_text: `妈妈 普通日常 ${i}`,
        event_type: "daily",
        entities: ["妈妈"],
        event_time: `2026-06-1${i}T09:00:00.000Z`,
      });
    }
    seedEvent({
      id: "specific-fever",
      canonical_search_text: "发烧 咳嗽 感冒",
      event_type: "health",
      entities: ["星星"],
      tags: ["发烧"],
      event_time: "2026-06-09T09:00:00.000Z",
    });

    const result = recall({ owner_id: DAD, text: "妈妈 发烧", limit: 3 }, { expansion: true });

    expect(result.events[0]?.id).toBe("specific-fever");
    expect(result.diagnostics?.query_expansion.expansion?.entityHints).not.toContain("妈妈");
  });

  test("handles wildcard-like characters in expanded recall without broad LIKE matches", () => {
    seedEvent({
      id: "fever",
      canonical_search_text: "星星 发烧 咳嗽",
      event_type: "health",
      tags: ["发烧"],
      event_time: "2026-06-11T09:00:00.000Z",
    });
    for (let i = 1; i <= 4; i++) {
      seedEvent({
        id: `wildcard-decoy-${i}`,
        canonical_search_text: `普通记录 ${i}`,
        event_type: "daily",
        event_time: `2026-06-1${i}T10:00:00.000Z`,
      });
    }

    const result = recall({ owner_id: DAD, text: "\"*%_' 星星发烧", limit: 10 }, { expansion: true });

    expect(result.events.map(event => event.id)).toContain("fever");
    expect(result.events.filter(event => event.id?.startsWith("wildcard-decoy")).length).toBeLessThan(4);
  });

  test("date filters fall back to created_at when event_time and event_date are absent", () => {
    seedEvent({
      id: "created-date",
      canonical_search_text: "created date fallback",
      event_time: null,
      created_at: "2026-01-15T08:00:00.000Z",
    });
    seedEvent({
      id: "outside",
      canonical_search_text: "outside created date",
      event_time: null,
      created_at: "2026-01-16T08:00:00.000Z",
    });

    const result = recall({ owner_id: DAD, date_from: "2026-01-15", date_to: "2026-01-15", limit: 10 });
    expect(result.events.map(event => event.id)).toEqual(["created-date"]);
  });

  test("date filters interpret created_at fallback in local timezone", () => {
    seedEvent({
      id: "beijing-created-date",
      canonical_search_text: "beijing created date fallback",
      event_time: null,
      created_at: "2026-01-14T17:30:00.000Z",
    });

    const result = recall({ owner_id: DAD, date_from: "2026-01-15", date_to: "2026-01-15", limit: 10 });
    expect(result.events.map(event => event.id)).toEqual(["beijing-created-date"]);
  });

  test("converts stronger FTS bm25 matches into higher ranking boost", () => {
    expect(ftsBm25Boost(-0.000002)).toBeGreaterThan(ftsBm25Boost(-0.000001));
    expect(ftsBm25Boost(-0.5)).toBeGreaterThan(ftsBm25Boost(-0.000001));
    expect(ftsBm25Boost(0)).toBe(0);
    expect(ftsBm25Boost(0.25)).toBe(0);
  });

  test("hybrid recall degrades to lexical when vec db is unavailable", async () => {
    seedEvent({
      id: "lexical-only-hit",
      canonical_search_text: "lexical degrade token",
      event_time: "2026-06-13T09:00:00.000Z",
    });
    const badVecPath = join(tmpdir(), `xfeel-recall-vec-dir-${crypto.randomUUID()}`);
    mkdirSync(badVecPath, { recursive: true });
    process.env.XFEEL_VEC_DB_PATH = badVecPath;
    closeEmbeddingDB();

    try {
      const lexical = recall({ owner_id: DAD, text: "lexical degrade token", limit: 5 });
      const hybrid = await recallHybrid({
        owner_id: DAD,
        text: "lexical degrade token",
        limit: 5,
      }, {
        embeddingBaseUrl: "http://127.0.0.1:9",
      });

      expect(hybrid.events.map(event => event.id)).toEqual(lexical.events.map(event => event.id));
      expect(hybrid.total).toBe(lexical.total);
    } finally {
      closeEmbeddingDB();
      rmSync(badVecPath, { recursive: true, force: true });
    }
  });
});

function seedEvent(input: {
  id: string;
  canonical_search_text: string;
  event_time: string | null;
  created_at?: string;
  event_type?: string;
  entities?: string[];
  tags?: string[];
  emotion?: { primary: string; valence: string; intensity: number };
  user_id?: string;
}) {
  const db = getDB();
  db.prepare(`
    INSERT INTO memory_events (
      id,
      summary,
      original_text,
      event_type,
      entities,
      emotion,
      tags,
      canonical_search_text,
      event_time,
      created_at,
      user_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    "宝宝今天有一条普通记录",
    "今天状态正常，没有特别关键词。",
    input.event_type || "daily",
    JSON.stringify(input.entities || ["星星"]),
    JSON.stringify(input.emotion || { primary: "平静", valence: "neutral", intensity: 0.3 }),
    JSON.stringify(input.tags || []),
    input.canonical_search_text,
    input.event_time,
    input.created_at || "2026-06-10T09:00:00.000Z",
    input.user_id || DAD,
  );
}
