import { getLLM } from "../../ai-client/src/llm";
import { roleLLMConfig } from "../../ai-client/src/roles";
import { logWarn, safeErrorMessage } from "../../observability/src/logging";

const CAPTION_SYSTEM = `你在帮一个家庭记录日常生活。用户发来一张照片，请用口语化的中文，简洁描述这张照片里能看到什么。

要求：
1. 只写画面里确实可见的内容：有谁、在做什么、场景氛围。不要描述画质、构图、像素这类摄影术语。
2. 严禁编造画面之外的信息：不要臆测动机（如「拍下来留念」）、来历（如「新买的」「街边偶遇」）、地点名称或事件背景。
3. 人物关系看不出来就用中性说法（「一个人」「一位男士」「两个小孩」），不要默认是「家人/孩子」；更不要猜名字。
4. 如果附有用户的文字说明或近期对话，以用户说的为事实基准，画面描述用来补充细节；两者矛盾时相信用户。
5. 20~60 字，一两句话，自然口语，不要分点、不要加引号。
6. 只输出这句描述本身，不要任何前后缀。`;

export interface CaptionResult {
  caption: string;
  /** true 表示转写失败、退化为占位描述，调用方应据此降级处理（仍可入库但标记不可靠）。 */
  degraded: boolean;
}

/**
 * 把一张/多张图片转写成中文日记式描述（v1「先转写、再走老管线」的前置步骤）。
 * 失败时返回占位描述 + degraded=true，不抛错——让上层照样能把「收到一张照片」记下来。
 */
export async function captionImageToDiary(input: {
  images: Array<{ url: string }>;
  speakerLabel?: string;
  /** 用户随图附的文字说明（事实基准，优先级最高） */
  note?: string;
  /** 发图前几分钟内用户说过的话（上下文，如「新买的车」应影响转写视角） */
  recentText?: string;
}): Promise<CaptionResult> {
  if (!input.images?.length) return { caption: input.note?.trim() || "（收到一张图片，但没有图像内容）", degraded: true };

  const promptLines = ["请把这张照片转写成一句简洁的中文描述。"];
  if (input.speakerLabel) promptLines.push(`发照片的人是「${input.speakerLabel}」。`);
  if (input.note?.trim()) promptLines.push(`用户随图附的文字说明（以此为事实基准）：${input.note.trim()}`);
  if (input.recentText?.trim()) promptLines.push(`用户发图前刚说过（可作背景参考）：${input.recentText.trim()}`);

  try {
    const caption = (await getLLM(roleLLMConfig("extract")).chatVision({
      prompt: promptLines.join("\n"),
      system: CAPTION_SYSTEM,
      images: input.images,
    })).trim();

    if (!caption) return { caption: input.note?.trim() || "（收到一张照片）", degraded: true };
    return { caption, degraded: false };
  } catch (error) {
    logWarn("vision_caption_fallback", {
      error: safeErrorMessage(error),
      images: input.images.length,
      has_note: Boolean(input.note?.trim()),
    });
    return { caption: input.note?.trim() || "（收到一张照片，暂时没能看清内容）", degraded: true };
  }
}
