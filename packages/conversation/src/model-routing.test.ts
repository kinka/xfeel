import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * 验证 LLM 角色拆分的实际接线：每个角色把 ROLE_MODELS[role] 传给 getLLM。
 * 当前 extract/intent/reply 统一为同一模型，但断言仍按角色常量取值，
 * 这样将来再拆分不同模型时测试无需改写。
 * 通过 mock getLLM 捕获每次调用时传入的 model 来断言。
 */
const calls: Array<{ model?: string; method: "chat" | "chatJSON"; prompt: string }> = [];

mock.module("../../ai-client/src/llm", () => ({
  getLLM(config?: { model?: string }) {
    const model = config?.model;
    return {
      async chat(prompt: string) {
        calls.push({ model, method: "chat", prompt });
        return "记下来了，听起来今天挺不容易的，星星的笑确实很治愈。";
      },
      async chatJSON(prompt: string) {
        calls.push({ model, method: "chatJSON", prompt });
        if (prompt.includes("意图")) return { mode: "chat", confidence: 0.82 };
        return [];
      },
    };
  },
}));

const { getDB, closeDB } = await import("../../db/src/database");
const { initSchema } = await import("../../db/src/schema");
const { extract } = await import("../../extractors/src/extract");
const { classifyIntentLLM } = await import("./intent-classifier");
const { chatWithMemory } = await import("./conversation");
const { ROLE_MODELS } = await import("../../ai-client/src/roles");

const DAD = "demo-dad-owner";
const DATE = "2026-06-18";

describe("LLM role-to-model routing", () => {
  let dbPath = "";

  beforeEach(() => {
    closeDB();
    dbPath = join(tmpdir(), `xfeel-model-routing-${crypto.randomUUID()}.db`);
    initSchema(getDB(dbPath));
    calls.length = 0;
  });

  afterEach(() => {
    closeDB();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });

  test("role model constants are the requested models", () => {
    expect(ROLE_MODELS.extract).toBe("claude-sonnet-4-6");
    expect(ROLE_MODELS.intent).toBe("claude-sonnet-4-6");
    expect(ROLE_MODELS.reply).toBe("claude-sonnet-4-6");
  });

  test("extraction calls the extract role model", async () => {
    await extract("今天星星自己走了三步，爸爸特别开心。");
    expect(calls.some(c => c.method === "chatJSON" && c.model === ROLE_MODELS.extract)).toBe(true);
  });

  test("intent recognition calls the intent role model and is marked llm-routed", async () => {
    const result = await classifyIntentLLM("你觉得她那会儿是什么情绪");
    expect(result?.matchedBy).toBe("llm");
    expect(calls.some(c => c.method === "chatJSON" && c.model === ROLE_MODELS.intent)).toBe(true);
  });

  test("empathetic reply calls the reply role model", async () => {
    await chatWithMemory({
      text: "今天上班被领导说了一通，有点累，但回家看到星星笑就缓过来了。",
      owner_id: DAD,
      date: DATE,
      mode: "chat",
    });
    expect(calls.some(c => c.method === "chat" && c.model === ROLE_MODELS.reply)).toBe(true);
  });
});
