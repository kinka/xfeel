import { getLLM } from "../../../ai-client/src/llm";
import { roleLLMConfig } from "../../../ai-client/src/roles";
import { ALL_LEVERS, LEVER_LABELS, type ConstrualLever, type LeverDetection, type LeverHit } from "./lever-types";

/**
 * 认知杠杆识别：这句话里有没有"消极解释方式"。
 *
 * 成本纪律：绝大多数消息（记录、提问、闲聊、好消息）根本不需要跑 LLM。
 * 先用一个廉价的前置门筛掉，只有出现低落/挫折/自我否定信号才花一次 LLM 调用。
 */

/** 低落/挫折/自我否定的表层信号。宁可放过，不可对每条消息都收费。 */
const DISTRESS_PATTERNS: RegExp[] = [
  /累|疲惫|撑不住|扛不住|熬不住|崩溃|难受|痛苦|煎熬/,
  /不行|做不好|做不到|搞砸|失败|搞不定|没做好|做得烂|一团糟|白费/,
  /糟糕|烦|焦虑|压力|慌|怕|担心|沮丧|失落|委屈|难过|想哭/,
  /没用|废物|垃圾|差劲|笨|蠢|不配|不值得|失望/,
  /没人|孤独|孤单|格格不入|融不进|不属于|被排挤|被孤立/,
  /针对我|故意|看不起|嫌弃|挑刺|甩脸/,
  /回不去|再也|以前的我|变了个人|找不回/,
  /为什么总是|又一次|老是|每次都|哪哪都|一直都/,
];

export function hasDistressSignal(text: string): boolean {
  const trimmed = text?.trim();
  if (!trimmed || trimmed.length < 4) return false;
  return DISTRESS_PATTERNS.some(pattern => pattern.test(trimmed));
}

const DETECT_SYSTEM = [
  "你是认知解释方式（construal）的标注器，服务于心理学里的“智慧干预”。",
  "你的任务不是判断用户情绪好坏，也不是诊断心理问题，而是识别：用户这句话里，有没有把一件事解释成下面某种**固定的、全局的、指向自我的**消极说法。",
  "",
  "四种杠杆：",
  ...ALL_LEVERS.map(lever => `- ${lever}：${LEVER_LABELS[lever]}`),
  "",
  "返回 JSON：{\"hits\": [{\"lever\": \"...\", \"confidence\": 0.0-1.0, \"quote\": \"用户原话里的片段\"}]}",
  "",
  "严格标准（宁可空数组，也不要凑）：",
  "- quote 必须**逐字**来自用户这句话，不许改写、不许翻译、不许自己造。",
  "- 只是累了、心情不好、抱怨一件具体的事 → 不算，返回空数组。必须出现“把这件事上升成对自我/归属/他人意图的固定解释”才算。",
  "  例：“今天好累” → 空；“我怎么总是把事情搞砸，我就是不行” → fixed_attribution。",
  "  例：“他今天没回我消息” → 空；“他就是故意不理我，他一直看不起我” → hostile_attribution。",
  "- 只有在明确、直白时才给 confidence ≥ 0.6；含糊、需要脑补的一律 < 0.5。",
  "- 一句话最多命中 2 种杠杆。",
].join("\n");

interface RawDetection {
  hits?: Array<{ lever?: string; confidence?: number; quote?: string }>;
}

/**
 * 识别一条消息里的认知杠杆。
 * 前置门未命中时不调用 LLM，返回 detected=false（供评测统计"省下的调用"）。
 */
export async function detectLevers(input: { text: string; recentDialogue?: string }): Promise<LeverDetection> {
  const text = input.text?.trim() || "";
  if (!hasDistressSignal(text)) return { hits: [], detected: false };

  try {
    const prompt = [
      input.recentDialogue ? `近期对话（仅供理解语境，不要标注这里的句子）：\n${input.recentDialogue}\n` : "",
      `用户这句话：\n${text}`,
    ].filter(Boolean).join("\n");
    const raw = await getLLM(roleLLMConfig("intent")).chatJSON<RawDetection>(prompt, DETECT_SYSTEM);
    return { hits: groundHits(raw?.hits, text), detected: true };
  } catch {
    // 检测失败不能影响回复：退化成"没识别到杠杆"，回复走原本的共情路径。
    return { hits: [], detected: false };
  }
}

/**
 * 防幻觉：丢掉 quote 不在原文里的命中。
 * 模型很容易"替用户说出"他没说的自我否定，那正是这套机制最不能犯的错——
 * 一旦据此发问，用户会看到一个他从没说过的、被安在自己头上的消极想法。
 */
export function groundHits(raw: RawDetection["hits"], text: string): LeverHit[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<ConstrualLever>();
  const hits: LeverHit[] = [];
  for (const item of raw) {
    const lever = item?.lever as ConstrualLever;
    if (!ALL_LEVERS.includes(lever) || seen.has(lever)) continue;
    const quote = typeof item?.quote === "string" ? item.quote.trim() : "";
    if (!quote || !isQuoteFromText(quote, text)) continue;
    const confidence = typeof item?.confidence === "number" && Number.isFinite(item.confidence)
      ? Math.min(Math.max(item.confidence, 0), 1)
      : 0;
    seen.add(lever);
    hits.push({ lever, confidence, quote });
  }
  return hits.sort((a, b) => b.confidence - a.confidence).slice(0, 2);
}

/** 允许模型省略标点，但不允许它改写内容。 */
function isQuoteFromText(quote: string, text: string): boolean {
  if (text.includes(quote)) return true;
  const strip = (value: string) => value.replace(/[\s，。！？、,.!?;；:："'“”‘’~…]/g, "");
  const strippedQuote = strip(quote);
  return strippedQuote.length >= 2 && strip(text).includes(strippedQuote);
}
