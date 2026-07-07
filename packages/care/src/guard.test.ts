import { describe, expect, test } from "bun:test";
import { isResurfaceable } from "./guard";

describe("resurface guard", () => {
  test("blocks loss/trauma content from proactive resurfacing", () => {
    expect(isResurfaceable({ summary: "外婆去世了，全家都很难过" })).toBe(false);
    expect(isResurfaceable({ summary: "这周流产后在家休养" })).toBe(false);
    expect(isResurfaceable({ summary: "和老公谈到了离婚" })).toBe(false);
    expect(isResurfaceable({ summary: "普通的一天", original_text: "爷爷进了ICU抢救" })).toBe(false);
  });

  test("blocks grief emotion even without keywords", () => {
    expect(isResurfaceable({ summary: "整理了旧照片", emotion: { primary: "悲痛" } })).toBe(false);
    expect(isResurfaceable({ summary: "整理了旧照片", emotion: '{"primary":"悲痛"}' })).toBe(false);
  });

  test("allows recoverable negatives and ordinary memories", () => {
    expect(isResurfaceable({ summary: "星星发烧到39度，我好担心", emotion: { primary: "担心" } })).toBe(true);
    expect(isResurfaceable({ summary: "工作压力大，加班到十一点" })).toBe(true);
    expect(isResurfaceable({ summary: "第一次带宝宝去游泳，特别开心" })).toBe(true);
  });
});
