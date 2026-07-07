import { describe, expect, test } from "bun:test";
import {
  normalizeEmotionPayload,
  normalizeEntities,
  normalizeEntity,
  normalizeEventType,
} from "./normalization";
import { normalizeEmotion } from "./emotion-vocabulary";
import { normalizeTag, normalizeTags } from "./tag-vocabulary";
import { resolveOwnerContext } from "./owner";
import { buildAliasContext } from "./family";

describe("domain normalization", () => {
  test("resolves owner ids and self references", () => {
    const context = resolveOwnerContext({ ownerId: "demo-dad-owner" });

    expect(context.ownerLabel).toBe("爸爸");
    expect(normalizeEntity("我", context)).toBe("爸爸");
    expect(normalizeEntity("老婆", context)).toBe("妈妈");
    expect(
      normalizeEntities(["我", "老婆", "星星"], context, "我和老婆带星星去打疫苗"),
    ).toEqual(["爸爸", "妈妈", "星星"]);
  });

  test("without family profile, keeps nicknames and collective terms as-is", () => {
    // 没有家庭 profile 时不做任何具体人名映射：昵称原样保留，集合称呼不臆测展开
    expect(normalizeEntity("阿星")).toBe("阿星");
    expect(normalizeEntity("小禾")).toBe("小禾");
    expect(normalizeEntities(["宝宝们"])).toEqual(["宝宝们"]);
    expect(normalizeEntities(["两个孩子", "爸爸"])).toEqual(["两个孩子", "爸爸"]);
  });

  test("normalizes child aliases and collective child entities from alias context", () => {
    const aliasContext = buildAliasContext({
      familyId: "fam-fixture",
      childLabels: ["禾禾", "星星"],
      aliases: [
        { alias: "阿星", memberId: "child-2", label: "星星", scope: "global" },
        { alias: "阿禾", memberId: "child-1", label: "禾禾", scope: "global" },
        { alias: "爸爸", memberId: "dad", label: "爸爸", scope: "global" },
      ],
    });
    const context = resolveOwnerContext({ ownerId: "fixture-owner", aliasContext });

    expect(normalizeEntity("阿星", context)).toBe("星星");
    expect(normalizeEntity("阿禾", context)).toBe("禾禾");
    expect(normalizeEntities(["宝宝们"], context)).toEqual(["禾禾", "星星"]);
    expect(normalizeEntities(["孩子们", "阿星"], context)).toEqual(["禾禾", "星星"]);
    expect(normalizeEntities(["两个孩子", "爸爸"], context)).toEqual(["禾禾", "星星", "爸爸"]);
  });

  test("uses family alias context for self references, adjustable aliases, and collective children", () => {
    const aliasContext = buildAliasContext({
      familyId: "fam-1",
      speakerProfileId: "speaker-dad",
      selfMemberId: "dad",
      selfLabel: "爸爸",
      childLabels: ["小禾", "小星"],
      aliases: [
        { alias: "阿星", memberId: "child-2", label: "小星", scope: "global" },
        { alias: "星星", memberId: "child-2", label: "小星", scope: "global" },
        { alias: "阿禾", memberId: "child-1", label: "小禾", scope: "global" },
        { alias: "禾禾", memberId: "child-1", label: "小禾", scope: "global" },
        { alias: "我老婆", memberId: "mom", label: "妈妈", scope: "speaker", speakerProfileId: "speaker-dad" },
      ],
    });
    const context = resolveOwnerContext({ ownerId: "custom-owner", aliasContext });

    expect(normalizeEntity("我", context)).toBe("爸爸");
    expect(normalizeEntity("阿星", context)).toBe("小星");
    expect(normalizeEntity("阿禾", context)).toBe("小禾");
    expect(normalizeEntity("我老婆", context)).toBe("妈妈");
    expect(normalizeEntities(["宝宝们", "阿禾"], context, "我 带宝宝们出门")).toEqual(["小禾", "小星", "爸爸"]);
    expect(normalizeEntities(["星星"], context, "星星今天很开心")).toEqual(["小星"]);
    expect(normalizeEntities(["我老婆"], context, "我老婆今天很累")).toEqual(["妈妈"]);
  });

  test("normalizes event types, tags, and emotions", () => {
    expect(normalizeEventType("睡眠问题")).toBe("sleep");
    expect(normalizeEventType("工作")).toBe("work");
    expect(normalizeEventType("旅行")).toBe("daily");
    expect(normalizeTag("打疫苗")).toBe("疫苗");
    expect(normalizeTag("吐了")).toBe("呕吐");
    expect(normalizeTag("旅游")).toBe("旅行");
    expect(normalizeTags(["打疫苗", "疫苗", "压力大", "吃啥吐啥", "出游"])).toEqual(["疫苗", "育儿压力", "呕吐", "旅行"]);
    expect(normalizeEmotion("好累")?.word).toBe("疲惫");

    expect(
      normalizeEmotionPayload({ primary: "好累", intensity: 5, valence: "neutral" }),
    ).toEqual({
      primary: "疲惫",
      secondary: undefined,
      intensity: 1,
      valence: "negative",
    });
  });
});
