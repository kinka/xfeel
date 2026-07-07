import { describe, expect, test } from "bun:test";
import { routeMessage } from "./intent-router";

describe("routeMessage", () => {
  test("routes explicit product commands", () => {
    expect(routeMessage("记：今天星星走了三步")).toMatchObject({ mode: "log", text: "今天星星走了三步", matchedBy: "command" });
    expect(routeMessage("记 今天星星走了三步")).toMatchObject({ mode: "log", text: "今天星星走了三步", matchedBy: "command" });
    expect(routeMessage("记；今天星星走了三步")).toMatchObject({ mode: "log", matchedBy: "pattern" });
    expect(routeMessage("查：夜醒")).toMatchObject({ mode: "recall", text: "夜醒", matchedBy: "command" });
    expect(routeMessage("改：今天是禾禾走了三步")).toMatchObject({ mode: "correct", text: "今天是禾禾走了三步", matchedBy: "command" });
  });

  test("routes archive and undo commands", () => {
    expect(routeMessage("总结今天")).toMatchObject({ mode: "archive" });
    expect(routeMessage("刚刚那条别记")).toMatchObject({ mode: "undo" });
  });

  test("routes short-term conversation requests", () => {
    expect(routeMessage("我们刚刚都聊了啥")).toMatchObject({ mode: "recap" });
    expect(routeMessage("今天我们聊了啥")).toMatchObject({ mode: "recap" });
    expect(routeMessage("那你觉得这时候她的情绪是什么样的")).toMatchObject({ mode: "reflect" });
    expect(routeMessage("结果呢？")).toMatchObject({ mode: "reflect" });
  });

  test("does not let broad recap/reflect patterns swallow real user utterances", () => {
    expect(routeMessage("刚刚星星说了什么新词")).toMatchObject({ mode: "chat" });
    expect(routeMessage("你觉得这个辅食牌子怎么样")).toMatchObject({ mode: "chat" });
    expect(routeMessage("该回家接娃了吧")).toMatchObject({ mode: "chat" });
    expect(routeMessage("星星最近夜醒怎么样？")).toMatchObject({ mode: "recall" });
  });

  test("routes simple greetings as chat instead of logs", () => {
    expect(routeMessage("hello")).toMatchObject({ mode: "chat" });
    expect(routeMessage("你好")).toMatchObject({ mode: "chat" });
  });

  test("routes historical recall and default logs", () => {
    expect(routeMessage("星星上次什么时候生病？")).toMatchObject({ mode: "recall" });
    expect(routeMessage("今天星星自己走了三步")).toMatchObject({ mode: "log" });
    expect(routeMessage("随便聊聊吧")).toMatchObject({ mode: "chat", matchedBy: "default" });
  });

  test("does not treat weak historical words inside narrative logs as recall", () => {
    expect(routeMessage("昨天阿禾看到我在收拾螺丝钉，一下子兴奋起来，自己复刻之前的玩法，还发明了爬树")).toMatchObject({ mode: "log" });
    expect(routeMessage("阿禾之前玩螺丝钉是什么时候？")).toMatchObject({ mode: "recall" });
    // "上次" 出现在叙述背景里（非查询）不应误判为 recall
    expect(routeMessage("阿星咳嗽声又多了起来，又想根治好又犹豫去医院。一诊断说有肺部有喘就让人紧张，上次这种情况可是急诊住院了。")).not.toMatchObject({ mode: "recall" });
    // "上次" + 问句信号仍然是 recall
    expect(routeMessage("星星上次什么时候生病？")).toMatchObject({ mode: "recall" });
  });
});
