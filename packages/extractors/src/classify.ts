import { getLLM } from "../../ai-client/src/llm";
import { roleLLMConfig } from "../../ai-client/src/roles";
import type { ClassifyResult } from "../../domain/src/memory-event";
import { ALL_TAGS, TAG_ALIASES } from "../../domain/src/tag-vocabulary";
import { ALL_EMOTIONS, EMOTION_ALIASES } from "../../domain/src/emotion-vocabulary";

const CLASSIFY_SYSTEM = `你是一个消息分类器。判断用户发来的消息是否有记录价值。

返回 JSON：
{
  "is_meaningful": true/false,
  "modality": "text"|"voice"|"image"|"video"|"mixed",
  "category": "diary"|"command"|"chat"|"noise",
  "reason": "简短理由"
}

分类标准：
- diary: 记录了事件、情绪、感受、状态变化（有记录价值）
- command: 用户对系统的指令（如"帮我查一下""生成周报"）
- chat: 日常聊天但无实质内容（"你好""在吗""嗯"）
- noise: 无意义消息（"继续""好的""嗯嗯"）

判断为 diary 的条件（满足任一即可）：
1. 提到了具体的人、事件、时间
2. 表达了情绪或感受
3. 描述了状态变化
4. 是一段有信息量的叙述`;

export async function classify(text: string, knownEntities?: string[]): Promise<ClassifyResult> {
  const llm = getLLM(roleLLMConfig("extract"));
  try {
    const result = await llm.chatJSON<ClassifyResult>(
      `请分类以下消息：\n\n"${text}"`,
      CLASSIFY_SYSTEM
    );
    return {
      is_meaningful: result.is_meaningful ?? false,
      modality: result.modality ?? "text",
      category: result.category ?? "noise",
      reason: result.reason,
    };
  } catch (e) {
    return ruleBasedClassify(text, knownEntities);
  }
}

/**
 * 规则兜底分类（LLM 不可用时）
 * 使用词表做关键词匹配，覆盖更全；knownEntities 传入家庭成员名/别名（运行时词典）
 */
export function ruleBasedClassify(text: string, knownEntities: string[] = []): ClassifyResult {
  const trimmed = text.trim();
  
  // 太短 = noise
  if (trimmed.length < 4) {
    return { is_meaningful: false, modality: "text", category: "noise", reason: "too short" };
  }
  
  // 纯语气词 = noise
  const noisePattern = /^(嗯+|好的?|哦+|啊+|哈+|ok|OK|继续|再见|谢谢|谢|不客气|没事|嗯嗯|哈哈|嘿嘿)$/;
  if (noisePattern.test(trimmed)) {
    return { is_meaningful: false, modality: "text", category: "noise", reason: "filler" };
  }
  
  // 关键词匹配：用词表 + 别名 + 实体名
  const diaryKeywords = [
    // 实体名：通用角色词内置，具体家人名/别名由调用方传入
    "宝宝", "爸爸", "妈妈", "外婆", "外公", "奶奶", "爷爷", "宝宝们", "孩子",
    ...knownEntities,
    // 时间词
    "今天", "昨晚", "早上", "下午", "晚上", "上周", "前天", "昨天",
    // 动作词
    "喂", "睡", "醒", "哭", "笑", "站", "爬", "走", "说", "翻身",
    // 感受词
    "觉得", "感觉", "发现", "突然", "终于",
    // 标准标签（从词表）
    ...ALL_TAGS,
    // 情绪标准词（从词表）
    ...ALL_EMOTIONS,
  ];
  
  // 别名也加入
  const aliasKeywords = [
    ...Object.keys(TAG_ALIASES),
    ...Object.keys(EMOTION_ALIASES),
  ];
  
  const allKeywords = [...diaryKeywords, ...aliasKeywords];
  const hasKeyword = allKeywords.some(k => trimmed.includes(k));
  
  if (hasKeyword && trimmed.length > 8) {
    return { is_meaningful: true, modality: "text", category: "diary", reason: "keyword match" };
  }
  
  // 长文本默认为 diary（有信息量的叙述）
  if (trimmed.length > 30) {
    return { is_meaningful: true, modality: "text", category: "diary", reason: "length heuristic" };
  }
  
  // 中等长度 = chat
  return { 
    is_meaningful: false, 
    modality: "text", 
    category: "chat",
    reason: "no diary signals" 
  };
}
