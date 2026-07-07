/**
 * 敏感记忆护栏：这些内容只在用户主动查询时出现，绝不由回声/线索主动翻起。
 * 教训来自 Facebook 年度回顾把去世亲人推给用户的经典事故——
 * "发烧"可以回忆（有痊愈作对照），丧失/创伤类没有"回头看真好"的叙事，主动提起只有伤害。
 */

const SENSITIVE_PATTERNS: RegExp[] = [
  /去世|离世|过世|逝世|走了以后|病故|猝死|夭折/,
  /病危|抢救|ICU|重症监护|化疗|癌|肿瘤|恶性/,
  /流产|引产|胎停|宫外孕|死胎/,
  /自杀|轻生|自残|不想活/,
  /抑郁症|躁郁|精神分裂/,
  /离婚|出轨|外遇|家暴|分居/,
  /葬礼|火化|下葬|忌日|扫墓|遗像|遗物/,
  /车祸|溺水|坠楼/,
];

/** 悲痛属于丧失类情绪，主动浮现风险高；其余负面情绪（担心/压力/崩溃）允许回访。 */
const SENSITIVE_EMOTIONS = new Set(["悲痛"]);

export interface ResurfaceCheckInput {
  summary?: string;
  original_text?: string;
  emotion?: { primary?: string } | string;
}

export function isResurfaceable(input: ResurfaceCheckInput): boolean {
  const text = `${input.summary || ""}\n${input.original_text || ""}`;
  if (SENSITIVE_PATTERNS.some(pattern => pattern.test(text))) return false;
  const primary = typeof input.emotion === "string"
    ? parseEmotionPrimary(input.emotion)
    : input.emotion?.primary;
  if (primary && SENSITIVE_EMOTIONS.has(primary)) return false;
  return true;
}

function parseEmotionPrimary(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as { primary?: string }).primary : undefined;
  } catch {
    return undefined;
  }
}
