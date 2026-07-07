import type { LLMConfig } from "./llm";

/**
 * LLM 角色拆分：不同任务用不同模型与采样温度。
 * - extract: 结构化抽取 + 消息分类，确定性优先，便宜可降级
 * - intent:  自然语言意图识别，语义理解优先，低延迟
 * - reply:   共情回复，是产品的脸，质量优先、温度更高
 *
 * 模型名可用环境变量覆盖，便于本地/测试切换。
 */
export type LLMRole = "extract" | "intent" | "reply";

export const ROLE_MODELS: Record<LLMRole, string> = {
  extract: process.env.XFEEL_MODEL_EXTRACT || "claude-sonnet-4-6",
  intent: process.env.XFEEL_MODEL_INTENT || "claude-sonnet-4-6",
  reply: process.env.XFEEL_MODEL_REPLY || "claude-sonnet-4-6",
};

export const ROLE_TEMPERATURE: Record<LLMRole, number> = {
  extract: 0.1,
  intent: 0.1,
  reply: 0.7,
};

export function roleLLMConfig(role: LLMRole): Partial<LLMConfig> {
  return { model: ROLE_MODELS[role], temperature: ROLE_TEMPERATURE[role] };
}
