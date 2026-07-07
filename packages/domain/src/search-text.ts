import type { MemoryEvent } from "./memory-event";
import { factsToSearchText, normalizeOpenFacts, type OpenFact } from "./open-facts";

export interface SearchTextInput {
  summary?: string;
  original_text?: string;
  event_type?: string;
  entities?: string[];
  tags?: string[];
  emotion?: { primary?: string; secondary?: string; valence?: string };
  open_facts?: OpenFact[];
  location?: string;
  user_id?: string;
}

const EVENT_TYPE_TERMS: Record<string, string[]> = {
  sleep: ["睡眠", "睡觉", "入睡", "哄睡", "夜醒", "午睡"],
  feeding: ["喂养", "吃饭", "吃东西", "进食", "辅食", "吃奶", "喝奶"],
  health: ["健康", "生病", "不舒服", "发烧", "咳嗽", "打针", "疫苗"],
  milestone: ["成长", "里程碑", "进展", "大运动", "表达", "说话", "走路"],
  emotion: ["情绪", "心情", "感受"],
  care: ["照护", "护理", "洗澡", "换尿布"],
  conflict: ["冲突", "闹别扭", "抢", "吵", "玩具"],
  work: ["工作", "项目", "汇报", "压力", "松口气"],
  social: ["社交", "朋友", "外出"],
  daily: ["日常", "生活", "记录"],
  reflection: ["反思", "复盘", "感悟"],
};

const ALIAS_RULES: Array<[RegExp, string[]]> = [
  [/疫苗|打针|接种|预防针/, ["疫苗", "打针", "接种", "预防针", "不舒服"]],
  [/辅食|自主进食|吃饭|吃东西|进食|吃奶|喝奶|奶粉|母乳/, ["辅食", "吃饭", "吃东西", "进食", "喂养", "营养", "吃奶", "喝奶"]],
  [/夜醒|自主入睡|睡眠不足|睡眠|睡觉|入睡|哄睡|午睡/, ["睡眠", "睡觉", "入睡", "哄睡", "夜里醒", "夜醒", "午睡"]],
  [/说话|语言|表达|开口/, ["说话", "表达", "开口", "语言表达", "进展"]],
  [/走路|站立|爬行|翻身|大运动|扶站|迈步/, ["大运动", "走路", "扶站", "迈步", "站立", "爬行", "里程碑"]],
  [/压力|工作压力|育儿压力|疲惫|焦虑|崩溃/, ["压力", "压力大", "疲惫", "焦虑", "撑不住", "累"]],
  [/释然|放心|松口气|顺利/, ["释然", "松口气", "放心", "顺利", "positive"]],
  [/双胞胎互动|两个宝宝|俩宝|玩具|闹别扭|冲突/, ["双胞胎", "两个宝宝", "玩具", "闹别扭", "冲突", "抢"]],
  [/发烧|咳嗽|感冒|腹泻|湿疹|便秘|出牙/, ["健康", "生病", "不舒服", "发烧", "咳嗽", "感冒"]],
];

export function buildCanonicalSearchText(input: SearchTextInput | MemoryEvent): string {
  const pieces: string[] = [];
  const add = (value?: string) => {
    const cleaned = value?.trim();
    if (cleaned) pieces.push(cleaned);
  };

  add(input.summary);
  add(input.original_text);
  add(input.event_type);
  for (const term of EVENT_TYPE_TERMS[input.event_type || ""] || []) add(term);
  for (const entity of input.entities || []) add(entity);
  for (const tag of input.tags || []) add(tag);
  add(input.location);
  for (const factText of factsToSearchText(normalizeOpenFacts(input.open_facts || [], input as MemoryEvent)).split(/\s+/)) add(factText);
  add(input.emotion?.primary);
  add(input.emotion?.secondary);
  add(input.emotion?.valence);
  if (input.user_id === "demo-dad-owner") add("爸爸");
  if (input.user_id === "demo-mom-owner") add("妈妈");

  const base = pieces.join(" ");
  for (const [regex, values] of ALIAS_RULES) {
    if (regex.test(base)) {
      for (const value of values) add(value);
    }
  }

  return [...new Set(pieces)].join(" ");
}
