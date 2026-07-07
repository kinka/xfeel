import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDB, getDB } from "../packages/db/src/database";
import { initSchema } from "../packages/db/src/schema";
import {
  findOwnerLeaks,
  loadQuerySet,
  parseArgs,
  runRecallEval,
  type RealRecallQuerySet,
} from "./eval-recall-real";

const DAD = "demo-dad-owner";
const MOM = "demo-mom-owner";

describe("eval-recall-real", () => {
  let dbPath = "";

  beforeEach(() => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-recall-real-eval-${crypto.randomUUID()}.db`);
    const db = getDB(dbPath);
    initSchema(db);
  });

  afterEach(() => {
    closeDB();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });

  test("computes Hit@5, Hit@10, recall aliases, and MRR from ranked hits", () => {
    seedEvent({
      id: "rank1-relevant",
      summary: "alphatoken first clue",
      canonical_search_text: "alphatoken first clue",
      event_type: "sleep",
      event_time: "2026-06-10T09:00:00.000Z",
    });
    for (let i = 1; i <= 5; i++) {
      seedEvent({
        id: `rank6-decoy-${i}`,
        summary: `ranktoken decoy ${i}`,
        canonical_search_text: `ranktoken decoy ${i}`,
        event_type: "daily",
        event_time: `2026-06-${10 + i}T09:00:00.000Z`,
      });
    }
    seedEvent({
      id: "rank6-relevant",
      summary: "ranktoken relevant six",
      canonical_search_text: "ranktoken relevant six",
      event_type: "sleep",
      event_time: "2026-06-01T09:00:00.000Z",
    });

    closeDB();
    const output = runRecallEval({
      dbPath,
      readonly: true,
      k: 10,
      querySet: {
        version: 1,
        cases: [
          {
            id: "rank1",
            query: "alphatoken",
            owner_id: DAD,
            expected: {
              owner_id: DAD,
              event_types: ["sleep"],
              terms_any: ["alphatoken"],
              weak_terms_any: ["first clue"],
            },
          },
          {
            id: "rank6",
            query: "ranktoken",
            owner_id: DAD,
            expected: {
              owner_id: DAD,
              event_types: ["sleep"],
              terms_any: ["ranktoken"],
              weak_terms_any: ["relevant six"],
            },
          },
          {
            id: "miss",
            query: "missingtoken",
            owner_id: DAD,
            expected: {
              owner_id: DAD,
              event_types: ["health"],
              terms_any: ["missingtoken"],
              weak_terms_any: ["absent clue"],
            },
          },
        ],
      },
    });

    expect(output.cases.map(item => item.relevant_rank)).toEqual([1, 6, null]);
    expect(output.query_expansion).toEqual({
      enabled: true,
      variant: "deterministic_v1",
      candidate_limit: 240,
      candidate_limit_mode: "auto",
    });
    expect(output.cases[0]?.query_expansion.search_terms).toContain("alphatoken");
    expect(output.cases[0]?.query_expansion.candidate_limit).toBe(240);
    expect(output.cases.map(item => item.miss_type_at_5)).toEqual([null, "relevant_beyond_5", "failed_criteria"]);
    expect(output.cases.map(item => item.miss_type_at_10)).toEqual([null, null, "failed_criteria"]);
    expect(output.cases[2]?.failure_reasons).toContain("no_relevant_in_top_k");
    expect(output.cases[2]?.failure_reasons.some(reason => reason.startsWith("failed_criteria:"))).toBe(true);
    expect(output.metrics.hit_at_5).toBe(0.3333);
    expect(output.metrics.hit_at_10).toBe(0.6667);
    expect(output.metrics.recall_at_5).toBe(0.3333);
    expect(output.metrics.recall_at_10).toBe(0.6667);
    expect(output.metrics.mrr).toBe(0.3889);
    expect(output.metrics.owner_leak_count).toBe(0);
    expect(output.failure_summary.missed_by_type_at_5).toEqual({
      failed_criteria: 1,
      relevant_beyond_5: 1,
    });
    expect(output.failure_summary.missed_by_type_at_10).toEqual({ failed_criteria: 1 });
  });

  test("detects owner leaks in scoped hit lists", () => {
    expect(findOwnerLeaks([
      { rank: 1, id: "wrong-owner", owner_id: MOM },
      { rank: 2, id: "right-owner", owner_id: DAD },
      { rank: 3, id: "missing-owner" },
    ], DAD)).toEqual([{ rank: 1, id: "wrong-owner", owner_id: MOM }]);
  });

  test("parses expansion comparison flags", () => {
    expect(parseArgs(["--no-expansion"], {}).queryExpansion).toBe(false);
    expect(parseArgs(["--expansion"], {}).queryExpansion).toBe(true);
    expect(parseArgs(["--candidate-limit", "baseline"], {}).candidateLimitMode).toBe("baseline");
    expect(() => parseArgs(["--candidate-limit", "wide"], {})).toThrow(/candidate-limit/);
  });

  test("reports expansion with baseline candidate-limit ablation", () => {
    seedEvent({
      id: "candidate-limit-hit",
      summary: "candidate token",
      canonical_search_text: "candidate token",
      event_type: "daily",
      event_time: "2026-06-10T09:00:00.000Z",
    });

    closeDB();
    const output = runRecallEval({
      dbPath,
      readonly: true,
      queryExpansion: true,
      candidateLimitMode: "baseline",
      querySet: oneCase({
        id: "candidate-limit",
        query: "candidate",
        owner_id: DAD,
        expected: {
          owner_id: DAD,
          event_types: ["daily"],
          terms_any: ["candidate"],
        },
      }),
    });

    expect(output.query_expansion).toEqual({
      enabled: true,
      variant: "deterministic_v1",
      candidate_limit: 80,
      candidate_limit_mode: "baseline",
    });
    expect(output.cases[0]?.query_expansion.candidate_limit).toBe(80);
    expect(output.cases[0]?.query_expansion.candidate_limit_mode).toBe("baseline");
  });

  test("refuses to run against an empty DB by default", () => {
    closeDB();
    expect(() => runRecallEval({
      dbPath,
      readonly: true,
      querySet: oneCase({
        id: "empty",
        query: "emptytoken",
        owner_id: DAD,
        expected: {
          owner_id: DAD,
          event_types: ["sleep"],
          terms_any: ["emptytoken"],
        },
      }),
    })).toThrow(/empty DB/);
  });

  test("allowEmpty permits empty DB eval and reports no_candidates", () => {
    closeDB();
    const output = runRecallEval({
      dbPath,
      readonly: true,
      allowEmpty: true,
      querySet: oneCase({
        id: "empty",
        query: "emptytoken",
        owner_id: DAD,
        expected: {
          owner_id: DAD,
          event_types: ["sleep"],
          terms_any: ["emptytoken"],
        },
      }),
    });

    expect(output.db_counts.memory_events).toBe(0);
    expect(output.cases[0]?.total_candidates).toBe(0);
    expect(output.cases[0]?.miss_type_at_5).toBe("no_candidates");
    expect(output.cases[0]?.miss_type_at_10).toBe("no_candidates");
    expect(output.failure_summary.missed_by_type_at_10).toEqual({ no_candidates: 1 });
  });

  test("matches relevance using expected terms from stored canonical search text", () => {
    seedEvent({
      id: "canonical-only",
      summary: "plain fixture summary",
      original_text: "plain fixture original",
      canonical_search_text: "rarecanonical clue 发烧 星星",
      event_type: "health",
      entities: ["星星"],
      tags: ["发烧"],
      event_time: "2026-06-10T09:00:00.000Z",
    });

    closeDB();
    const output = runRecallEval({
      dbPath,
      readonly: true,
      querySet: oneCase({
        id: "canonical",
        query: "rarecanonical",
        owner_id: DAD,
        expected: {
          owner_id: DAD,
          event_types: ["health"],
          entities_any: ["星星"],
          tags_any: ["发烧"],
          terms_any: ["rarecanonical"],
          weak_terms_any: ["clue"],
        },
      }),
    });

    expect(output.cases[0]?.relevant_rank).toBe(1);
    expect(output.cases[0]?.top_hits[0]?.relevance.relevant).toBe(true);
    expect(output.cases[0]?.top_hits[0]?.relevance.matched).toContain("terms_any:rarecanonical");
  });

  test("expected ids anchor retrieved rows even when criteria would otherwise fail", () => {
    seedEvent({
      id: "id-anchor",
      summary: "anchortoken unrelated event",
      canonical_search_text: "anchortoken unrelated event",
      event_type: "daily",
      event_time: "2026-06-10T09:00:00.000Z",
    });

    closeDB();
    const output = runRecallEval({
      dbPath,
      readonly: true,
      querySet: oneCase({
        id: "id-anchor-case",
        query: "anchortoken",
        owner_id: DAD,
        expected: {
          ids: ["id-anchor"],
          owner_id: DAD,
          event_types: ["health"],
          terms_any: ["missing-hard-term"],
          weak_terms_any: ["missing-weak-term"],
        },
      }),
    });

    const relevance = output.cases[0]?.top_hits[0]?.relevance;
    expect(output.cases[0]?.relevant_rank).toBe(1);
    expect(relevance?.id_matched).toBe(true);
    expect(relevance?.matched).toEqual(["id:id-anchor"]);
    expect(relevance?.failed).toEqual([]);
  });

  test("weak_terms_any is diagnostic and not a hard relevance requirement", () => {
    seedEvent({
      id: "weak-optional",
      summary: "weaktoken strong criterion",
      canonical_search_text: "weaktoken strong criterion",
      event_type: "sleep",
      event_time: "2026-06-10T09:00:00.000Z",
    });

    closeDB();
    const output = runRecallEval({
      dbPath,
      readonly: true,
      querySet: oneCase({
        id: "weak-optional",
        query: "weaktoken",
        owner_id: DAD,
        expected: {
          owner_id: DAD,
          event_types: ["sleep"],
          terms_any: ["weaktoken"],
          weak_terms_any: ["not-present"],
        },
      }),
    });

    const relevance = output.cases[0]?.top_hits[0]?.relevance;
    expect(output.cases[0]?.relevant_rank).toBe(1);
    expect(relevance?.relevant).toBe(true);
    expect(relevance?.matched).toContain("terms_any:weaktoken");
    expect(relevance?.failed.some(reason => reason.startsWith("weak_terms_any:"))).toBe(false);
    expect(relevance?.diagnostics).toContain("weak_terms_any:missed not-present");
  });

  test("runs read-only and does not mutate fixture rows", () => {
    seedEvent({
      id: "readonly-relevant",
      summary: "readonlytoken stable clue",
      canonical_search_text: "readonlytoken stable clue",
      event_type: "sleep",
      event_time: "2026-06-10T09:00:00.000Z",
    });
    const before = countMemoryEvents(dbPath);

    closeDB();
    const output = runRecallEval({
      dbPath,
      readonly: true,
      querySet: oneCase({
        id: "readonly",
        query: "readonlytoken",
        owner_id: DAD,
        expected: {
          owner_id: DAD,
          event_types: ["sleep"],
          terms_any: ["readonlytoken"],
          weak_terms_any: ["stable clue"],
        },
      }),
    });

    expect(output.readonly).toBe(true);
    expect(output.cases[0]?.relevant_rank).toBe(1);
    expect(countMemoryEvents(dbPath)).toBe(before);

    closeDB();
    const db = getDB(dbPath, { readonly: true, create: false });
    expect(() => db.prepare(`
      INSERT INTO memory_events (id, summary, original_text, event_type, entities, emotion, tags, user_id)
      VALUES ('should-fail', 'x', 'x', 'daily', '[]', '{}', '[]', ?)
    `).run(DAD)).toThrow();
  });

  test("keeps sleep-mom-collapse-rhythm in the real eval fixture", () => {
    const querySet = loadQuerySet("data/eval/recall-real-queries.json");
    const regression = querySet.cases.find(item => item.id === "sleep-mom-collapse-rhythm");

    expect(regression?.query).toContain("睡不好");
    expect(regression?.expected.owner_id).toBe(MOM);
    expect(regression?.expected.event_types).toContain("sleep");
    expect(regression?.expected.terms_any).toEqual(expect.arrayContaining(["带睡", "崩溃", "睡不好"]));
  });
});

function oneCase(item: RealRecallQuerySet["cases"][number]): RealRecallQuerySet {
  return { version: 1, cases: [item] };
}

function seedEvent(input: {
  id: string;
  summary: string;
  canonical_search_text: string;
  event_type: string;
  event_time: string;
  original_text?: string;
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
    input.summary,
    input.original_text || input.summary,
    input.event_type,
    JSON.stringify(input.entities || ["爸爸"]),
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
