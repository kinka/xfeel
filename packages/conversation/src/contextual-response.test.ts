import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

mock.module("../../ai-client/src/llm", () => ({
  getLLM() {
    return {
      async chatJSON() {
        throw new Error("LLM unavailable in test");
      },
      async chat() {
        throw new Error("LLM unavailable in test");
      },
    };
  },
}));

const { getDB, closeDB } = await import("../../db/src/database");
const { initSchema } = await import("../../db/src/schema");
const { CONTEXTUAL_RECALL_OPTIONS, logWithContextualReply, recallContextualHistory } = await import("./contextual-response");
const { getConversationTurns } = await import("./conversation");
const { buildWeakEntitySet, isContextuallyRelevant } = await import("./relevance-gate");

const DAD = "demo-dad-owner";
const MOM = "demo-mom-owner";

const { buildAliasContext } = await import("../../domain/src/family");

// 家庭词典 fixture：具体家人名不再内置在产品代码里，规则兜底靠 aliasContext
const FIXTURE_ALIAS_CONTEXT = buildAliasContext({
  familyId: "fam-fixture",
  childLabels: ["星星", "禾禾"],
  aliases: [
    { alias: "星星", memberId: "child-star", label: "星星", scope: "global" },
    { alias: "阿星", memberId: "child-star", label: "星星", scope: "global" },
    { alias: "禾禾", memberId: "child-he", label: "禾禾", scope: "global" },
    { alias: "爸爸", memberId: DAD, label: "爸爸", scope: "global" },
    { alias: "妈妈", memberId: MOM, label: "妈妈", scope: "global" },
  ],
});

describe("logWithContextualReply", () => {
  let dbPath = "";

  beforeEach(() => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-contextual-${crypto.randomUUID()}.db`);
    const db = getDB(dbPath);
    initSchema(db);
  });

  afterEach(() => {
    closeDB();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });

  test("returns deterministic fallback and stores assistant turn when LLM fails", async () => {
    seedEvent({
      id: "hist-sleep-1",
      raw_message_id: "old-message-1",
      summary: "星星上周也夜醒两次",
      original_text: "上周星星夜醒两次，妈妈很疲惫。",
      event_type: "sleep",
      entities: ["星星", "妈妈"],
      emotion: { primary: "疲惫", intensity: 0.8, valence: "negative" },
      tags: ["夜醒"],
      event_time: "2026-06-05T21:00:00.000Z",
      user_id: MOM,
    });

    const result = await logWithContextualReply({
      text: "今天星星又夜醒了三次，我真的有点崩溃。",
      owner_id: MOM,
      date: "2026-06-12",
      force: true,
      limit: 6,
    });

    expect(result.mode).toBe("log_with_contextual_reply");
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.reply).toContain("记下来了");
    expect(result.pipeline.stored).toBeGreaterThanOrEqual(1);
    expect(result.user_turn.source).toBe("log");
    expect(result.assistant_turn.source).toBe("contextual_log_reply");
    expect(result.context.signals.owner_id).toBe(MOM);
    expect(result.context.signals.has_related_history).toBe(true);
    expect(result.context.recalled.map(event => event.id)).toContain("hist-sleep-1");

    const turns = getConversationTurns({ owner_id: MOM, date: "2026-06-12", include_archived: true });
    expect(turns.map(turn => turn.role)).toEqual(["user", "assistant"]);
  });

  test("preserves owner semantics by recalling mom history for mom logs", async () => {
    seedEvent({
      id: "dad-sleep",
      raw_message_id: "dad-old",
      summary: "爸爸记录自己半夜哄睡星星",
      original_text: "我半夜哄睡星星，累坏了。",
      event_type: "sleep",
      entities: ["爸爸", "星星"],
      emotion: { primary: "疲惫", intensity: 0.7, valence: "negative" },
      tags: ["夜醒"],
      event_time: "2026-06-03T20:00:00.000Z",
      user_id: DAD,
    });
    seedEvent({
      id: "mom-sleep",
      raw_message_id: "mom-old",
      summary: "妈妈记录星星夜醒后很疲惫",
      original_text: "我陪星星夜醒，特别疲惫。",
      event_type: "sleep",
      entities: ["妈妈", "星星"],
      emotion: { primary: "疲惫", intensity: 0.8, valence: "negative" },
      tags: ["夜醒"],
      event_time: "2026-06-04T20:00:00.000Z",
      user_id: MOM,
    });

    const result = await logWithContextualReply({
      text: "我今晚又陪星星夜醒了三次，好累。",
      owner_id: MOM,
      date: "2026-06-12",
      force: true,
    });

    const recalledIds = result.context.recalled.map(event => event.id);
    expect(recalledIds).toContain("mom-sleep");
    expect(recalledIds).not.toContain("dad-sleep");
    expect(result.context.recalled.every(event => event.user_id === MOM)).toBe(true);
  });

  test("recalls same type and entity history for sleep logs about oxygen", async () => {
    seedEvent({
      id: "sleep-oxygen",
      raw_message_id: "old-sleep",
      summary: "星星连续两晚夜醒",
      original_text: "星星连续两晚夜醒。",
      event_type: "sleep",
      entities: ["星星"],
      emotion: { primary: "疲惫", intensity: 0.6, valence: "negative" },
      tags: ["夜醒"],
      event_time: "2026-06-08T21:00:00.000Z",
      user_id: MOM,
    });
    seedEvent({
      id: "health-oxygen",
      raw_message_id: "old-health",
      summary: "星星咳嗽去门诊",
      original_text: "星星咳嗽去门诊。",
      event_type: "health",
      entities: ["星星"],
      emotion: { primary: "担心", intensity: 0.7, valence: "negative" },
      tags: ["就医"],
      event_time: "2026-06-07T09:00:00.000Z",
      user_id: MOM,
    });

    const result = await logWithContextualReply({
      text: "今天星星夜醒三次，我有点崩溃。",
      owner_id: MOM,
      date: "2026-06-12",
      force: true,
      aliasContext: FIXTURE_ALIAS_CONTEXT,
    });

    const recalledIds = result.context.recalled.map(event => event.id);
    expect(recalledIds).toContain("sleep-oxygen");
    expect(recalledIds).toContain("health-oxygen");
  });

  test("does not return the event just stored by the current pipeline", async () => {
    const result = await logWithContextualReply({
      text: "今天星星夜醒三次，我有点崩溃。",
      owner_id: MOM,
      date: "2026-06-12",
      force: true,
    });

    const pipelineEventIds = new Set(result.pipeline.events.map(event => event.id).filter(Boolean));
    expect(result.pipeline.stored).toBeGreaterThanOrEqual(1);
    expect(result.context.recalled.every(event => !pipelineEventIds.has(event.id))).toBe(true);
    expect(result.context.recalled.every(event => event.raw_message_id !== result.pipeline.message_id)).toBe(true);
  });

  test("sets negative emotion signal from current extracted event", async () => {
    const result = await logWithContextualReply({
      text: "今天星星又夜醒了三次，我真的有点崩溃。",
      owner_id: MOM,
      date: "2026-06-12",
      force: true,
    });

    expect(result.context.signals.has_negative_emotion).toBe(true);
  });

  test("does not claim weak weather/emotion overlap as related history and appends extracted result", async () => {
    seedEvent({
      id: "old-rain-swim",
      raw_message_id: "old-rain-swim-message",
      summary: "今天虽然下雨又降温，但我犹豫之后还是去游泳了，而且又感觉到新的变化",
      original_text: "今天虽然下雨又降温，但我犹豫之后还是去游泳了，而且又感觉到新的变化。自学自由泳两三年了。",
      event_type: "other",
      entities: ["爸爸"],
      emotion: { primary: "欣喜", intensity: 0.6, valence: "positive" },
      tags: ["运动", "游泳", "下雨"],
      event_time: "2026-06-10T09:00:00.000Z",
      user_id: DAD,
    });

    const result = await logWithContextualReply({
      text: "今天伴侣昵称上班，虽然下大雨，打车一开始有点难，但后来打到了一辆6座商务车，车空间又大，一下子让她情绪转换了过来",
      owner_id: DAD,
      date: "2026-06-12",
      force: true,
    });

    expect(result.context.recalled.map(event => event.id)).not.toContain("old-rain-swim");
    expect(result.reply).not.toContain("游泳");
    expect(result.reply).not.toContain("有点相关");
    expect(result.reply).toContain("提取到：");
    expect(result.reply).toContain("伴侣昵称");
  });

  test("recalls related history for normal non-emotional logs (recall default-on)", async () => {
    seedEvent({
      id: "old-normal-sleep",
      raw_message_id: "old-normal-message",
      summary: "星星昨天睡得很好",
      original_text: "星星昨天睡得很好。",
      event_type: "sleep",
      entities: ["星星"],
      emotion: { primary: "平静", intensity: 0.3, valence: "neutral" },
      tags: ["睡眠"],
      event_time: "2026-06-11T21:00:00.000Z",
      user_id: MOM,
    });

    const result = await logWithContextualReply({
      text: "今天星星午睡了两个小时。",
      owner_id: MOM,
      date: "2026-06-12",
      force: true,
      aliasContext: FIXTURE_ALIAS_CONTEXT,
    });

    // 召回默认开启：共享强实体(星星)且同类事件(sleep)的历史应被联动，
    // 不再因为“无负面情绪”而被整体屏蔽。
    expect(result.context.recalled.map(event => event.id)).toContain("old-normal-sleep");
    expect(result.context.signals.has_related_history).toBe(true);
  });

  test("strong negative emotion recalls emotional history for empathy", async () => {
    seedEvent({
      id: "old-collapse",
      raw_message_id: "old-collapse-message",
      summary: "妈妈上周因为夜醒感到崩溃",
      original_text: "上周星星夜醒，妈妈感到崩溃。",
      event_type: "emotion",
      entities: ["妈妈"],
      emotion: { primary: "崩溃", intensity: 0.9, valence: "negative" },
      tags: ["情绪"],
      event_time: "2026-06-05T21:00:00.000Z",
      user_id: MOM,
    });

    const result = await logWithContextualReply({
      text: "今天真的有点崩溃。",
      owner_id: MOM,
      date: "2026-06-12",
      force: true,
    });

    expect(result.context.signals.has_negative_emotion).toBe(true);
    expect(result.context.recalled.map(event => event.id)).toContain("old-collapse");
  });

  test("does not treat alias-derived weak adult entities as contextual relevance", () => {
    const weakEntities = buildWeakEntitySet({
      selfLabel: "爸爸",
      aliases: [
        { alias: "老婆", memberId: "妈妈", label: "妈妈", scope: "global" },
        { alias: "我老婆", memberId: "妈妈", label: "妈妈", scope: "speaker" },
        { alias: "阿星", memberId: "小星", label: "小星", scope: "global" },
      ],
    });
    expect(weakEntities).toContain("爸爸");
    expect(weakEntities).toContain("妈妈");
    expect(weakEntities).toContain("老婆");
    expect(weakEntities).not.toContain("小星");

    const current = makeEvent({
      id: "current",
      summary: "妈妈今天下雨打车时情绪有起伏",
      event_type: "other",
      entities: ["妈妈"],
      tags: ["下雨", "情绪"],
    });
    const weakCandidate = makeEvent({
      id: "weak",
      summary: "妈妈之前在雨天去游泳",
      event_type: "other",
      entities: ["妈妈"],
      tags: ["下雨", "游泳"],
    });
    const strongCandidate = makeEvent({
      id: "strong",
      summary: "小星之前也夜醒",
      event_type: "sleep",
      entities: ["小星"],
      tags: ["夜醒"],
    });
    const strongCurrent = makeEvent({
      id: "strong-current",
      summary: "小星今天夜醒",
      event_type: "sleep",
      entities: ["小星"],
      tags: ["夜醒"],
    });

    expect(isContextuallyRelevant(weakCandidate, [current], 20, weakEntities)).toBe(false);
    expect(isContextuallyRelevant(strongCandidate, [strongCurrent], 4, weakEntities)).toBe(true);
  });

  test("does not treat same concrete event type as relevant without a shared strong entity or tag", () => {
    const weakEntities = buildWeakEntitySet();
    const current = makeEvent({
      id: "mom-sleep-current",
      summary: "妈妈昨晚睡不好",
      event_type: "sleep",
      entities: ["妈妈"],
      tags: [],
    });
    const differentSubject = makeEvent({
      id: "tunan-sleep-candidate",
      summary: "小星之前夜醒",
      event_type: "sleep",
      entities: ["小星"],
      tags: [],
    });
    const sameSubject = makeEvent({
      id: "tunan-sleep-strong",
      summary: "小星之前也夜醒",
      event_type: "sleep",
      entities: ["小星"],
      tags: [],
    });
    const sameSubjectCurrent = makeEvent({
      id: "tunan-sleep-current",
      summary: "小星今天夜醒",
      event_type: "sleep",
      entities: ["小星"],
      tags: [],
    });

    expect(isContextuallyRelevant(differentSubject, [current], 20, weakEntities)).toBe(false);
    expect(isContextuallyRelevant(sameSubject, [sameSubjectCurrent], 4, weakEntities)).toBe(true);
  });

  test("does not treat shared child entity alone as contextual relevance", () => {
    const weakEntities = buildWeakEntitySet();
    const current = makeEvent({
      id: "child-play-current",
      summary: "小禾今天复刻之前的螺丝钉玩法",
      event_type: "milestone",
      entities: ["小禾"],
      tags: ["螺丝钉", "玩法"],
    });
    const unrelatedSameChild = makeEvent({
      id: "child-health-old",
      summary: "小禾之前咳嗽，妈妈有点担心",
      event_type: "health",
      entities: ["小禾"],
      tags: ["咳嗽"],
    });
    const relatedSameChild = makeEvent({
      id: "child-play-old",
      summary: "小禾之前也玩螺丝钉",
      event_type: "milestone",
      entities: ["小禾"],
      tags: ["螺丝钉"],
    });

    expect(isContextuallyRelevant(unrelatedSameChild, [current], 20, weakEntities)).toBe(false);
    expect(isContextuallyRelevant(relatedSameChild, [current], 4, weakEntities)).toBe(true);
  });

  test("keeps the user's nickname sticky in deterministic replies", async () => {
    seedEvent({
      id: "canonical-sleep",
      raw_message_id: "canonical-sleep-message",
      summary: "小星之前也夜醒",
      original_text: "小星之前也夜醒。",
      event_type: "sleep",
      entities: ["小星"],
      emotion: { primary: "疲惫", intensity: 0.7, valence: "negative" },
      tags: ["夜醒"],
      event_time: "2026-06-05T21:00:00.000Z",
      user_id: MOM,
    });

    const result = await logWithContextualReply({
      text: "今天阿星又夜醒了三次，我真的有点崩溃。",
      owner_id: MOM,
      date: "2026-06-12",
      force: true,
      aliasContext: {
        aliases: [
          { alias: "阿星", memberId: "小星", label: "小星", scope: "global" },
          { alias: "星星", memberId: "小星", label: "小星", scope: "global" },
        ],
      },
    });

    expect(result.reply).toContain("阿星");
    expect(result.reply).not.toContain("小星");
    expect(result.reply).not.toContain("星星");
  });

  test("uses structured emotion-only recall for contextual history", async () => {
    expect(CONTEXTUAL_RECALL_OPTIONS.expansion).toBe(false);

    seedEvent({
      id: "alias-only-health",
      raw_message_id: "old-alias",
      summary: "星星有呕吐和腹泻",
      original_text: "星星呕吐、腹泻，妈妈记录了处理过程。",
      event_type: "health",
      entities: ["星星", "妈妈"],
      emotion: { primary: "担心", intensity: 0.7, valence: "negative" },
      tags: ["腹泻"],
      event_time: "2026-06-05T09:00:00.000Z",
      user_id: MOM,
    });

    const recalled = await recallContextualHistory({
      text: "上吐下泻",
      ownerId: MOM,
      events: [makeEvent({ id: "current-strong", summary: "现在很担心", emotion: { primary: "担心", intensity: 0.8, valence: "negative" } })],
      messageId: "current-message",
      limit: 1,
    });

    expect(recalled.map(event => event.id)).toEqual(["alias-only-health"]);
  });
});

function seedEvent(input: {
  id: string;
  raw_message_id: string;
  summary: string;
  original_text: string;
  event_type: string;
  entities: string[];
  emotion: { primary: string; intensity: number; valence: string };
  tags: string[];
  event_time: string;
  user_id: string;
}) {
  const db = getDB();
  db.prepare(`
    INSERT INTO memory_events (id, raw_message_id, summary, original_text, event_type, entities, emotion, tags, event_time, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.raw_message_id,
    input.summary,
    input.original_text,
    input.event_type,
    JSON.stringify(input.entities),
    JSON.stringify(input.emotion),
    JSON.stringify(input.tags),
    input.event_time,
    input.user_id,
  );
}

function makeEvent(input: {
  id: string;
  summary: string;
  event_type?: string;
  entities?: string[];
  tags?: string[];
  emotion?: { primary: string; intensity: number; valence: string };
}) {
  return {
    id: input.id,
    raw_message_id: `${input.id}-message`,
    summary: input.summary,
    original_text: input.summary,
    event_type: input.event_type || "other",
    entities: input.entities || [],
    emotion: input.emotion || { primary: "平静", intensity: 0.2, valence: "neutral" },
    tags: input.tags || [],
    event_time: "2026-06-12T09:00:00.000Z",
    user_id: DAD,
  };
}
