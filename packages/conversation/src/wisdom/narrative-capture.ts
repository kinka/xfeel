import { getLLM } from "../../../ai-client/src/llm";
import { roleLLMConfig } from "../../../ai-client/src/roles";
import { normalizeOwnerId } from "../../../domain/src/owner";
import { getOpenIntervention, markNarrativeCaptured } from "./lever-store";
import { upsertPreferredNarrative } from "./narrative-store";
import { isWisdomEnabled } from "./wisdom-context";
import type { PreferredNarrative } from "./lever-types";

/**
 * 回收"用户自己说出的那句话"（saying-is-believing 的收口）。
 *
 * 只在用户**直接回答**了上一条反问时才回收。这是刻意收紧的：
 * 隔了几轮之后的话不算，用户岔开话题不算，AI 自己说的漂亮话更不算——
 * 一旦把模型生成的积极解释写进画像，整套机制就退化成了自我洗脑的鸡汤机。
 */

const CAPTURE_SYSTEM = [
  "你在判断：用户这句回复里，有没有**他自己**给出的、对处境的另一种解释。",
  "",
  "返回 JSON：{\"captured\": true/false, \"statement\": \"用用户自己的措辞写成的一句话\"}",
  "",
  "算（captured=true）：用户说出了具体做法、条件、原因，或者对自己的处境给出了比“我就是不行”更宽的说法。",
  "  例：“那次是因为我提前列了清单，心里有底” → captured，statement=“提前列清单、心里有底的时候，我是能弄好的”。",
  "不算（captured=false）：只是附和（“嗯”“可能吧”“你说得对”）、继续否定自己、答非所问、只描述情绪、或者反过来问你问题。",
  "",
  "statement 必须贴着用户的原话写，只做最小的通顺化：不许升华、不许加正能量、不许替他补上他没说的东西。",
  "宁可判 false，也不要把用户没说的话写成他的话。",
].join("\n");

interface RawCapture {
  captured?: boolean;
  statement?: string;
}

/** 依赖注入点（测试用，理由同 wisdom-context）。 */
export type NarrativeAnalyzer = (input: { question: string; reply: string }) => Promise<RawCapture>;

const analyzeWithLLM: NarrativeAnalyzer = input => getLLM(roleLLMConfig("intent")).chatJSON<RawCapture>(
  `你上一句问 ta：${input.question}\n\nta 的回复：${input.reply}`,
  CAPTURE_SYSTEM,
);

/**
 * @param previousAssistantTurnId 用户这句话之前的那条助手消息 id。只有它就是发问的那条时才回收。
 */
export async function maybeCaptureNarrative(input: {
  owner_id?: string;
  text: string;
  date: string;
  previousAssistantTurnId?: string;
}, analyze: NarrativeAnalyzer = analyzeWithLLM): Promise<PreferredNarrative | null> {
  if (!isWisdomEnabled()) return null;
  const owner = normalizeOwnerId(input.owner_id);
  const text = input.text?.trim();
  if (!owner || !text) return null;

  const open = getOpenIntervention(owner);
  if (!open) return null;
  // 只认对反问的直接回答：中间隔了别的对话，就不再算作"被问出来的那句话"。
  if (open.askedTurnId && open.askedTurnId !== input.previousAssistantTurnId) return null;

  try {
    const raw = await analyze({ question: open.question, reply: text });
    const statement = typeof raw?.statement === "string" ? raw.statement.trim() : "";
    if (!raw?.captured || statement.length < 4) return null;

    const narrative: PreferredNarrative = {
      lever: open.lever,
      statement,
      capturedAt: input.date,
      evidence: [],
    };
    markNarrativeCaptured(open.id, statement);
    upsertPreferredNarrative(owner, narrative);
    return narrative;
  } catch {
    return null;
  }
}
