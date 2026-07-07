import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

mock.module("../../ai-client/src/llm", () => ({
  getLLM() {
    return {
      async chat() {
        throw new Error("LLM unavailable in test");
      },
    };
  },
}));

const { getDB, closeDB, closeEmbeddingDB } = await import("../../db/src/database");
const { initSchema } = await import("../../db/src/schema");
const { chatWithMemory, recordConversationTurn } = await import("./conversation");

const DAD = "demo-dad-owner";

describe("chatWithMemory", () => {
  let dbPath = "";
  let vecDbPath = "";
  const originalVecPath = process.env.XFEEL_VEC_DB_PATH;

  beforeEach(() => {
    closeEmbeddingDB();
    closeDB();
    dbPath = join(tmpdir(), `xfeel-chat-${crypto.randomUUID()}.db`);
    vecDbPath = join(tmpdir(), `xfeel-chat-${crypto.randomUUID()}.vec.db`);
    process.env.XFEEL_VEC_DB_PATH = vecDbPath;
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
    rmSync(vecDbPath, { force: true });
    rmSync(`${vecDbPath}-shm`, { force: true });
    rmSync(`${vecDbPath}-wal`, { force: true });
  });

  test("answers simple greetings without LLM, recall, or logging them as memories", async () => {
    seedEvent({
      id: "unrelated",
      summary: "星星语言表达明显进步",
      original_text: "星星最近语言大爆发。",
      event_type: "milestone",
      entities: ["星星"],
      tags: ["语言表达"],
      event_time: "2026-06-10T15:00:05.798Z",
      user_id: DAD,
    });

    const result = await chatWithMemory({ text: "hello", owner_id: DAD });

    expect(result.mode).toBe("chat");
    expect(result.reply).toBe("hello，我在。");
    expect(result.recalled).toEqual([]);
    expect(getDB().prepare("SELECT COUNT(*) AS c FROM memory_events").get()).toEqual({ c: 1 });
  });

  test("recalls keyword-related memories when the whole chat question is not an exact text match", async () => {
    seedEvent({
      id: "language-oxygen",
      summary: "星星语言表达明显进步",
      original_text: "星星最近语言大爆发，会主动表达需求，也会重复我们说的词。",
      event_type: "milestone",
      entities: ["星星"],
      tags: ["语言表达"],
      event_time: "2026-06-10T15:00:05.798Z",
      user_id: DAD,
    });

    const result = await chatWithMemory({
      text: "星星最近语言表达怎么样？有没有之前类似记录？",
      owner_id: DAD,
      limit: 5,
    });

    expect(result.recalled.map(event => event.id)).toContain("language-oxygen");
    expect(result.assistant_turn.metadata).toEqual({ recalled_event_ids: ["language-oxygen"] });
    expect(result.reply).toContain("星星语言表达明显进步");
  });

  test("recalls illness memories from a natural latest-illness question", async () => {
    seedEvent({
      id: "fever-oxygen",
      summary: "阿星发烧38.7度",
      original_text: "阿星发烧38.7度，需要观察体温。",
      event_type: "health",
      entities: ["星星"],
      tags: ["发烧"],
      event_time: "2025-07-02T15:25:31.435Z",
      user_id: DAD,
    });
    seedEvent({
      id: "recent-reading-oxygen",
      summary: "阿星最近喜欢看绘本",
      original_text: "阿星最近喜欢看绘本和磁力片。",
      event_type: "daily",
      entities: ["星星"],
      tags: ["绘本"],
      event_time: "2026-06-10T15:00:05.798Z",
      user_id: DAD,
    });
    seedEvent({
      id: "archive-reflection",
      raw_message_id: "daily-archive-id",
      summary: "爸爸发现阿星走路和生病等关键成长节点记录不完整",
      original_text: "日期：2026-06-12\n记录者：爸爸\n\n当天总结：\n2026-06-12 爸爸的对话归档：阿星什么时候会走路的? 阿星上次什么时候生病",
      event_type: "reflection",
      entities: ["星星", "爸爸"],
      tags: ["发烧", "走路"],
      event_time: "2026-06-12T00:00:00.000Z",
      user_id: DAD,
    });
    const db = getDB();
    db.prepare(`
      INSERT INTO daily_archives (id, owner_id, archive_date, summary, source_turn_ids, event_ids)
      VALUES (?, ?, ?, ?, '[]', '[]')
    `).run("daily-archive-id", DAD, "2026-06-12", "archive summary");

    const result = await chatWithMemory({
      text: "阿星上次什么时候生病？",
      owner_id: DAD,
      limit: 1,
    });

    expect(result.recalled.map(event => event.id)).toContain("fever-oxygen");
    expect(result.reply).toContain("阿星发烧38.7度");
    expect(result.reply).not.toContain("我记下来了");
    expect(result.reply).not.toContain("今晚归档");
  });

  test("answers question intents instead of treating them as new memories", async () => {
    const result = await chatWithMemory({
      text: "这个明显是个问题吧？那不应该直接记下来吧？",
      owner_id: DAD,
      limit: 5,
    });

    expect(result.reply).not.toContain("我记下来了");
    expect(result.reply).not.toContain("今晚归档");
    // 问题意图不会被当成新记忆归档；兜底回复保持温和、在场即可。
    expect(result.reply.trim().length).toBeGreaterThan(0);
  });

  test("answers whether the previous log was saved with the latest saved log", async () => {
    recordConversationTurn({
      content: "我想起上午，我在书房跟老婆说了句话，马上听到咚咚咚的跑步声，是阿星起床了，跑了过来找我。",
      owner_id: DAD,
      turn_date: "2026-06-18",
      role: "user",
      source: "log",
      metadata: { mode: "log_with_contextual_reply", current_event_ids: ["event-1"] },
    });

    const result = await chatWithMemory({
      text: "我上条日志记好了吗",
      owner_id: DAD,
      date: "2026-06-18",
      limit: 5,
    });

    expect(result.reply).toContain("记好了");
    expect(result.reply).toContain("阿星起床了");
    expect(result.reply).not.toContain("这是一个问题，我会按提问来回答");
    expect(result.recalled).toEqual([]);
  });

  test("does not leak another owner's latest log when answering saved-status questions", async () => {
    recordConversationTurn({
      content: "妈妈侧的私密日志。",
      owner_id: "demo-mom-owner",
      turn_date: "2026-06-18",
      role: "user",
      source: "log",
      metadata: { mode: "log_with_contextual_reply", current_event_ids: ["mom-event"] },
    });

    const result = await chatWithMemory({
      text: "我上条日志记好了吗",
      owner_id: DAD,
      date: "2026-06-18",
      limit: 5,
    });

    expect(result.reply).toContain("没找到今天上一条已保存的日志");
    expect(result.reply).not.toContain("私密日志");
    expect(result.recalled).toEqual([]);
  });

  test("does not answer follow-up emotion discussion by dumping an unrelated recalled memory", async () => {
    seedEvent({
      id: "singing-oxygen",
      summary: "阿星今晚听到我唱拔萝卜之后一直跟学，自己唱得很认真",
      original_text: "阿星今晚听到我唱拔萝卜之后，一直也在跟学，自己唱，虽然只有个别字在线，但听得出来是在学。",
      event_type: "milestone",
      entities: ["星星"],
      tags: ["唱歌", "语言表达"],
      event_time: "2026-06-17T20:00:00.000Z",
      user_id: DAD,
    });

    const result = await chatWithMemory({
      text: "那你觉得这时候她的情绪是什么样的",
      owner_id: DAD,
      limit: 5,
    });

    expect(result.reply).not.toContain("阿星今晚听到我唱拔萝卜");
    expect(result.reply).not.toMatch(/^2026-06-17/);
    expect(result.reply).not.toContain("我记下来了");
    expect(result.recalled).toEqual([]);
    expect(result.reply).toContain("情绪");
  });

  test("treats recent-chat recap phrased with 啥 as short-term recap, not a new log", async () => {
    seedEvent({
      id: "singing-oxygen",
      summary: "阿星今晚听到我唱拔萝卜之后一直跟学，自己唱得很认真",
      original_text: "阿星今晚听到我唱拔萝卜之后，一直也在跟学，自己唱，虽然只有个别字在线，但听得出来是在学。",
      event_type: "milestone",
      entities: ["星星"],
      tags: ["唱歌", "语言表达"],
      event_time: "2026-06-17T20:00:00.000Z",
      user_id: DAD,
    });

    const result = await chatWithMemory({
      text: "我们刚刚都聊了啥",
      owner_id: DAD,
      limit: 5,
    });

    expect(result.reply).not.toContain("我记下来了");
    expect(result.reply).not.toContain("有点相关");
    expect(result.reply).not.toContain("今晚归档");
    expect(result.reply).not.toContain("阿星今晚听到我唱拔萝卜");
    expect(result.recalled).toEqual([]);
    expect(result.reply).toContain("刚刚这段我能看到的上下文不多");
  });

  test("recaps recent conversation turns without recalling old memories", async () => {
    seedEvent({
      id: "singing-oxygen",
      summary: "阿星今晚听到我唱拔萝卜之后一直跟学，自己唱得很认真",
      original_text: "阿星今晚听到我唱拔萝卜之后，一直也在跟学，自己唱，虽然只有个别字在线，但听得出来是在学。",
      event_type: "milestone",
      entities: ["星星"],
      tags: ["唱歌", "语言表达"],
      event_time: "2026-06-17T20:00:00.000Z",
      user_id: DAD,
    });
    recordConversationTurn({
      content: "今天星星自己走了三步，爸爸特别开心。",
      owner_id: DAD,
      turn_date: "2026-06-18",
      role: "user",
      source: "log",
    });
    recordConversationTurn({
      content: "记下来了。",
      owner_id: DAD,
      turn_date: "2026-06-18",
      role: "assistant",
      source: "contextual_log_reply",
    });
    recordConversationTurn({
      content: "后来我们又聊到她走路时有点谨慎。",
      owner_id: DAD,
      turn_date: "2026-06-18",
      role: "user",
      source: "chat",
    });

    const result = await chatWithMemory({
      text: "我们刚刚都聊了啥",
      owner_id: DAD,
      date: "2026-06-18",
      limit: 5,
    });

    expect(result.reply).toContain("刚刚主要是在聊");
    expect(result.reply).toContain("星星自己走了三步");
    expect(result.reply).toContain("走路时有点谨慎");
    expect(result.reply).not.toContain("我记下来了");
    expect(result.reply).not.toContain("有点相关");
    expect(result.reply).not.toContain("阿星今晚听到我唱拔萝卜");
    expect(result.recalled).toEqual([]);
  });
});

function seedEvent(input: {
  id: string;
  raw_message_id?: string;
  summary: string;
  original_text: string;
  event_type: string;
  entities: string[];
  tags: string[];
  event_time: string;
  user_id: string;
  source?: string;
  source_layer?: string;
}) {
  const db = getDB();
  db.prepare(`
    INSERT INTO memory_events (id, raw_message_id, summary, original_text, event_type, entities, tags, event_time, user_id, source, source_layer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.raw_message_id || null,
    input.summary,
    input.original_text,
    input.event_type,
    JSON.stringify(input.entities),
    JSON.stringify(input.tags),
    input.event_time,
    input.user_id,
    input.source || "user",
    input.source_layer || "extracted",
  );
}
