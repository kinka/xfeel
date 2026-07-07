/**
 * 受控标签词表
 * LLM 抽取时只从这些标签中选择，避免相似词泛滥
 */

// 一级标签：按域分组
export const TAG_GROUPS = {
  // 睡眠域
  sleep: ["夜醒", "睡眠不足", "作息紊乱", "自主入睡", "小睡", "夜惊"],
  
  // 喂养域
  feeding: ["母乳", "奶粉", "辅食", "自主进食", "厌奶", "断奶", "过敏"],
  
  // 健康域
  health: ["发烧", "感冒", "出牙", "疫苗", "腹泻", "呕吐", "湿疹", "便秘", "咳嗽"],
  
  // 成长里程碑
  milestone: ["翻身", "坐立", "爬行", "站立", "走路", "说话", "认人", "抓握"],
  
  // 情绪/心理域
  emotion: ["育儿压力", "产后情绪", "夫妻矛盾", "工作压力", "自我怀疑", "成就感"],
  
  // 照护域
  care: ["换尿布", "洗澡", "抚触", "遛娃", "早教", "亲子互动"],
  
  // 社交/家庭域
  family: ["婆媳", "长辈帮忙", "爸爸参与", "双胞胎互动", "社交"],
  
  // 日常域
  daily: ["家务", "外出", "旅行", "购物", "天气"],
} as const;

// 扁平化标签列表
export const ALL_TAGS = Object.values(TAG_GROUPS).flat();

// 标签 → 所属域 的映射
export const TAG_TO_GROUP: Record<string, string> = {};
for (const [group, tags] of Object.entries(TAG_GROUPS)) {
  for (const tag of tags) {
    TAG_TO_GROUP[tag] = group;
  }
}

// 近义词映射（用户/LLM 可能用的别名 → 标准标签）
export const TAG_ALIASES: Record<string, string> = {
  "睡觉": "自主入睡",
  "吃饭": "自主进食",
  "喂奶": "母乳",
  "奶量": "奶粉",
  "长牙": "出牙",
  "打针": "疫苗",
  "打疫苗": "疫苗",
  "拉肚子": "腹泻",
  "吐": "呕吐",
  "吐了": "呕吐",
  "呕吐": "呕吐",
  "吃啥吐啥": "呕吐",
  "上吐下泻": "呕吐",
  "皮肤": "湿疹",
  "旅游": "旅行",
  "出游": "旅行",
  "旅行": "旅行",
  "回老家": "旅行",
  "压力大": "育儿压力",
  "崩溃": "育儿压力",
  "累": "育儿压力",
  "焦虑": "育儿压力",
  "爸爸帮忙": "爸爸参与",
  "俩宝": "双胞胎互动",
  "俩娃": "双胞胎互动",
  "第一次睡整觉": "自主入睡",
  "第一次站起来": "站立",
  "第一次走路": "走路",
};

export function isKnownTag(raw: string): boolean {
  return ALL_TAGS.includes(raw as (typeof ALL_TAGS)[number]);
}

/**
 * 标准化标签：别名 → 标准标签，不在词表中 → 返回 null
 */
export function normalizeTag(raw: string): string | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;

  // 精确匹配
  if (isKnownTag(cleaned)) return cleaned;
  
  // 别名匹配
  const alias = TAG_ALIASES[cleaned];
  if (alias && isKnownTag(alias)) return alias;
  
  // 模糊匹配：检查是否包含某个标准标签
  for (const tag of ALL_TAGS) {
    if (cleaned.includes(tag) || tag.includes(cleaned)) return tag;
  }
  
  return null; // 不在词表中，丢弃
}

/**
 * 批量标准化标签，去重
 */
export function normalizeTags(rawTags: string[]): string[] {
  const result = new Set<string>();
  for (const raw of rawTags) {
    const normalized = normalizeTag(raw.trim());
    if (normalized) result.add(normalized);
  }
  return [...result];
}

/**
 * 生成标签词表提示文本（供 LLM prompt 使用）
 */
export function getTagVocabularyPrompt(): string {
  const lines: string[] = ["可用标签（只从以下标签中选择，不要自创标签）："];
  for (const [group, tags] of Object.entries(TAG_GROUPS)) {
    lines.push(`  ${group}: ${tags.join("、")}`);
  }
  return lines.join("\n");
}
