import { getLLM } from "../../ai-client/src/llm";
import { roleLLMConfig } from "../../ai-client/src/roles";
import type { ConversationMode } from "./intent-router";

export type RecallDepth = "none" | "session" | "weekly" | "hybrid" | "emotional";

export interface IntentClassification {
  intent: ConversationMode;
  mode: ConversationMode;
  text: string;
  confidence: number;
  matchedBy: "command" | "pattern" | "default" | "llm";
  recallDepth: RecallDepth;
}

/** LLM 意图识别可选的模式（显式命令与归档/撤销已由规则快路处理，不交给模型）。 */
const LLM_INTENT_MODES = new Set<ConversationMode>(["log", "recall", "recap", "reflect", "chat"]);

const INTENT_SYSTEM = `你是 xfeel 家庭记忆助手的意图识别器。家庭成员通过自然闲聊记录自己与家人/工作/生活/精神状态，有时是在记录，有时是在围绕这些事追问或闲聊。
请判断用户这一条消息的意图，从以下模式中选一个：
- log: 在陈述/记录刚发生的事或某人的状态（值得沉淀为日志）
- recall: 在询问过去或历史（上次、之前、以前、什么时候、最近怎么样、有没有记录过）。注意：“复刻之前/像以前一样/又玩了之前的”是在陈述当下，属于 log，不是 recall
- recap: 在回顾“我们刚刚/今天聊了什么”这类对当前会话本身的概括
- reflect: 就刚才提到的事追问看法或情绪解读（结果呢、你觉得她当时是什么情绪、怎么看这件事）
- chat: 普通闲聊、提问、讨论，不属于以上任何一类
只返回 JSON：{"mode": "log|recall|recap|reflect|chat", "confidence": 0.0-1.0}`;

const EXPLICIT_COMMANDS: Record<string, ConversationMode> = {
  "记": "log",
  "记录": "log",
  "log": "log",
  "查": "recall",
  "查询": "recall",
  "找": "recall",
  "recall": "recall",
  "改": "correct",
  "修正": "correct",
  "更正": "correct",
  "correct": "correct",
};

export function classifyIntent(raw: string): IntentClassification {
  const text = raw.trim();
  const command = parseExplicitCommand(text);
  if (command) {
    return withRecallDepth({
      intent: command.mode,
      mode: command.mode,
      text: command.text,
      confidence: 0.99,
      matchedBy: "command",
      recallDepth: "none",
    });
  }

  if (isArchiveCommand(text)) return withRecallDepth(result("archive", text, 0.98, "command"));
  if (isUndoCommand(text)) return withRecallDepth(result("undo", text, 0.98, "command"));
  if (isSimpleGreeting(text)) return withRecallDepth(result("chat", text, 0.96, "pattern"));
  if (isRecapRequest(text)) return withRecallDepth(result("recap", text, 0.9, "pattern"));
  if (isReflectRequest(text)) return withRecallDepth(result("reflect", text, 0.86, "pattern"));
  if (isRecallRequest(text)) return withRecallDepth(result("recall", text, 0.88, "pattern"));
  if (isBriefFollowUp(text)) return withRecallDepth(result("reflect", text, 0.82, "pattern"));
  if (hasQuestionSignal(text)) return withRecallDepth(result("chat", text, 0.72, "pattern"));
  if (looksLikeDiaryLog(text)) return withRecallDepth(result("log", text, 0.7, "pattern"));
  return withRecallDepth(result("chat", text, 0.35, "default"));
}

/**
 * LLM 意图识别（intent 角色模型）。显式命令/归档/撤销仍走规则快路；
 * 其余自然语言交给模型判断。失败或模式非法时返回 null，由调用方降级到规则。
 */
export async function classifyIntentLLM(raw: string): Promise<IntentClassification | null> {
  const text = raw.trim();
  if (!text) return null;
  if (parseExplicitCommand(text) || isArchiveCommand(text) || isUndoCommand(text)) {
    return classifyIntent(text);
  }
  try {
    const parsed = await getLLM(roleLLMConfig("intent")).chatJSON<{ mode?: string; confidence?: number }>(
      `请判断下面这条家庭对话消息的意图：\n\n"${text}"`,
      INTENT_SYSTEM,
    );
    const mode = parsed.mode?.trim() as ConversationMode | undefined;
    if (!mode || !LLM_INTENT_MODES.has(mode)) return null;
    const confidence = clampConfidence(parsed.confidence);
    return withRecallDepth({ intent: mode, mode, text, confidence, matchedBy: "llm", recallDepth: "none" });
  } catch {
    return null;
  }
}

function clampConfidence(raw?: number): number {
  if (!Number.isFinite(raw)) return 0.6;
  return Math.min(Math.max(raw as number, 0), 1);
}

function result(mode: ConversationMode, text: string, confidence: number, matchedBy: IntentClassification["matchedBy"]): IntentClassification {
  return { intent: mode, mode, text, confidence, matchedBy, recallDepth: "none" };
}

function withRecallDepth(classification: IntentClassification): IntentClassification {
  let recallDepth: RecallDepth = "none";
  if (classification.mode === "recall") recallDepth = "hybrid";
  else if (classification.mode === "recap" || classification.mode === "reflect") recallDepth = "session";
  else if (classification.mode === "chat") {
    recallDepth = isRecallRequest(classification.text) ? "hybrid" : needsAmbientWeeklyContext(classification.text) ? "weekly" : "session";
  }
  return { ...classification, recallDepth };
}

function parseExplicitCommand(text: string): { mode: ConversationMode; text: string } | null {
  // L0 explicit command guard: accept colon or whitespace separator, not semicolon.
  const match = text.match(/^([^:：;；\s]+)(?:\s*[:：]\s*|\s+)([\s\S]+)$/);
  if (!match) return null;
  const mode = EXPLICIT_COMMANDS[match[1]!.trim()];
  if (!mode) return null;
  return { mode, text: match[2]!.trim() };
}

function isArchiveCommand(text: string): boolean {
  return /^(总结|总结今天|总结今日|日终归档|归档今天|archive today)$/i.test(text);
}

function isUndoCommand(text: string): boolean {
  return /^(刚刚那条别记|刚才那条别记|撤销上一条|删掉上一条|删除上一条|undo)$/i.test(text);
}

function isSimpleGreeting(text: string): boolean {
  return /^(hi|hello|hey|哈喽|你好|嗨|在吗|在不在|早|早安|晚上好|下午好)[~!！。,.，\s]*$/i.test(text);
}

function isRecapRequest(text: string): boolean {
  return /(刚刚|刚才|刚|今天|今日|这会儿|这一会儿)/.test(text) &&
    /(我们|咱们|你和我|我俩)/.test(text) &&
    /(聊|说|讲)/.test(text) &&
    /(啥|什么)/.test(text);
}

function isReflectRequest(text: string): boolean {
  if (/(情绪|感受|感觉|心情)/.test(text) && /(什么样|怎么样|如何|怎么|啥|什么)/.test(text)) return true;
  if (/(你觉得|怎么看|怎么理解|如何理解)/.test(text) && /(这时候|这件事|那时候|她|他|ta|TA)/.test(text)) return true;
  return false;
}

function isRecallRequest(text: string): boolean {
  // 本身含疑问意味的词，不需要额外问句信号即判 recall。
  if (/(什么时候|哪天|何时|有没有.*记录|最近.*怎么样|近况|近来)/.test(text)) return true;
  // “上次/上一次/最近一次/之前/以前/历史/记得” 在日志叙述里也常出现
  // （如”上次这种情况可是急诊住院了”），必须同时有问句信号才算 recall。
  return /(上次|上一次|最近一次|之前|以前|历史|记得)/.test(text) && hasQuestionSignal(text);
}

function isBriefFollowUp(text: string): boolean {
  return /^(结果呢|然后呢|后来呢|所以呢|咋样了|怎么样了|怎么样|呢|那呢)[？?。!！\s]*$/.test(text.trim());
}

function hasQuestionSignal(text: string): boolean {
  return /[?？]/.test(text) ||
    /(吗|么|什么|啥|哪里|哪儿|哪个|为何|为什么|怎么|怎样|如何|有没有|是不是|应不应该|该不该|能不能|可不可以|对吧|该[^。！？?]*吧)/.test(text);
}

function looksLikeDiaryLog(text: string): boolean {
  if (hasQuestionSignal(text)) return false;
  return /^(今天|昨天|前天|昨晚|今晚|早上|中午|下午|晚上|刚刚|刚才|这周|最近)/.test(text) ||
    /(睡|醒|吃|喝|发烧|咳嗽|走|爬|说|哭|笑|开心|崩溃|累|工作|上班|出门|回家)/.test(text);
}

function needsAmbientWeeklyContext(text: string): boolean {
  return /(最近|这周|这几天|近况|怎么样|聊聊|说说)/.test(text);
}

export const intentClassifierInternals = {
  isSimpleGreeting,
  isRecallRequest,
};
