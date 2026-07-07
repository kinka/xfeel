import { beforeEach, describe, expect, mock, test } from "bun:test";

const llmCalls: string[] = [];

mock.module("../../ai-client/src/llm", () => ({
  getLLM() {
    return {
      async chatJSON(prompt: string) {
        llmCalls.push(prompt);
        return { mode: "recall", confidence: 0.91 };
      },
    };
  },
}));

const { routeMessageSmart } = await import("./intent-router");

describe("routeMessageSmart", () => {
  beforeEach(() => {
    llmCalls.length = 0;
  });

  test("explicit commands bypass LLM entirely", async () => {
    const result = await routeMessageSmart("记：今天星星走了三步");

    expect(llmCalls).toHaveLength(0);
    expect(result).toMatchObject({ mode: "log", matchedBy: "command" });
  });

  test("natural language always goes to LLM — even clear-looking recall", async () => {
    const result = await routeMessageSmart("爸爸上次压力大是什么时候");

    expect(llmCalls).toHaveLength(1);
    expect(result).toMatchObject({ mode: "recall", matchedBy: "llm" });
  });

  test("natural language always goes to LLM — even narrative logs", async () => {
    // Pattern rules would say "log"; LLM mock returns "recall".
    // New behavior: LLM wins, not pattern rules.
    const result = await routeMessageSmart("昨天阿禾看到我在收拾螺丝钉，一下子兴奋起来，自己复刻之前的玩法，还发明了爬树");

    expect(llmCalls).toHaveLength(1);
    expect(result).toMatchObject({ mode: "recall", matchedBy: "llm" });
  });

  test("LLM result overrides pattern rules", async () => {
    // "上次这种情况可是急诊住院了" — pattern might say log, LLM mock says recall; LLM should win.
    const result = await routeMessageSmart("阿星咳嗽声又多了起来，上次这种情况可是急诊住院了");

    expect(llmCalls).toHaveLength(1);
    expect(result).toMatchObject({ matchedBy: "llm" });
  });
});
