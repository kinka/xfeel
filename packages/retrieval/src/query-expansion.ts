import type { EventType } from "../../domain/src/memory-event";
import { normalizeTag } from "../../domain/src/tag-vocabulary";

type QueryExpansionDomain =
  | "feeding"
  | "health"
  | "sleep"
  | "milestone"
  | "emotion_work"
  | "travel_play_reading"
  | "family";

export interface QueryExpansionMatch {
  domain: QueryExpansionDomain;
  term: string;
  aliases: string[];
  typeHints: EventType[];
  tagHints: string[];
  entityHints: string[];
}

export interface RecallQueryExpansion {
  text: string;
  expandedText: string;
  tokens: string[];
  aliases: string[];
  typeHints: EventType[];
  tagHints: string[];
  entityHints: string[];
  debug: {
    normalizedText: string;
    matches: QueryExpansionMatch[];
  };
}

interface DomainConfig {
  terms: string[];
  typeHints: EventType[];
  tagHints: string[];
  aliases: string[];
}

interface TermOverride {
  aliases?: string[];
  typeHints?: EventType[];
  tagHints?: string[];
  entityHints?: string[];
}

export const QUERY_EXPANSION_DOMAINS: Record<QueryExpansionDomain, DomainConfig> = {
  feeding: {
    terms: ["辅食", "米粉", "奶粉", "母乳", "喝奶", "吃奶", "吃饭", "喂养", "呛奶", "溢奶", "吐奶"],
    typeHints: ["feeding"],
    tagHints: [],
    aliases: ["喂养"],
  },
  health: {
    terms: ["发烧", "咳嗽", "夜咳", "鼻涕", "感冒", "疫苗", "打针", "复查", "上吐下泻", "呕吐", "腹泻", "拉肚子", "头晕", "眩晕", "刷牙", "牙齿", "生病"],
    typeHints: ["health"],
    tagHints: [],
    aliases: ["健康", "不舒服"],
  },
  sleep: {
    terms: ["夜醒", "睡不着", "不肯睡", "不想睡觉", "带睡", "哄睡", "睡不好", "犯困", "补觉", "趴睡"],
    typeHints: ["sleep"],
    tagHints: [],
    aliases: ["睡觉", "睡眠"],
  },
  milestone: {
    terms: ["翻身", "学站", "站立", "走路", "说话", "语言爆发", "四个字", "摇摇晃晃", "大运动"],
    typeHints: ["milestone"],
    tagHints: [],
    aliases: ["成长", "里程碑"],
  },
  emotion_work: {
    terms: ["代理", "客户", "订单", "职场", "压力", "焦虑", "崩溃", "开心", "兴奋", "成就感", "工作"],
    typeHints: ["emotion"],
    tagHints: [],
    aliases: ["情绪"],
  },
  travel_play_reading: {
    terms: ["绘本", "磁力片", "磁力墙", "游泳", "公园", "游乐场", "台风", "航班", "航班取消", "改签", "荡秋千"],
    typeHints: ["daily", "other"],
    tagHints: [],
    aliases: ["外出"],
  },
  family: {
    // 只放通用集合称呼；具体家人名/昵称由 expandRecallQuery 的 family 参数在运行时注入
    terms: ["两个娃", "两个宝宝", "宝宝们", "小朋友", "孩子们", "俩宝", "俩娃", "双胞胎"],
    typeHints: [],
    tagHints: [],
    aliases: [],
  },
};

const TERM_OVERRIDES: Record<string, TermOverride> = {
  辅食: { aliases: ["吃饭", "进食"], tagHints: ["辅食"] },
  米粉: { aliases: ["辅食", "吃饭"], tagHints: ["辅食"] },
  奶粉: { aliases: ["喝奶"], tagHints: ["奶粉"] },
  母乳: { aliases: ["喝奶", "喂奶"], tagHints: ["母乳"] },
  吃饭: { aliases: ["进食", "自主进食"], tagHints: ["自主进食"] },
  喂养: { aliases: ["吃饭", "喝奶"] },
  喝奶: { aliases: ["奶粉", "母乳", "喂奶"], tagHints: ["母乳", "奶粉"] },
  吃奶: { aliases: ["喝奶", "奶粉", "母乳", "喂奶"], tagHints: ["母乳", "奶粉"] },
  呛奶: { aliases: ["溢奶", "吐奶", "喝奶"], tagHints: ["母乳", "奶粉"] },
  溢奶: { aliases: ["呛奶", "吐奶", "喝奶"], tagHints: ["母乳", "奶粉"] },
  吐奶: { aliases: ["呛奶", "溢奶", "喝奶"], tagHints: ["母乳", "奶粉"] },
  发烧: { tagHints: ["发烧"] },
  咳嗽: { aliases: ["夜咳", "感冒"], tagHints: ["咳嗽"] },
  夜咳: { aliases: ["咳嗽", "夜醒"], tagHints: ["咳嗽", "夜醒"], typeHints: ["health", "sleep"] },
  鼻涕: { aliases: ["感冒"], tagHints: ["感冒"] },
  感冒: { aliases: ["鼻涕", "咳嗽", "发烧"], tagHints: ["感冒", "咳嗽", "发烧"] },
  上吐下泻: { aliases: ["呕吐", "拉肚子", "腹泻"], tagHints: ["呕吐", "腹泻"] },
  呕吐: { aliases: ["上吐下泻", "吐了"], tagHints: ["呕吐"] },
  拉肚子: { aliases: ["腹泻", "厕所"], tagHints: ["腹泻"] },
  腹泻: { aliases: ["拉肚子"], tagHints: ["腹泻"] },
  疫苗: { aliases: ["打针", "接种"], tagHints: ["疫苗"] },
  打针: { aliases: ["疫苗", "接种"], tagHints: ["疫苗"] },
  复查: { aliases: ["医院", "检查"] },
  刷牙: { aliases: ["牙"], tagHints: ["出牙"] },
  牙齿: { aliases: ["牙", "刷牙"], tagHints: ["出牙"] },
  头晕: { aliases: ["眩晕"] },
  眩晕: { aliases: ["头晕"] },
  生病: { aliases: ["不舒服", "健康"] },

  夜醒: { tagHints: ["夜醒"] },
  睡不着: { aliases: ["睡不好"], tagHints: ["睡眠不足"] },
  不肯睡: { aliases: ["不想睡觉", "睡觉"], tagHints: ["自主入睡"] },
  不想睡觉: { aliases: ["不肯睡", "睡觉"], tagHints: ["自主入睡"] },
  带睡: { aliases: ["哄睡"], tagHints: ["自主入睡"] },
  哄睡: { aliases: ["带睡"], tagHints: ["自主入睡"] },
  犯困: { aliases: ["睡觉"], tagHints: ["睡眠不足"] },
  睡不好: { aliases: ["睡不着", "没睡好"], tagHints: ["睡眠不足"] },
  补觉: { aliases: ["睡觉", "小睡"], tagHints: ["小睡", "睡眠不足"] },
  趴睡: { aliases: ["睡觉"], tagHints: ["自主入睡"] },

  翻身: { tagHints: ["翻身"] },
  学站: { aliases: ["站立", "站的时间"], tagHints: ["站立"], typeHints: ["milestone"] },
  站立: { aliases: ["学站"], tagHints: ["站立"] },
  走路: { aliases: ["大运动"], tagHints: ["走路"] },
  说话: { aliases: ["语言", "表达"], tagHints: ["说话"] },
  语言爆发: { aliases: ["语言大爆发", "说话", "表达", "语言进展"], tagHints: ["说话"], typeHints: ["milestone"] },
  四个字: { aliases: ["4个字", "说话", "语言进展"], tagHints: ["说话"] },
  摇摇晃晃: { aliases: ["走路", "大运动"], tagHints: ["走路"] },
  大运动: { aliases: ["走路", "站立", "翻身"], tagHints: ["走路", "站立", "翻身"] },

  崩溃: { aliases: ["压力", "撑不住"], tagHints: ["育儿压力"], typeHints: ["emotion"] },
  焦虑: { aliases: ["担心", "压力"], tagHints: ["育儿压力"], typeHints: ["emotion"] },
  压力: { aliases: ["压力大", "焦虑"], tagHints: ["育儿压力"], typeHints: ["emotion"] },
  客户: { aliases: ["工作", "职场"], tagHints: ["工作压力"], typeHints: ["work"] },
  订单: { aliases: ["工作", "客户"], tagHints: ["工作压力"], typeHints: ["work"] },
  职场: { aliases: ["工作", "客户"], tagHints: ["工作压力"], typeHints: ["work"] },
  代理: { aliases: ["工作", "客户", "压力"], tagHints: ["工作压力"], typeHints: ["work"] },
  工作: { aliases: ["职场", "项目", "客户"], tagHints: ["工作压力"], typeHints: ["work"] },
  开心: { aliases: ["喜悦", "幸福", "轻松"], typeHints: ["emotion"], tagHints: ["成就感"] },
  兴奋: { aliases: ["开心", "期待"], typeHints: ["emotion"], tagHints: ["成就感"] },
  成就感: { aliases: ["自豪", "太棒了"], typeHints: ["emotion", "milestone"], tagHints: ["成就感"] },

  绘本: { aliases: ["讲绘本", "睡前故事"], typeHints: ["sleep", "care"], tagHints: ["亲子互动", "早教"] },
  磁力片: { aliases: ["玩具", "亲子互动"], typeHints: ["care", "milestone"], tagHints: ["亲子互动", "早教"] },
  磁力墙: { aliases: ["磁力片", "玩具"], typeHints: ["milestone", "care"], tagHints: ["亲子互动", "早教"] },
  游泳: { aliases: ["外出", "开心"], typeHints: ["emotion", "other"], tagHints: ["外出"] },
  公园: { aliases: ["外出", "游乐场"], tagHints: ["外出"] },
  游乐场: { aliases: ["公园", "外出"], tagHints: ["外出"] },
  台风: { aliases: ["天气"], typeHints: ["other", "health"], tagHints: ["天气"] },
  航班: { aliases: ["飞机", "旅行"], typeHints: ["other"], tagHints: ["外出"] },
  航班取消: { aliases: ["航班被取消", "改签", "延迟"], typeHints: ["other"], tagHints: ["外出"] },
  改签: { aliases: ["航班取消", "延迟"], typeHints: ["other"], tagHints: ["外出"] },
  荡秋千: { aliases: ["游乐场", "亲子互动"], typeHints: ["care"], tagHints: ["亲子互动"] },
  两个娃: { aliases: ["两个宝宝", "宝宝们", "双胞胎"], entityHints: ["宝宝们"] },
  两个宝宝: { aliases: ["两个娃", "宝宝们", "双胞胎"], entityHints: ["宝宝们"] },
  宝宝们: { aliases: ["两个娃", "两个宝宝", "双胞胎"], entityHints: ["宝宝们"] },
  小朋友: { aliases: ["宝宝们", "两个宝宝"], entityHints: ["宝宝们"] },
  孩子们: { aliases: ["宝宝们", "两个宝宝"], entityHints: ["宝宝们"] },
  俩宝: { aliases: ["宝宝们", "两个娃"], entityHints: ["宝宝们"] },
  俩娃: { aliases: ["宝宝们", "两个娃"], entityHints: ["宝宝们"] },
  双胞胎: { aliases: ["宝宝们", "两个宝宝"], entityHints: ["宝宝们"] },
};

const EXTRA_MATCH_RULES: Array<{ pattern: RegExp; term: string; domain: QueryExpansionDomain; override: TermOverride }> = [
  { pattern: /语言大爆发/, term: "语言爆发", domain: "milestone", override: TERM_OVERRIDES.语言爆发! },
  { pattern: /4个字/, term: "四个字", domain: "milestone", override: TERM_OVERRIDES.四个字! },
  { pattern: /夜咳/, term: "咳嗽", domain: "health", override: TERM_OVERRIDES.咳嗽! },
  { pattern: /没睡好/, term: "睡不好", domain: "sleep", override: TERM_OVERRIDES.睡不好! },
  { pattern: /吐了/, term: "呕吐", domain: "health", override: TERM_OVERRIDES.呕吐! },
];

/** 运行时家庭词典（来自 db 层 getEntityLexiconForOwner），用于替代硬编码家人名 */
export interface FamilyLexiconInput {
  aliasToLabel?: Record<string, string>;
  collectiveChildren?: string[];
}

export function expandRecallQuery(text: string, family?: FamilyLexiconInput): RecallQueryExpansion {
  const normalizedText = normalizeInput(text);
  const tokens: string[] = [];
  const aliases: string[] = [];
  const typeHints: EventType[] = [];
  const tagHints: string[] = [];
  const entityHints: string[] = [];
  const matches: QueryExpansionMatch[] = [];

  for (const token of splitLiteralTokens(normalizedText)) {
    addUnique(tokens, token);
  }

  // 家人名/昵称：命中任一 surface 时，把规范名 + 同人其它别名扩进查询，并给出实体过滤提示
  if (family?.aliasToLabel) {
    const labelToSurfaces = new Map<string, string[]>();
    for (const [surface, label] of Object.entries(family.aliasToLabel)) {
      if (!labelToSurfaces.has(label)) labelToSurfaces.set(label, []);
      labelToSurfaces.get(label)!.push(surface);
    }
    for (const [surface, label] of Object.entries(family.aliasToLabel)) {
      if (!normalizedText.includes(surface)) continue;
      const siblings = (labelToSurfaces.get(label) || []).filter(s => s !== surface);
      addMatch({
        domain: "family",
        term: surface,
        config: QUERY_EXPANSION_DOMAINS.family,
        override: { aliases: unique([label, ...siblings]), entityHints: [label], typeHints: [], tagHints: [] },
        tokens,
        aliases,
        typeHints,
        tagHints,
        entityHints,
        matches,
      });
    }
  }

  for (const [domain, config] of Object.entries(QUERY_EXPANSION_DOMAINS) as Array<[QueryExpansionDomain, DomainConfig]>) {
    for (const term of config.terms) {
      if (!normalizedText.includes(term)) continue;
      let override = TERM_OVERRIDES[term] || {};
      // 集合称呼（宝宝们/孩子们…）在有家庭词典时展开成具体孩子名做实体提示
      if (domain === "family" && family?.collectiveChildren?.length) {
        override = {
          ...override,
          entityHints: family.collectiveChildren,
          aliases: unique([...(override.aliases || []), ...family.collectiveChildren]),
        };
      }
      addMatch({
        domain,
        term,
        config,
        override,
        tokens,
        aliases,
        typeHints,
        tagHints,
        entityHints,
        matches,
      });
    }
  }

  for (const rule of EXTRA_MATCH_RULES) {
    if (!rule.pattern.test(normalizedText)) continue;
    addMatch({
      domain: rule.domain,
      term: rule.term,
      config: QUERY_EXPANSION_DOMAINS[rule.domain],
      override: rule.override,
      tokens,
      aliases,
      typeHints,
      tagHints,
      entityHints,
      matches,
    });
  }

  const expandedText = [
    normalizedText,
    ...tokens,
    ...aliases,
    ...entityHints,
    ...tagHints,
    ...typeHints,
  ].filter(Boolean);

  return {
    text,
    expandedText: unique(expandedText).join(" "),
    tokens,
    aliases,
    typeHints,
    tagHints,
    entityHints,
    debug: {
      normalizedText,
      matches,
    },
  };
}

function addMatch(input: {
  domain: QueryExpansionDomain;
  term: string;
  config: DomainConfig;
  override: TermOverride;
  tokens: string[];
  aliases: string[];
  typeHints: EventType[];
  tagHints: string[];
  entityHints: string[];
  matches: QueryExpansionMatch[];
}) {
  const typeHints = unique([...(input.override.typeHints || input.config.typeHints)]);
  const tagHints = normalizeTagHints([...(input.config.tagHints || []), ...(input.override.tagHints || [])]);
  const aliases = unique([...(input.override.aliases || []), ...(input.config.aliases || [])]);
  const entityHints = unique(input.override.entityHints || []);

  addUnique(input.tokens, input.term);
  for (const alias of aliases) addUnique(input.aliases, alias);
  for (const type of typeHints) addUnique(input.typeHints, type);
  for (const tag of tagHints) addUnique(input.tagHints, tag);
  for (const entity of entityHints) addUnique(input.entityHints, entity);

  input.matches.push({
    domain: input.domain,
    term: input.term,
    aliases,
    typeHints,
    tagHints,
    entityHints,
  });
}

function normalizeTagHints(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeTag(value);
    if (normalized) addUnique(result, normalized);
  }
  return result;
}

function normalizeInput(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function splitLiteralTokens(text: string): string[] {
  return text
    .split(/[\s，。！？、,.!?;；:：()[\]{}“”"']+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2);
}

function unique<T>(values: T[]): T[] {
  const result: T[] = [];
  for (const value of values) addUnique(result, value);
  return result;
}

function addUnique<T>(values: T[], value: T) {
  if (!values.includes(value)) values.push(value);
}
