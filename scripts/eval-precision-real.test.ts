import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDB, getDB } from "../packages/db/src/database";
import { initSchema } from "../packages/db/src/schema";
import {
  loadPrecisionQuerySet,
  parseArgs,
  runPrecisionEval,
  type PrecisionQuerySet,
} from "./eval-precision-real";

const DAD = "demo-dad-owner";
const MOM = "demo-mom-owner";

describe("eval-precision-real", () => {
  let dbPath = "";

  beforeEach(() => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-precision-real-eval-${crypto.randomUUID()}.db`);
    const db = getDB(dbPath);
    initSchema(db);
  });

  afterEach(() => {
    closeDB();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });

  test("no-answer query with wildcard-like chars reports no heuristic false positive", async () => {
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

    closeDB();
    const output = await runPrecisionEval({
      dbPath,
      readonly: true,
      queryExpansion: true,
      querySet: oneCase({
        id: "wildcard-no-answer",
        category: "negative-no-answer",
        query: "%_ \"*' 幽灵病",
        owner_id: DAD,
        expected: {
          no_answer: true,
          owner_id: DAD,
          terms_any: ["幽灵病"],
          forbidden_terms_any: ["幽灵病"],
        },
      }),
    });

    expect(output.metrics.negative_cases).toBe(1);
    expect(output.metrics.false_positive_at_5).toBe(0);
    expect(output.metrics.no_answer_abstained_at_5).toBe(1);
    expect(output.cases[0]?.top_hits.every(hit => hit.assessment.false_positive === false)).toBe(true);
  });

  test("loose no-answer overlap is topical false positive, not leak false positive", async () => {
    seedEvent({
      id: "topical-overlap",
      canonical_search_text: "爸爸 幽灵病",
      event_type: "health",
      entities: ["爸爸"],
      tags: ["幽灵病"],
      user_id: DAD,
      event_time: "2026-06-13T09:00:00.000Z",
    });

    closeDB();
    const output = await runPrecisionEval({
      dbPath,
      readonly: true,
      queryExpansion: false,
      querySet: oneCase({
        id: "topical-no-answer",
        category: "negative-no-answer",
        query: "爸爸有没有幽灵病",
        owner_id: DAD,
        expected: {
          no_answer: true,
          owner_id: DAD,
          terms_any: ["幽灵病"],
        },
      }),
    });

    expect(output.metrics.false_positive_at_5).toBe(1);
    expect(output.metrics.leak_false_positive_at_5).toBe(0);
    expect(output.metrics.topical_false_positive_at_5).toBe(1);
    expect(output.cases[0]?.top_hits[0]?.assessment.matched).toContain("loose_no_answer_criteria");
    expect(output.cases[0]?.top_hits[0]?.assessment.leak_false_positive).toBe(false);
    expect(output.cases[0]?.top_hits[0]?.assessment.topical_false_positive).toBe(true);
  });

  test("wrong-owner similar event is excluded by the owner hard filter", async () => {
    seedEvent({
      id: "mom-similar-event",
      canonical_search_text: "火星托育中心 复查 妈妈",
      event_type: "health",
      entities: ["妈妈"],
      tags: ["复查"],
      user_id: MOM,
      event_time: "2026-06-13T09:00:00.000Z",
    });
    seedEvent({
      id: "dad-decoy",
      canonical_search_text: "爸爸 普通记录",
      event_type: "daily",
      entities: ["爸爸"],
      user_id: DAD,
      event_time: "2026-06-12T09:00:00.000Z",
    });

    closeDB();
    const output = await runPrecisionEval({
      dbPath,
      readonly: true,
      queryExpansion: true,
      querySet: oneCase({
        id: "wrong-owner",
        category: "negative-wrong-owner",
        query: "爸爸这边有没有火星托育中心复查",
        owner_id: DAD,
        expected: {
          no_answer: true,
          owner_id: DAD,
          terms_all: ["火星托育中心", "复查"],
          forbidden_owner_ids: [MOM],
        },
      }),
    });

    expect(output.metrics.owner_leak_count).toBe(0);
    expect(output.cases[0]?.top_hits.map(hit => hit.id)).not.toContain("mom-similar-event");
    expect(output.cases[0]?.top_hits.every(hit => hit.owner_id === DAD)).toBe(true);
    expect(output.metrics.false_positive_at_5).toBe(0);
    expect(output.metrics.leak_false_positive_at_5).toBe(0);
    expect(output.metrics.topical_false_positive_at_5).toBe(0);
  });

  test("mom-dizzy wrong-owner semantics only leak when owner scope is absent", async () => {
    seedEvent({
      id: "mom-dizzy-distinctive",
      canonical_search_text: "妈妈 头晕 地球在转",
      event_type: "health",
      entities: ["妈妈"],
      tags: ["头晕"],
      user_id: MOM,
      event_time: "2026-06-13T09:00:00.000Z",
    });
    seedEvent({
      id: "dad-common-dizzy",
      canonical_search_text: "爸爸 头晕",
      event_type: "health",
      entities: ["爸爸"],
      tags: ["头晕"],
      user_id: DAD,
      event_time: "2026-06-14T09:00:00.000Z",
    });

    const scopedCase = oneCase({
      id: "mom-dizzy-scoped",
      category: "negative-wrong-owner",
      query: "爸爸这边有没有妈妈那次头晕地球在转",
      owner_id: DAD,
      expected: {
        no_answer: true,
        owner_id: DAD,
        terms_all: ["头晕", "地球在转"],
        forbidden_owner_ids: [MOM],
      },
    });
    const unscopedCase = oneCase({
      id: "mom-dizzy-unscoped",
      category: "negative-wrong-owner",
      query: "妈妈那次头晕地球在转",
      expected: {
        no_answer: true,
        terms_all: ["头晕", "地球在转"],
        forbidden_owner_ids: [MOM],
      },
    });

    closeDB();
    const scoped = await runPrecisionEval({
      dbPath,
      readonly: true,
      queryExpansion: true,
      querySet: scopedCase,
    });
    const unscoped = await runPrecisionEval({
      dbPath,
      readonly: true,
      queryExpansion: true,
      querySet: unscopedCase,
    });

    expect(scoped.cases[0]?.top_hits.map(hit => hit.id)).not.toContain("mom-dizzy-distinctive");
    expect(scoped.metrics.owner_leak_count).toBe(0);
    expect(scoped.metrics.false_positive_at_5).toBe(0);
    expect(scoped.metrics.leak_false_positive_at_5).toBe(0);
    expect(scoped.metrics.topical_false_positive_at_5).toBe(0);

    const unscopedMomHit = unscoped.cases[0]?.top_hits.find(hit => hit.id === "mom-dizzy-distinctive");
    expect(unscopedMomHit?.assessment.false_positive).toBe(true);
    expect(unscopedMomHit?.assessment.leak_false_positive).toBe(true);
    expect(unscopedMomHit?.assessment.topical_false_positive).toBe(false);
    expect(unscoped.metrics.false_positive_at_5).toBe(1);
    expect(unscoped.metrics.leak_false_positive_at_5).toBe(1);
    expect(unscoped.metrics.topical_false_positive_at_5).toBe(0);
  });

  test("specific semantic row outranks parent-only generic rows with expansion disabled and enabled", async () => {
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

    const querySet = oneCase({
      id: "semantic-over-parent",
      category: "expansion-risk-parent-only",
      query: "妈妈 发烧",
      owner_id: DAD,
      expected: {
        owner_id: DAD,
        types_any: ["health"],
        tags_any: ["发烧"],
        terms_any: ["发烧"],
      },
    });

    closeDB();
    const baseline = await runPrecisionEval({ dbPath, readonly: true, queryExpansion: false, querySet });
    const expanded = await runPrecisionEval({ dbPath, readonly: true, queryExpansion: true, querySet });

    expect(baseline.cases[0]?.top_hits[0]?.id).toBe("specific-fever");
    expect(expanded.cases[0]?.top_hits[0]?.id).toBe("specific-fever");
    expect(baseline.metrics.precision_at_1).toBe(1);
    expect(expanded.metrics.precision_at_1).toBe(1);
  });

  test("computes precision, false-positive, generic diagnostics, and owner leaks", async () => {
    seedEvent({
      id: "specific-sleep",
      canonical_search_text: "夜醒 睡不好",
      event_type: "sleep",
      tags: ["夜醒"],
      event_time: "2026-06-11T09:00:00.000Z",
    });
    seedEvent({
      id: "generic-daily",
      canonical_search_text: "宝宝 普通日常",
      event_type: "daily",
      event_time: "2026-06-12T09:00:00.000Z",
    });

    closeDB();
    const output = await runPrecisionEval({
      dbPath,
      readonly: true,
      queryExpansion: false,
      querySet: {
        version: 1,
        cases: [
          {
            id: "positive",
            query: "夜醒",
            owner_id: DAD,
            expected: {
              owner_id: DAD,
              types_any: ["sleep"],
              tags_any: ["夜醒"],
              terms_any: ["夜醒"],
            },
          },
          {
            id: "negative",
            query: "不存在的量子事件",
            owner_id: DAD,
            expected: {
              no_answer: true,
              owner_id: DAD,
              terms_any: ["不存在的量子事件"],
              forbidden_terms_any: ["不存在的量子事件"],
            },
          },
          {
            id: "generic",
            query: "宝宝最近怎么样",
            owner_id: DAD,
            expected: {
              generic: true,
              owner_id: DAD,
            },
          },
        ],
      },
    });

    expect(output.metrics.total_cases).toBe(3);
    expect(output.metrics.positive_cases).toBe(1);
    expect(output.metrics.negative_cases).toBe(1);
    expect(output.metrics.generic_cases).toBe(1);
    expect(output.metrics.precision_at_1).toBe(1);
    expect(output.metrics.false_positive_at_5).toBe(0);
    expect(output.metrics.leak_false_positive_at_5).toBe(0);
    expect(output.metrics.topical_false_positive_at_5).toBe(0);
    expect(output.generic_diagnostics.cases).toBe(1);
    expect(output.generic_diagnostics.top1_owner_match_count).toBe(1);
    expect(output.metrics.owner_leak_count).toBe(0);
  });

  test("parses precision CLI flags", () => {
    const args = parseArgs([
      "--query-file",
      "custom.json",
      "--no-expansion",
      "--candidate-limit",
      "baseline",
      "--k",
      "3",
      "--allow-empty",
      "--mode",
      "hybrid",
    ], {});

    expect(args.queryFile).toBe("custom.json");
    expect(args.queryExpansion).toBe(false);
    expect(args.candidateLimitMode).toBe("baseline");
    expect(args.k).toBe(5);
    expect(args.allowEmpty).toBe(true);
    expect(args.mode).toBe("hybrid");
    expect(() => parseArgs(["--candidate-limit", "wide"], {})).toThrow(/candidate-limit/);
    expect(() => parseArgs(["--mode", "wide"], {})).toThrow(/--mode/);
  });

  test("runs read-only and does not mutate fixture rows", async () => {
    seedEvent({
      id: "readonly-row",
      canonical_search_text: "readonly precision token",
      event_type: "daily",
      event_time: "2026-06-10T09:00:00.000Z",
    });
    const before = countMemoryEvents(dbPath);

    closeDB();
    const output = await runPrecisionEval({
      dbPath,
      readonly: true,
      querySet: oneCase({
        id: "readonly",
        query: "readonly precision token",
        owner_id: DAD,
        expected: {
          owner_id: DAD,
          types_any: ["daily"],
          terms_any: ["readonly precision token"],
        },
      }),
    });

    expect(output.readonly).toBe(true);
    expect(output.metrics.precision_at_1).toBe(1);
    expect(countMemoryEvents(dbPath)).toBe(before);

    closeDB();
    const db = getDB(dbPath, { readonly: true, create: false });
    expect(() => db.prepare(`
      INSERT INTO memory_events (id, summary, original_text, event_type, entities, emotion, tags, user_id)
      VALUES ('should-fail', 'x', 'x', 'daily', '[]', '{}', '[]', ?)
    `).run(DAD)).toThrow();
  });

  test("loads the real precision query fixture with required safety categories", () => {
    const querySet = loadPrecisionQuerySet("data/eval/precision-real-queries.json");
    const categories = new Set(querySet.cases.map(item => item.category));

    expect(querySet.cases.length).toBeGreaterThanOrEqual(16);
    expect(categories.has("generic-broad")).toBe(true);
    expect(categories.has("negative-no-answer")).toBe(true);
    expect(categories.has("negative-wrong-owner")).toBe(true);
    expect(categories.has("contextual-safety")).toBe(true);
    expect([...categories].some(category => category?.startsWith("expansion-risk"))).toBe(true);
    expect(querySet.cases.every(item => item.query.length < 80)).toBe(true);
  });

  test("negative wrong-owner fixture cases require forbidden owners and strict terms_all", () => {
    const querySet = loadPrecisionQuerySet("data/eval/precision-real-queries.json");
    const wrongOwnerCases = querySet.cases.filter(item => item.category === "negative-wrong-owner");

    expect(wrongOwnerCases.length).toBeGreaterThan(0);
    for (const item of wrongOwnerCases) {
      expect(item.expected.forbidden_owner_ids?.length).toBeGreaterThan(0);
      expect(item.expected.terms_any ?? []).toEqual([]);
    }

    const momDizzy = wrongOwnerCases.find(item => item.id === "no-answer-wrong-owner-mom-dizzy");
    expect(momDizzy?.owner_id).toBe(DAD);
    expect(momDizzy?.expected.forbidden_owner_ids).toEqual([MOM]);
    expect(momDizzy?.expected.terms_any).toBeUndefined();
    expect(momDizzy?.expected.terms_all).toEqual(["头晕", "地球在转"]);
  });

  test("rejects negative wrong-owner cases with bare terms_any", async () => {
    await expect(runPrecisionEval({
      dbPath,
      readonly: true,
      querySet: oneCase({
        id: "bad-wrong-owner",
        category: "negative-wrong-owner",
        query: "爸爸这边有没有妈妈头晕",
        owner_id: DAD,
        expected: {
          no_answer: true,
          owner_id: DAD,
          terms_any: ["头晕"],
          forbidden_owner_ids: [MOM],
        },
      }),
    })).rejects.toThrow(/terms_any/);
  });
});

function oneCase(item: PrecisionQuerySet["cases"][number]): PrecisionQuerySet {
  return { version: 1, cases: [item] };
}

function seedEvent(input: {
  id: string;
  canonical_search_text: string;
  event_type: string;
  event_time: string;
  original_text?: string;
  summary?: string;
  entities?: string[];
  tags?: string[];
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
      event_date,
      created_at,
      user_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.summary || input.canonical_search_text,
    input.original_text || input.summary || input.canonical_search_text,
    input.event_type,
    JSON.stringify(input.entities || ["星星"]),
    JSON.stringify({ primary: "平静", valence: "neutral", intensity: 0.2 }),
    JSON.stringify(input.tags || []),
    input.canonical_search_text,
    input.event_time,
    input.event_time.slice(0, 10),
    input.event_time,
    input.user_id || DAD,
  );
}

function countMemoryEvents(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) as count FROM memory_events").get() as { count: number }).count;
  } finally {
    db.close();
  }
}
