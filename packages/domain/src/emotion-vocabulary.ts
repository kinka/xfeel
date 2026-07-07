/**
 * 受控情绪词表 v2
 * Plutchik 情绪轮(1980) × PANAS 量表(1988) × 实际育儿日记语料
 */

// Plutchik 8 基本情绪 x 3 档强度
export const PLUTCHIK_EMOTIONS = {
  joy:          { inner: "欣喜", middle: "开心", outer: "平静" },
  trust:        { inner: "崇拜", middle: "信任", outer: "接受" },
  surprise:     { inner: "震惊", middle: "惊喜", outer: "意外" },
  fear:         { inner: "恐惧", middle: "焦虑", outer: "担心" },
  sadness:      { inner: "悲痛", middle: "失落", outer: "惆怅" },
  disgust:      { inner: "憎恶", middle: "厌烦", outer: "无聊" },
  anger:        { inner: "狂怒", middle: "愤怒", outer: "烦躁" },
  anticipation: { inner: "急切", middle: "期待", outer: "留意" },
} as const;

// PANAS 补充词 (Watson & Clark 1988)
export const PANAS_SUPPLEMENTARY = {
  positive: ["自豪", "感恩", "满足", "感动", "释然", "精力充沛", "专注", "坚定"],
  negative: ["疲惫", "愧疚", "无助", "压力", "委屈", "心疼", "无奈", "迷茫", "孤独", "紧张"],
} as const;

// 特殊复合词
export const SPECIAL_WORDS = ["崩溃", "释然", "无奈", "思念"] as const;

// 别名映射 (日记口语 → 标准词)
export const EMOTION_ALIASES: Record<string, string> = {
  "累": "疲惫", "好累": "疲惫", "太累了": "疲惫", "困": "疲惫", "没力气": "疲惫",
  "崩溃": "崩溃", "疯了": "崩溃", "受不了": "崩溃", "撑不住": "崩溃",
  "要炸了": "崩溃", "炸了": "崩溃", "要命": "崩溃", "救命": "崩溃",
  "生气": "愤怒", "气死了": "愤怒", "火大": "愤怒", "恼火": "烦躁",
  "高兴": "开心", "快乐": "开心", "乐": "开心", "爽": "开心", "太好了": "开心",
  "棒": "自豪", "厉害": "自豪", "厉害了": "自豪", "太牛了": "自豪", "了不起": "自豪",
  "欣慰": "满足", "安心": "满足", "踏实": "满足", "安稳": "满足",
  "放心": "释然", "松了口气": "释然", "终于好了": "释然",
  "慌": "焦虑", "坐立不安": "焦虑", "寝食难安": "焦虑",
  "怕": "担心", "害怕": "担心", "担忧": "担心", "不放心": "担心",
  "冤枉": "委屈", "不被理解": "委屈", "没人懂": "委屈",
  "内疚": "愧疚", "亏欠": "愧疚", "对不起": "愧疚", "自责": "愧疚",
  "丧": "失落", "郁闷": "失落", "低落": "失落", "消沉": "失落",
  "可怜": "心疼", "心痛": "心疼", "不舍得": "心疼",
  "压力大": "压力", "喘不过气": "压力", "超负荷": "压力",
  "感谢": "感恩", "谢谢": "感恩", "感激": "感恩",
  "盼望": "期待", "盼着": "期待", "等不及": "期待", "迫不及待": "期待",
  "想念": "思念", "想": "思念", "惦记": "思念",
  "纠结": "矛盾", "犹豫": "矛盾", "不知道怎么办": "矛盾",
};

// 扁平化
export const PLUTCHIK_WORDS: string[] = Object.values(PLUTCHIK_EMOTIONS).flatMap(g => Object.values(g));
export const PANAS_WORDS: string[] = [...PANAS_SUPPLEMENTARY.positive, ...PANAS_SUPPLEMENTARY.negative];
export const ALL_EMOTIONS: string[] = [...PLUTCHIK_WORDS, ...PANAS_WORDS, ...SPECIAL_WORDS];

export function isKnownEmotion(raw: string): boolean {
  return ALL_EMOTIONS.includes(raw);
}

// valence 映射
export function getValence(word: string): "positive" | "negative" | "neutral" {
  const pos = ["欣喜","开心","平静","崇拜","信任","接受","惊喜","意外","期待","急切","留意",
               "自豪","感恩","满足","感动","释然","精力充沛","专注","坚定"];
  const neg = ["恐惧","焦虑","担心","悲痛","失落","惆怅","憎恶","厌烦","无聊","狂怒","愤怒","烦躁","震惊",
               "疲惫","愧疚","无助","压力","委屈","心疼","无奈","迷茫","孤独","紧张","崩溃"];
  if (pos.includes(word)) return "positive";
  if (neg.includes(word)) return "negative";
  return "neutral";
}

/**
 * 标准化情绪词
 */
export function normalizeEmotion(raw: string): { word: string; valence: "positive" | "negative" | "neutral" } | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;
  if (isKnownEmotion(cleaned)) return { word: cleaned, valence: getValence(cleaned) };
  const alias = EMOTION_ALIASES[cleaned];
  if (alias) return { word: alias, valence: getValence(alias) };
  for (const w of ALL_EMOTIONS) {
    if (cleaned.includes(w) || w.includes(cleaned)) return { word: w, valence: getValence(w) };
  }
  return null;
}

/**
 * 生成情绪提示文本 (给 LLM 用)
 */
export function getEmotionPrompt(): string {
  return `情绪词（只从以下选择，按 Plutchik 情绪轮分类）：
  喜: 欣喜、开心、平静
  信: 崇拜、信任、接受
  惊: 震惊、惊喜、意外
  惧: 恐惧、焦虑、担心
  悲: 悲痛、失落、惆怅
  厌: 憎恶、厌烦、无聊
  怒: 狂怒、愤怒、烦躁
  期: 急切、期待、留意
  补充: 疲惫、自豪、感恩、满足、感动、释然、愧疚、无助、压力、委屈、心疼、无奈、迷茫、崩溃`;
}
