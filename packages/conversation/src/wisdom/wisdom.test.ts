import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 依赖注入而非 mock.module：bun 的模块 mock 是进程级的，会泄漏进其他测试文件。
const { closeDB, getDB } = await import("../../../db/src/database");
const { initSchema } = await import("../../../db/src/schema");
const { groundHits, hasDistressSignal } = await import("./lever-detector");
const { loadWisdomContext } = await import("./wisdom-context");
const { maybeCaptureNarrative } = await import("./narrative-capture");
const { getPreferredNarratives, appendNarrativeEvidence } = await import("./narrative-store");
const { recordIntervention, getLeverRecurrence } = await import("./lever-store");
const { recordConversationTurn } = await import("../conversation");
const { loadUnderstandingContext } = await import("../memory/profile-context");
const { getLongTermProfile, upsertProfile } = await import("../memory/profile-repository");
import type { LeverDetection } from "./lever-types";
import type { WisdomDeps } from "./wisdom-context";

const OWNER = "dad";

/** 假检测器：把"这句话里有哪种消极解释"直接喂进来，闸门逻辑就能脱离 LLM 测。 */
function fakeDeps(detection: LeverDetection, calls?: { detect: number }): WisdomDeps {
  return {
    detect: async () => {
      if (calls) calls.detect += 1;
      return detection;
    },
    findEvidence: async () => [{ date: "2026-05-02", detail: "提前列了清单，那次上线很顺" }],
  };
}

const FIXED: LeverDetection = {
  detected: true,
  hits: [{ lever: "fixed_attribution", confidence: 0.8, quote: "我就是不行" }],
};

describe("wisdom: 认知杠杆识别与防幻觉", () => {
  test("前置门只对低落/挫折信号放行，普通记录与提问不花 LLM 调用", () => {
    expect(hasDistressSignal("我怎么总是把事情搞砸，我就是不行")).toBe(true);
    expect(hasDistressSignal("阿星今天会自己走路了")).toBe(false);
    expect(hasDistressSignal("上次阿星发烧是什么时候")).toBe(false);
  });

  test("quote 不在原话里的命中一律丢弃（不能替用户说出他没说过的自我否定）", () => {
    const text = "今天又没做好，我就是不行";
    const hits = groundHits([
      { lever: "fixed_attribution", confidence: 0.9, quote: "我就是不行" },
      { lever: "belonging_uncertainty", confidence: 0.9, quote: "没有人真的喜欢我" }, // 模型编的
    ], text);
    expect(hits.map(h => h.lever)).toEqual(["fixed_attribution"]);
  });

  test("忽略标点差异，但不接受改写", () => {
    expect(groundHits([{ lever: "fixed_attribution", confidence: 0.7, quote: "我，就是不行。" }], "我就是不行")).toHaveLength(1);
    expect(groundHits([{ lever: "fixed_attribution", confidence: 0.7, quote: "我不太行" }], "我就是不行")).toHaveLength(0);
  });
});

describe("wisdom: 干预闸门", () => {
  let dbPath = "";

  beforeEach(() => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-wisdom-${crypto.randomUUID()}.db`);
    initSchema(getDB(dbPath));
    delete process.env.XFEEL_WISDOM_DISABLED;
  });

  afterEach(() => {
    closeDB();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    delete process.env.XFEEL_WISDOM_DISABLED;
  });

  test("单次低落不干预，但命中已落库（正常情绪 ≠ 认知模式）", async () => {
    const plan = await loadWisdomContext(
      { owner_id: OWNER, text: "今天又搞砸了，我就是不行", date: "2026-06-10" },
      fakeDeps(FIXED),
    );
    expect(plan.intervene).toBe(false);
    expect(plan.skipReason).toBe("not_recurring");
    expect(getLeverRecurrence({ ownerId: OWNER, lever: "fixed_attribution", since: "2026-06-01", until: "2026-06-10" }).hits).toBe(1);
  });

  test("同一杠杆跨天复现才干预，且提示块禁说教/禁鸡汤、带上 ta 自己的反例", async () => {
    await loadWisdomContext({ owner_id: OWNER, text: "又搞砸了，我就是不行", date: "2026-06-10" }, fakeDeps(FIXED));
    const plan = await loadWisdomContext(
      { owner_id: OWNER, text: "还是不行，我就是不行", date: "2026-06-12" },
      fakeDeps(FIXED),
    );
    expect(plan.intervene).toBe(true);
    expect(plan.lever).toBe("fixed_attribution");
    expect(plan.counterEvidence[0]?.detail).toContain("提前列了清单");
    expect(plan.text).toContain("禁止说教");
    expect(plan.text).toContain("禁止鸡汤");
    expect(plan.text).toContain("提前列了清单");
  });

  test("同一天说三遍只算一天：按天计数，不按条数", async () => {
    await loadWisdomContext({ owner_id: OWNER, text: "我就是不行", date: "2026-06-10" }, fakeDeps(FIXED));
    const plan = await loadWisdomContext({ owner_id: OWNER, text: "真的我就是不行", date: "2026-06-10" }, fakeDeps(FIXED));
    expect(plan.intervene).toBe(false);
    expect(plan.skipReason).toBe("not_recurring");
  });

  test("冷却期内不再发问（别把每次难过都变成一场反问）", async () => {
    await loadWisdomContext({ owner_id: OWNER, text: "我就是不行", date: "2026-06-10" }, fakeDeps(FIXED));
    recordIntervention({ ownerId: OWNER, lever: "fixed_attribution", question: "那次是怎么弄的？", evidence: [], date: "2026-06-12" });
    const plan = await loadWisdomContext(
      { owner_id: OWNER, text: "今天还是不行，我就是不行", date: "2026-06-13" },
      fakeDeps(FIXED),
    );
    expect(plan.intervene).toBe(false);
    expect(plan.skipReason).toBe("cooldown");
  });

  test("危机/丧失类内容绝不干预，且根本不跑检测", async () => {
    const calls = { detect: 0 };
    const plan = await loadWisdomContext(
      { owner_id: OWNER, text: "我最近总觉得不想活了，我就是不行", date: "2026-06-12" },
      fakeDeps(FIXED, calls),
    );
    expect(plan.intervene).toBe(false);
    expect(plan.skipReason).toBe("sensitive");
    expect(calls.detect).toBe(0);
  });

  test("特性开关一键关闭整层", async () => {
    process.env.XFEEL_WISDOM_DISABLED = "1";
    const plan = await loadWisdomContext({ owner_id: OWNER, text: "我就是不行", date: "2026-06-12" }, fakeDeps(FIXED));
    expect(plan.intervene).toBe(false);
    expect(plan.skipReason).toBe("disabled");
  });
});

describe("wisdom: 首选叙事的回收与证据链", () => {
  let dbPath = "";

  beforeEach(() => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-narrative-${crypto.randomUUID()}.db`);
    initSchema(getDB(dbPath));
    delete process.env.XFEEL_WISDOM_DISABLED;
  });

  afterEach(() => {
    closeDB();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    delete process.env.XFEEL_WISDOM_DISABLED;
  });

  function askQuestion(): string {
    const turn = recordConversationTurn({ content: "那次你是怎么弄的？", owner_id: OWNER, role: "assistant", turn_date: "2026-06-12" });
    recordIntervention({
      ownerId: OWNER, lever: "fixed_attribution", question: "那次你是怎么弄的？",
      evidence: [], date: "2026-06-12", askedTurnId: turn.id,
    });
    return turn.id;
  }

  test("用户自己说出的解释才写入画像", async () => {
    const askedTurnId = askQuestion();
    const captured = await maybeCaptureNarrative(
      { owner_id: OWNER, text: "那次我提前列了清单，心里有底", date: "2026-06-12", previousAssistantTurnId: askedTurnId },
      async () => ({ captured: true, statement: "提前列清单、心里有底的时候，我是能弄好的" }),
    );
    expect(captured?.statement).toContain("提前列清单");
    expect(getPreferredNarratives(OWNER)).toHaveLength(1);
  });

  test("只附和/继续自我否定不算，不写入任何叙事", async () => {
    const askedTurnId = askQuestion();
    const captured = await maybeCaptureNarrative(
      { owner_id: OWNER, text: "嗯，可能吧", date: "2026-06-12", previousAssistantTurnId: askedTurnId },
      async () => ({ captured: false }),
    );
    expect(captured).toBeNull();
    expect(getPreferredNarratives(OWNER)).toHaveLength(0);
  });

  test("岔开几轮之后的话不算对反问的回答", async () => {
    askQuestion();
    const other = recordConversationTurn({ content: "好的", owner_id: OWNER, role: "assistant", turn_date: "2026-06-12" });
    const captured = await maybeCaptureNarrative(
      { owner_id: OWNER, text: "那次我提前列了清单", date: "2026-06-13", previousAssistantTurnId: other.id },
      async () => ({ captured: true, statement: "不该被写进去的话" }),
    );
    expect(captured).toBeNull();
    expect(getPreferredNarratives(OWNER)).toHaveLength(0);
  });

  test("离线重建画像不得冲掉用户自己说出的叙事", async () => {
    const askedTurnId = askQuestion();
    await maybeCaptureNarrative(
      { owner_id: OWNER, text: "那次我提前列了清单", date: "2026-06-12", previousAssistantTurnId: askedTurnId },
      async () => ({ captured: true, statement: "方法对了，我是能弄好的" }),
    );
    // 模拟离线归纳只写 understandings 的那份 content（full 模式会从零滚动）。
    const preserved = getLongTermProfile(OWNER)!.content.preferredNarratives;
    upsertProfile({
      ownerId: OWNER, layer: "long_term",
      content: { understandings: [], addressBook: [], openQuestions: [], preferredNarratives: preserved },
    });
    expect(getPreferredNarratives(OWNER)[0]?.statement).toBe("方法对了，我是能弄好的");
  });

  test("证据链去重，且叙事与其证据会注入理解层", async () => {
    const askedTurnId = askQuestion();
    await maybeCaptureNarrative(
      { owner_id: OWNER, text: "那次我提前列了清单", date: "2026-06-12", previousAssistantTurnId: askedTurnId },
      async () => ({ captured: true, statement: "方法对了，我是能弄好的" }),
    );
    const evidence = [{ date: "2026-06-14", detail: "跑通了 mock 校验", eventId: "e1" }];
    expect(appendNarrativeEvidence(OWNER, "fixed_attribution", evidence)).toBe(1);
    expect(appendNarrativeEvidence(OWNER, "fixed_attribution", evidence)).toBe(0); // 同一条不重复挂

    const context = loadUnderstandingContext({ owner_id: OWNER });
    expect(context.text).toContain("方法对了，我是能弄好的");
    expect(context.text).toContain("跑通了 mock 校验");
  });
});
