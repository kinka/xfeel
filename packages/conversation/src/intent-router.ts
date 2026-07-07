import { classifyIntent, classifyIntentLLM, type IntentClassification } from "./intent-classifier";

export type ConversationMode =
  | "log"
  | "recall"
  | "recap"
  | "reflect"
  | "chat"
  | "archive"
  | "undo"
  | "correct";

export interface RouteResult {
  mode: ConversationMode;
  text: string;
  matchedBy: "command" | "pattern" | "default" | "llm";
  confidence: number;
  recallDepth: IntentClassification["recallDepth"];
}

function toRoute(classified: IntentClassification): RouteResult {
  return {
    mode: classified.mode,
    text: classified.text,
    matchedBy: classified.matchedBy,
    confidence: classified.confidence,
    recallDepth: classified.recallDepth,
  };
}

/** 同步规则路由：用于显式命令解析与无网络/测试场景的快路与降级。 */
export function routeMessage(raw: string): RouteResult {
  return toRoute(classifyIntent(raw));
}

/**
 * 智能路由：显式命令/归档/撤销走规则快路；自然语言一律交给 LLM 判断，
 * LLM 不可用时降级回规则结果。规则不用于自然语言的快捷绕过——太脆。
 */
export async function routeMessageSmart(raw: string): Promise<RouteResult> {
  const base = classifyIntent(raw);
  if (base.matchedBy === "command") return toRoute(base);
  const llm = await classifyIntentLLM(raw);
  return toRoute(llm ?? base);
}
