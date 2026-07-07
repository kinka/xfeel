import { describe, expect, test } from "bun:test";
import { buildAliasContext } from "../../domain/src/family";
import { resolveOwnerContext } from "../../domain/src/owner";
import { buildExtractPrompt, ruleBasedExtract } from "./extract";

describe("extract identity context", () => {
  const aliasContext = buildAliasContext({
    familyId: "fam-1",
    speakerProfileId: "speaker-dad",
    selfMemberId: "dad",
    selfLabel: "爸爸",
    childLabels: ["小禾", "小星"],
    aliases: [
      { alias: "阿星", memberId: "child-tu", label: "小星", scope: "global" },
      { alias: "星星", memberId: "child-tu", label: "小星", scope: "global" },
      { alias: "阿禾", memberId: "child-pf", label: "小禾", scope: "global" },
      { alias: "禾禾", memberId: "child-pf", label: "小禾", scope: "global" },
      { alias: "我老婆", memberId: "mom", label: "妈妈", scope: "speaker", speakerProfileId: "speaker-dad" },
    ],
  });

  test("injects family profile aliases into the LLM prompt", () => {
    const prompt = buildExtractPrompt("我老婆带阿星和阿禾出门", resolveOwnerContext({ ownerId: "dad-owner", aliasContext }));

    expect(prompt).toContain("身份上下文");
    expect(prompt).toContain("collective_children=小禾、小星");
    expect(prompt).toContain("- 我老婆 => 妈妈 (speaker speaker=speaker-dad)");
    expect(prompt).toContain("- 阿星 => 小星 (global)");
    expect(prompt).toContain("- 阿禾 => 小禾 (global)");
  });

  test("rule fallback uses profile aliases before built-in legacy aliases", () => {
    const [event] = ruleBasedExtract("今天我老婆带阿星和阿禾出门", { ownerId: "dad-owner", aliasContext });

    expect(new Set(event?.entities)).toEqual(new Set(["妈妈", "小星", "小禾"]));
  });

  test("injects recent dialogue block so classifier can spot continuation replies", () => {
    const ctx = resolveOwnerContext({ ownerId: "dad-owner" });
    const dialogue = "助手: 西瓜摔地上阿禾什么反应？\n用户: 崩溃。。。";
    const prompt = buildExtractPrompt("崩溃。。。", ctx, dialogue);

    expect(prompt).toContain("最近对话");
    expect(prompt).toContain("助手: 西瓜摔地上阿禾什么反应？");
  });

  test("omits the dialogue block when no recent dialogue is given", () => {
    const ctx = resolveOwnerContext({ ownerId: "dad-owner" });
    const prompt = buildExtractPrompt("阿星今天发烧了", ctx);

    expect(prompt).not.toContain("最近对话");
  });
});
