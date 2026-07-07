import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 模拟共情回复模型：它"主动"调用 recall_memory 工具，再据结果作答。
// chat/chatJSON 抛错 → 意图解析走规则兜底，保持确定性。
const toolInvocations: Array<Record<string, unknown>> = [];
const chatInvocations: string[] = [];
mock.module("../../ai-client/src/llm", () => ({
  getLLM() {
    return {
      async chat(prompt: string) {
        chatInvocations.push(prompt);
        return "我翻到最近的一条是在 2026-05-27：那天爸爸感到压力。我先按这条给你对上，如果你想看更早的，我可以继续往前翻。";
      },
      async chatJSON() { throw new Error("no json in test"); },
      async respondWithTools({ prompt, tools }: { prompt: string; tools: Array<{ name: string; run: (a: Record<string, unknown>) => Promise<unknown> }> }) {
        const tool = tools.find(t => t.name === "recall_memory")!;
        if (prompt.includes("这个月")) {
          const args = {
            query: "爸爸 这个月经历",
            intent: "window_recap",
            source: "mixed",
            time: {
              raw: "这个月",
              period: "this_month",
              since: "2026-06-01",
              until: "2026-06-21",
              confidence: 0.95,
            },
          };
          toolInvocations.push(args);
          const result = await tool.run(args) as Array<{ date?: string; summary: string; source?: string }>;
          return {
            text: `这个月主要有这些：${result.map(item => item.summary).join("；")}`,
            toolCalls: [{ name: "recall_memory", args, result }],
          };
        }

        const args = { query: "爸爸 压力", emotions: ["压力"], direction: "latest" };
        toolInvocations.push(args);
        const result = await tool.run(args) as Array<{ date?: string; summary: string }>;
        // 模拟 reply LLM 从召回到的多条里挑"上次"(最新)那条作答。
        const sorted = Array.isArray(result) ? [...result].sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? ""))) : [];
        const top = sorted[0];
        return {
          text: top ? `爸爸上次压力大是在 ${top.date}：${top.summary}。如果你想看更早的，我可以继续往前翻。` : "我没找到相关记录。",
          toolCalls: [{ name: "recall_memory", args, result }],
        };
      },
    };
  },
}));

const { getDB, closeDB } = await import("../../db/src/database");
const { initSchema } = await import("../../db/src/schema");
const { chatWithMemory } = await import("./conversation");

const DAD = "demo-dad-owner";
const MOM = "demo-mom-owner";

function seedPressureFor(owner: string, id: string, date: string) {
  getDB().prepare(`
    INSERT INTO memory_events (id, raw_message_id, summary, original_text, event_type, entities, emotion, tags, event_date, event_time, user_id)
    VALUES (?, ?, ?, ?, 'emotion', ?, ?, '[]', ?, ?, ?)
  `).run(id, `${id}-msg`, `${date} 我感到压力`, `${date} 我感到压力`, JSON.stringify(["爸爸"]),
    JSON.stringify({ primary: "压力", intensity: 0.8, valence: "negative" }), date, `${date}T12:00:00.000Z`, owner);
}

function seedPressure(id: string, date: string) {
  seedPressureFor(DAD, id, date);
}

function seedArchive(id: string, date: string, summary: string) {
  getDB().prepare(`
    INSERT INTO daily_archives (id, owner_id, archive_date, summary, source_turn_ids, event_ids, status)
    VALUES (?, ?, ?, ?, '[]', '[]', 'done')
  `).run(id, DAD, date, summary);
}

describe("empathetic reply with on-demand recall tool", () => {
  let dbPath = "";
  beforeEach(() => {
    closeDB();
    toolInvocations.length = 0;
    chatInvocations.length = 0;
    dbPath = join(tmpdir(), `xfeel-tool-recall-${crypto.randomUUID()}.db`);
    initSchema(getDB(dbPath));
    seedPressure("p-0504", "2026-05-04");
    seedPressure("p-0527", "2026-05-27");
  });
  afterEach(() => {
    closeDB();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });

  test("recall question goes through the tool loop and answers from retrieved memory", async () => {
    const result = await chatWithMemory({ text: "爸爸上次压力大是什么时候", owner_id: DAD, mode: "recall" });

    // 统一走 tool-loop：reply LLM 主动调 recall_memory（语义+全文召回），据结果作答；
    // 不再有基于情绪词的结构化快路（它会被情绪过滤劫持、且整句召回不聚焦）。
    expect(toolInvocations).toHaveLength(1);
    expect(result.recalled.map(e => e.id)).toContain("p-0527");
    expect(result.reply).toContain("2026-05-27");
    expect(result.reply).toContain("继续往前翻");
  });

  test("window recap uses LLM-extracted time window to read daily archives", async () => {
    seedArchive("a-0612", "2026-06-12", "爸爸发现阿星走路和生病等关键成长节点记录不完整。");
    seedArchive("a-0618", "2026-06-18", "雨天接娃，阿星见到爸爸很开心，阿禾主动如厕。");
    seedArchive("a-0620", "2026-06-20", "阿星咳嗽让爸爸担心，晚上刷牙和乱扔杯子带来育儿冲突。");
    getDB().prepare(`
      INSERT INTO conversation_turns (id, owner_id, role, content, turn_date, source, metadata)
      VALUES (?, ?, 'user', ?, '2026-06-21', 'log', ?)
    `).run("today-log", DAD, "两个宝宝这个假期可玩性又增加了，会自己穿鞋准备出发。", JSON.stringify({ mode: "log_with_contextual_reply" }));

    const result = await chatWithMemory({
      text: "这个月我都经历了什么呀",
      owner_id: DAD,
      date: "2026-06-21",
      mode: "auto",
      limit: 6,
    });

    expect(toolInvocations).toHaveLength(1);
    expect(toolInvocations[0]).toMatchObject({
      intent: "window_recap",
      time: { period: "this_month", since: "2026-06-01", until: "2026-06-21" },
    });
    expect(result.reply).toContain("2026-06-12");
    expect(result.reply).toContain("2026-06-18");
    expect(result.reply).toContain("2026-06-20");
    expect(result.reply).toContain("2026-06-21 未归档日志");
    expect(result.recalled.map(item => item.id)).toEqual([
      "archive:a-0612",
      "archive:a-0618",
      "archive:a-0620",
      "turn:today-log",
    ]);
  });

  // 家庭共享记忆（P1）：召回按家庭成员 owner 池扇出，妈妈能召回到爸爸记的事，
  // 但不带 scope 时仍只看自己池。p-0504/p-0527 在 beforeEach 已 seed 到爸爸池。
  test("family scope recall surfaces a memory recorded by another family member", async () => {
    seedPressureFor(MOM, "mom-0601", "2026-06-01");

    const shared = await chatWithMemory({
      text: "上次压力大是什么时候",
      owner_id: MOM,
      scope_owner_ids: [MOM, DAD],
      mode: "recall",
    });

    const ids = shared.recalled.map(e => e.id);
    expect(ids).toContain("p-0527"); // 爸爸池里记的，跨池召回到
    expect(ids).toContain("mom-0601"); // 自己池里的也在
  });

  test("without family scope, recall stays within the speaker's own pool", async () => {
    seedPressureFor(MOM, "mom-0601", "2026-06-01");

    const selfOnly = await chatWithMemory({
      text: "上次压力大是什么时候",
      owner_id: MOM,
      mode: "recall",
    });

    const ids = selfOnly.recalled.map(e => e.id);
    expect(ids).toContain("mom-0601"); // 自己池能召回
    expect(ids).not.toContain("p-0527"); // 看不到爸爸池
    expect(ids).not.toContain("p-0504");
  });

  // 家庭共享记忆（P2）：跨池召回到的记录标注"谁记的"；本人记的不标。
  test("recalled memories from another member carry a recorder label", async () => {
    const db = getDB();
    db.prepare("INSERT INTO families (id, name) VALUES ('fam', '测试家庭')").run();
    db.prepare("INSERT INTO family_members (id, family_id, label, role) VALUES (?, 'fam', '爸爸', 'parent')").run(DAD);
    db.prepare("INSERT INTO family_members (id, family_id, label, role) VALUES (?, 'fam', '妈妈', 'parent')").run(MOM);
    seedPressureFor(MOM, "mom-0601", "2026-06-01");

    const shared = await chatWithMemory({
      text: "上次压力大是什么时候",
      owner_id: MOM,
      scope_owner_ids: [MOM, DAD],
      mode: "recall",
    });

    const dadItem = shared.recalled.find(e => e.id === "p-0527");
    const momItem = shared.recalled.find(e => e.id === "mom-0601");
    expect(dadItem?.recorder).toBe("爸爸"); // 爸爸记的，点明来源
    expect(momItem?.recorder).toBeUndefined(); // 说话人本人记的，不标
  });
});
