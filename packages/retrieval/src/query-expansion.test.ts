import { describe, expect, test } from "bun:test";
import { expandRecallQuery, type FamilyLexiconInput } from "./query-expansion";

// 运行时家庭词典 fixture：替代旧的硬编码家人名
const FIXTURE_FAMILY: FamilyLexiconInput = {
  aliasToLabel: { "阿星": "星星", "星星": "星星", "阿禾": "禾禾", "禾禾": "禾禾" },
  collectiveChildren: ["禾禾", "星星"],
};

describe("query expansion", () => {
  test("segments feeding aliases for choking milk", () => {
    const expansion = expandRecallQuery("星星呛奶鼻子溢出，妈妈及时处理", FIXTURE_FAMILY);

    expect(expansion.tokens).toContain("呛奶");
    expect(expansion.aliases).toEqual(expect.arrayContaining(["溢奶", "吐奶", "喝奶"]));
    expect(expansion.typeHints).toContain("feeding");
    expect(expansion.entityHints).toContain("星星");
  });

  test("without family lexicon, nicknames stay un-expanded", () => {
    const expansion = expandRecallQuery("阿星呛奶");
    expect(expansion.entityHints).toEqual([]);
    expect(expansion.aliases).not.toContain("星星");
  });

  test("expands health phrase 上吐下泻 into symptom aliases", () => {
    const expansion = expandRecallQuery("妈妈记录两个娃上吐下泻崩溃");

    expect(expansion.tokens).toContain("上吐下泻");
    expect(expansion.aliases).toEqual(expect.arrayContaining(["呕吐", "拉肚子", "腹泻"]));
    expect(expansion.typeHints).toEqual(expect.arrayContaining(["health", "emotion"]));
    expect(expansion.tagHints).toEqual(expect.arrayContaining(["腹泻", "育儿压力"]));
    expect(expansion.entityHints).toContain("宝宝们");
  });

  test("segments generic typhoon flight travel terms without private place aliases", () => {
    const expansion = expandRecallQuery("妈妈日本台风航班取消又改签");

    expect(expansion.tokens).toEqual(expect.arrayContaining(["台风", "航班", "航班取消", "改签"]));
    expect(expansion.tokens).not.toContain("日本");
    expect(expansion.aliases).toEqual(expect.arrayContaining(["航班被取消", "天气"]));
    expect(expansion.aliases).not.toContain("日本之行");
    expect(expansion.typeHints).toEqual(expect.arrayContaining(["other", "health"]));
  });

  test("expands magnetic tile play terms without forcing a single type", () => {
    const expansion = expandRecallQuery("阿星看磁力片和磁力墙", FIXTURE_FAMILY);

    expect(expansion.tokens).toEqual(expect.arrayContaining(["磁力片", "磁力墙"]));
    expect(expansion.aliases).toEqual(expect.arrayContaining(["玩具", "亲子互动"]));
    expect(expansion.typeHints).toEqual(expect.arrayContaining(["care", "milestone"]));
    expect(expansion.entityHints).toContain("星星");
  });

  test("keeps broad generic and parent-only queries minimally expanded", () => {
    const generic = expandRecallQuery("宝宝最近怎么样");
    expect(generic.debug.matches).toEqual([]);
    expect(generic.aliases).toEqual([]);
    expect(generic.typeHints).toEqual([]);
    expect(generic.tagHints).toEqual([]);
    expect(generic.entityHints).toEqual([]);

    const parentOnly = expandRecallQuery("妈妈");
    expect(parentOnly.debug.matches).toEqual([]);
    expect(parentOnly.aliases).toEqual([]);
    expect(parentOnly.typeHints).toEqual([]);
    expect(parentOnly.tagHints).toEqual([]);
    expect(parentOnly.entityHints).toEqual([]);
  });

  test("does not inject corpus-specific diary detail aliases", () => {
    const pickup = expandRecallQuery("爸爸下班接娃，两个小腿摇呀摇兴奋跳下来");
    expect(pickup.aliases).not.toEqual(expect.arrayContaining(["门口等我", "小腿摇", "跳下来"]));

    const milk = expandRecallQuery("妈妈安排最后一顿奶十一点喝完");
    expect(milk.aliases).not.toEqual(expect.arrayContaining(["十一点喝完", "十点半", "140"]));

    const swing = expandRecallQuery("荡秋千");
    expect(swing.typeHints).not.toContain("sleep");
  });

  test("does not expand case-specific food, place, or phrase details", () => {
    const icecream = expandRecallQuery("阿星吃冰激凌吐了好几次");
    expect(icecream.tokens).not.toContain("冰激凌");
    expect(icecream.aliases).not.toEqual(expect.arrayContaining(["冰淇淋", "吃东西", "吃啥"]));
    expect(icecream.tagHints).not.toContain("育儿压力");

    const mango = expandRecallQuery("阿禾没吃过芒果却经常挂嘴边");
    expect(mango.tokens).not.toContain("芒果");
    expect(mango.tokens).not.toContain("挂嘴边");
    expect(mango.aliases).not.toEqual(expect.arrayContaining(["水果", "吃东西", "没吃过", "经常提到"]));
    expect(mango.typeHints).not.toContain("feeding");

    const shunde = expandRecallQuery("爸爸周六顺德中午回深圳，带娃很累");
    expect(shunde.tokens).not.toEqual(expect.arrayContaining(["顺德", "深圳", "回深圳"]));
    expect(shunde.aliases).not.toContain("外出");
    expect(shunde.tagHints).not.toEqual(expect.arrayContaining(["外出", "育儿压力"]));

    const walk = expandRecallQuery("宝宝在上学路上户外走路");
    expect(walk.aliases).not.toEqual(expect.arrayContaining(["户外", "大运动"]));
    expect(walk.tagHints).not.toContain("育儿压力");
  });

  test("does not expand broad one-character substrings", () => {
    const station = expandRecallQuery("爸爸去车站接人");
    expect(station.tokens).not.toContain("站");
    expect(station.aliases).not.toContain("学站");
    expect(station.tagHints).not.toContain("站立");

    const website = expandRecallQuery("网站打不开");
    expect(website.tokens).not.toContain("站");

    const tooth = expandRecallQuery("牙齿刷得很好");
    expect(tooth.tokens).toContain("牙齿");
    const generic = expandRecallQuery("象牙白的杯子");
    expect(generic.tokens).not.toContain("牙");
  });

  test("keeps generic pressure out of work hints unless work terms are present", () => {
    const parentingPressure = expandRecallQuery("带娃压力很大有点焦虑");
    expect(parentingPressure.typeHints).toContain("emotion");
    expect(parentingPressure.typeHints).not.toContain("work");
    expect(parentingPressure.tagHints).toContain("育儿压力");
    expect(parentingPressure.tagHints).not.toContain("工作压力");

    const work = expandRecallQuery("客户订单压力很大");
    expect(work.typeHints).toContain("work");
    expect(work.tagHints).toContain("工作压力");
  });
});
