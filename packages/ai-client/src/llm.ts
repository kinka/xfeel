import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logError, logInfo, logWarn, safeErrorMessage, summarizeValue } from "../../observability/src/logging";

export interface LLMConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  timeout?: number;
  /** OpenAI 兼容网关的协议：chat=/v1/chat/completions，responses=/v1/responses。默认 chat。 */
  protocol?: "chat" | "responses";
}

/** 可被模型按需调用的工具。run 接收已解析的参数，返回值会被序列化回传给模型。 */
export interface LLMTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface RespondWithToolsResult {
  text: string;
  toolCalls: ToolCallRecord[];
}

export function resolveLLMConfig(): LLMConfig {
  const codexConfig = readCodexConfig();

  return {
    baseUrl: codexConfig.baseUrl || process.env.LLM_BASE_URL || "http://localhost:11434",
    model: codexConfig.model || process.env.LLM_MODEL || "gemma3:12b",
    apiKey: codexConfig.apiKey || process.env.LLM_API_KEY,
    temperature: 0.1,
    timeout: Number(process.env.LLM_TIMEOUT_MS) || 120_000,
    protocol: process.env.LLM_PROTOCOL === "responses" ? "responses" : "chat",
  };
}

export class LLMClient {
  private config: LLMConfig;

  constructor(config?: Partial<LLMConfig>) {
    this.config = { ...resolveLLMConfig(), ...config };
  }

  async chat(prompt: string, system?: string): Promise<string> {
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });
    const startedAt = Date.now();
    logInfo("llm_request", {
      operation: "chat",
      provider: this.provider(),
      protocol: this.protocol(),
      model: this.config.model,
      prompt_len: prompt.length,
      system_len: system?.length ?? 0,
      ...messageStats(messages),
    });

    try {
      const result = this.config.baseUrl.includes("11434")
        ? await this.callOllama(messages)
        : await this.callOpenAI(messages);
      logInfo("llm_response", {
        operation: "chat",
        provider: this.provider(),
        protocol: this.protocol(),
        model: this.config.model,
        duration_ms: Date.now() - startedAt,
        response_len: result.length,
      });
      return result;
    } catch (error) {
      logError("llm_error", {
        operation: "chat",
        provider: this.provider(),
        protocol: this.protocol(),
        model: this.config.model,
        duration_ms: Date.now() - startedAt,
        error: safeErrorMessage(error),
      });
      throw error;
    }
  }

  async chatJSON<T = unknown>(prompt: string, system?: string): Promise<T> {
    const raw = await this.chat(prompt, system);
    if (!raw) throw new Error("LLM returned empty response");
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1]!.trim() : raw.trim();
    return parseJsonLenient<T>(jsonStr);
  }

  /**
   * 多模态对话：随 prompt 附带一张或多张图片，返回纯文本。
   * 走 OpenAI 兼容的 image_url content block；Ollama 用 message.images=[base64]（仅支持 data:URL）。
   * images.url 可以是 http(s) URL 或 data:image/...;base64,xxx。
   */
  async chatVision(opts: { prompt: string; system?: string; images: Array<{ url: string }> }): Promise<string> {
    if (!opts.images?.length) return this.chat(opts.prompt, opts.system);

    if (this.config.baseUrl.includes("11434")) {
      const base64Images = opts.images
        .map(img => img.url.startsWith("data:") ? img.url.replace(/^data:[^;]+;base64,/, "") : img.url)
        .filter(Boolean);
      const messages: any[] = [];
      if (opts.system) messages.push({ role: "system", content: opts.system });
      messages.push({ role: "user", content: opts.prompt, images: base64Images });
      return this.callOllama(messages);
    }

    const content: any[] = [
      { type: "text", text: opts.prompt },
      ...opts.images.map(img => ({ type: "image_url", image_url: { url: img.url } })),
    ];
    const messages: any[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content });
    return this.callOpenAI(messages);
  }

  /** chatVision 的 JSON 版：附图 + 返回结构化 JSON（用于真·多模态抽取，目前 v1 走转写故暂未启用）。 */
  async chatVisionJSON<T = unknown>(opts: { prompt: string; system?: string; images: Array<{ url: string }> }): Promise<T> {
    const raw = await this.chatVision(opts);
    if (!raw) throw new Error("LLM returned empty response");
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1]!.trim() : raw.trim();
    return parseJsonLenient<T>(jsonStr);
  }

  private async callOllama(messages: Array<{role: string; content: any; images?: string[]}>): Promise<string> {
    const startedAt = Date.now();
    logInfo("llm_request", {
      operation: "call_ollama",
      provider: "ollama",
      protocol: "chat",
      model: this.config.model,
      ...messageStats(messages),
    });
    const body: any = {
      model: this.config.model,
      messages,
      stream: false,
      options: { temperature: this.config.temperature },
    };
    // Qwen3.6: disable thinking mode for structured extraction
    if (this.config.model.includes("qwen3.6") || this.config.model.includes("qwen3.5")) {
      body.think = false;
    }
    try {
      const resp = await fetch(`${this.config.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeout!),
      });
      if (!resp.ok) throw new Error(`Ollama error: ${resp.status} ${await resp.text()}`);
      const data = await resp.json() as { message: { content: string } };
      const content = data.message.content;
      logInfo("llm_response", {
        operation: "call_ollama",
        provider: "ollama",
        protocol: "chat",
        model: this.config.model,
        duration_ms: Date.now() - startedAt,
        response_len: content.length,
      });
      return content;
    } catch (error) {
      logError("llm_error", {
        operation: "call_ollama",
        provider: "ollama",
        protocol: "chat",
        model: this.config.model,
        duration_ms: Date.now() - startedAt,
        error: safeErrorMessage(error),
      });
      throw error;
    }
  }

  private async callOpenAI(messages: Array<{role: string; content: any}>): Promise<string> {
    const startedAt = Date.now();
    logInfo("llm_request", {
      operation: "call_openai",
      provider: "openai_compatible",
      protocol: "chat",
      model: this.config.model,
      ...messageStats(messages),
    });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;

    try {
      const resp = await fetch(getOpenAIChatCompletionsUrl(this.config.baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: this.config.temperature,
        }),
        signal: AbortSignal.timeout(this.config.timeout!),
      });
      if (!resp.ok) throw new Error(`API error: ${resp.status} ${await resp.text()}`);
      const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
      const content = data.choices[0].message.content;
      logInfo("llm_response", {
        operation: "call_openai",
        provider: "openai_compatible",
        protocol: "chat",
        model: this.config.model,
        duration_ms: Date.now() - startedAt,
        response_len: content.length,
      });
      return content;
    } catch (error) {
      logError("llm_error", {
        operation: "call_openai",
        provider: "openai_compatible",
        protocol: "chat",
        model: this.config.model,
        duration_ms: Date.now() - startedAt,
        error: safeErrorMessage(error),
      });
      throw error;
    }
  }

  /**
   * 带工具的多轮对话：模型可按需调用提供的工具（如 recall），我们执行后回传结果，
   * 直到模型给出最终文本。OpenAI 兼容网关用 chat/responses 协议；Ollama 退化为无工具直答。
   */
  async respondWithTools(opts: {
    system?: string;
    prompt: string;
    tools: LLMTool[];
    maxRounds?: number;
  }): Promise<RespondWithToolsResult> {
    const maxRounds = Math.max(1, Math.min(opts.maxRounds ?? 4, 8));
    const startedAt = Date.now();
    logInfo("llm_request", {
      operation: "respond_with_tools",
      provider: this.provider(),
      protocol: this.protocol(),
      model: this.config.model,
      prompt_len: opts.prompt.length,
      system_len: opts.system?.length ?? 0,
      tool_names: opts.tools.map(tool => tool.name),
      tools_count: opts.tools.length,
      max_rounds: maxRounds,
    });
    try {
      let result: RespondWithToolsResult;
      if (this.config.baseUrl.includes("11434") || opts.tools.length === 0) {
        // Ollama / 无工具：直接直答，不做工具循环。
        result = { text: await this.chat(opts.prompt, opts.system), toolCalls: [] };
      } else if (this.config.protocol === "responses") {
        result = await this.respondViaResponses(opts, maxRounds);
      } else {
        result = await this.respondViaChat(opts, maxRounds);
      }
      logInfo("llm_response", {
        operation: "respond_with_tools",
        provider: this.provider(),
        protocol: this.protocol(),
        model: this.config.model,
        duration_ms: Date.now() - startedAt,
        response_len: result.text.length,
        tool_calls_count: result.toolCalls.length,
      });
      return result;
    } catch (error) {
      logError("llm_error", {
        operation: "respond_with_tools",
        provider: this.provider(),
        protocol: this.protocol(),
        model: this.config.model,
        duration_ms: Date.now() - startedAt,
        error: safeErrorMessage(error),
      });
      throw error;
    }
  }

  private async respondViaChat(
    opts: { system?: string; prompt: string; tools: LLMTool[] },
    maxRounds: number,
  ): Promise<RespondWithToolsResult> {
    const startedAt = Date.now();
    const toolDefs = opts.tools.map(t => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    const messages: any[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: opts.prompt });
    const toolCalls: ToolCallRecord[] = [];
    logInfo("llm_request", {
      operation: "respond_via_chat",
      provider: "openai_compatible",
      protocol: "chat",
      model: this.config.model,
      tool_names: opts.tools.map(tool => tool.name),
      max_rounds: maxRounds,
      ...messageStats(messages),
    });

    const finish = (result: RespondWithToolsResult) => {
      logInfo("llm_response", {
        operation: "respond_via_chat",
        provider: "openai_compatible",
        protocol: "chat",
        model: this.config.model,
        duration_ms: Date.now() - startedAt,
        response_len: result.text.length,
        tool_calls_count: result.toolCalls.length,
      });
      return result;
    };

    try {
      for (let round = 0; round < maxRounds; round++) {
        const isLast = round === maxRounds - 1;
        const msg = await this.chatCompletionRaw(messages, isLast ? undefined : toolDefs, round);
        const calls = msg.tool_calls || [];
        if (calls.length === 0 || isLast) return finish({ text: msg.content || "", toolCalls });

        messages.push({ role: "assistant", content: msg.content || "", tool_calls: calls });
        for (const call of calls) {
          const args = safeParseJson(call.function?.arguments);
          const toolName = call.function?.name || "";
          const tool = opts.tools.find(t => t.name === toolName);
          const toolStartedAt = Date.now();
          try {
            const result = tool ? await tool.run(args) : { error: `unknown tool: ${toolName}` };
            logInfo("llm_tool_call", {
              operation: "respond_via_chat",
              provider: "openai_compatible",
              protocol: "chat",
              model: this.config.model,
              round,
              tool_name: toolName,
              args_keys: Object.keys(args),
              result_summary: summarizeValue(result),
              duration_ms: Date.now() - toolStartedAt,
            });
            toolCalls.push({ name: toolName, args, result });
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
          } catch (error) {
            logError("llm_error", {
              operation: "llm_tool_call",
              provider: "openai_compatible",
              protocol: "chat",
              model: this.config.model,
              round,
              tool_name: toolName,
              duration_ms: Date.now() - toolStartedAt,
              error: safeErrorMessage(error),
            });
            throw error;
          }
        }
      }
      return finish({ text: "", toolCalls });
    } catch (error) {
      logError("llm_error", {
        operation: "respond_via_chat",
        provider: "openai_compatible",
        protocol: "chat",
        model: this.config.model,
        duration_ms: Date.now() - startedAt,
        error: safeErrorMessage(error),
      });
      throw error;
    }
  }

  private async chatCompletionRaw(
    messages: any[],
    tools?: any[],
    round?: number,
  ): Promise<{ content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }> {
    const startedAt = Date.now();
    logInfo("llm_request", {
      operation: "chat_completion_raw",
      provider: "openai_compatible",
      protocol: "chat",
      model: this.config.model,
      round,
      tool_names: toolNamesFromChatDefs(tools),
      tools_count: tools?.length ?? 0,
      ...messageStats(messages),
    });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    const body: any = { model: this.config.model, messages, temperature: this.config.temperature };
    if (tools?.length) { body.tools = tools; body.tool_choice = "auto"; }
    try {
      const resp = await fetch(getOpenAIChatCompletionsUrl(this.config.baseUrl), {
        method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.config.timeout!),
      });
      if (!resp.ok) throw new Error(`API error: ${resp.status} ${await resp.text()}`);
      const data = await resp.json() as { choices: Array<{ message: any }> };
      const message = data.choices[0].message;
      logInfo("llm_response", {
        operation: "chat_completion_raw",
        provider: "openai_compatible",
        protocol: "chat",
        model: this.config.model,
        round,
        duration_ms: Date.now() - startedAt,
        response_len: typeof message.content === "string" ? message.content.length : 0,
        tool_calls_count: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
      });
      return message;
    } catch (error) {
      logError("llm_error", {
        operation: "chat_completion_raw",
        provider: "openai_compatible",
        protocol: "chat",
        model: this.config.model,
        round,
        duration_ms: Date.now() - startedAt,
        error: safeErrorMessage(error),
      });
      throw error;
    }
  }

  private async respondViaResponses(
    opts: { system?: string; prompt: string; tools: LLMTool[] },
    maxRounds: number,
  ): Promise<RespondWithToolsResult> {
    const startedAt = Date.now();
    const toolDefs = opts.tools.map(t => ({
      type: "function", name: t.name, description: t.description, parameters: t.parameters,
    }));
    const input: any[] = [{ role: "user", content: opts.prompt }];
    const toolCalls: ToolCallRecord[] = [];
    logInfo("llm_request", {
      operation: "respond_via_responses",
      provider: "openai_compatible",
      protocol: "responses",
      model: this.config.model,
      prompt_len: opts.prompt.length,
      system_len: opts.system?.length ?? 0,
      tool_names: opts.tools.map(tool => tool.name),
      max_rounds: maxRounds,
    });

    const finish = (result: RespondWithToolsResult) => {
      logInfo("llm_response", {
        operation: "respond_via_responses",
        provider: "openai_compatible",
        protocol: "responses",
        model: this.config.model,
        duration_ms: Date.now() - startedAt,
        response_len: result.text.length,
        tool_calls_count: result.toolCalls.length,
      });
      return result;
    };

    try {
      for (let round = 0; round < maxRounds; round++) {
        const isLast = round === maxRounds - 1;
        const data = await this.responsesRaw(input, isLast ? undefined : toolDefs, opts.system, round);
        const output: any[] = data.output || [];
        const fnCalls = output.filter(item => item.type === "function_call");
        if (fnCalls.length === 0 || isLast) {
          return finish({ text: extractResponsesText(data), toolCalls });
        }
        for (const call of fnCalls) {
          input.push(call);
          const args = safeParseJson(call.arguments);
          const toolName = call.name || "";
          const tool = opts.tools.find(t => t.name === toolName);
          const toolStartedAt = Date.now();
          try {
            const result = tool ? await tool.run(args) : { error: `unknown tool: ${toolName}` };
            logInfo("llm_tool_call", {
              operation: "respond_via_responses",
              provider: "openai_compatible",
              protocol: "responses",
              model: this.config.model,
              round,
              tool_name: toolName,
              args_keys: Object.keys(args),
              result_summary: summarizeValue(result),
              duration_ms: Date.now() - toolStartedAt,
            });
            toolCalls.push({ name: toolName, args, result });
            input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
          } catch (error) {
            logError("llm_error", {
              operation: "llm_tool_call",
              provider: "openai_compatible",
              protocol: "responses",
              model: this.config.model,
              round,
              tool_name: toolName,
              duration_ms: Date.now() - toolStartedAt,
              error: safeErrorMessage(error),
            });
            throw error;
          }
        }
      }
      return finish({ text: "", toolCalls });
    } catch (error) {
      logError("llm_error", {
        operation: "respond_via_responses",
        provider: "openai_compatible",
        protocol: "responses",
        model: this.config.model,
        duration_ms: Date.now() - startedAt,
        error: safeErrorMessage(error),
      });
      throw error;
    }
  }

  private async responsesRaw(input: any[], tools?: any[], instructions?: string, round?: number): Promise<any> {
    const startedAt = Date.now();
    logInfo("llm_request", {
      operation: "responses_raw",
      provider: "openai_compatible",
      protocol: "responses",
      model: this.config.model,
      round,
      tool_names: toolNamesFromResponsesDefs(tools),
      tools_count: tools?.length ?? 0,
      input_items: input.length,
      input_chars: responseInputChars(input),
      instructions_len: instructions?.length ?? 0,
    });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    const body: any = { model: this.config.model, input, temperature: this.config.temperature };
    if (instructions) body.instructions = instructions;
    if (tools?.length) { body.tools = tools; body.tool_choice = "auto"; }
    try {
      const resp = await fetch(getResponsesUrl(this.config.baseUrl), {
        method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.config.timeout!),
      });
      if (!resp.ok) throw new Error(`Responses API error: ${resp.status} ${await resp.text()}`);
      const data = await resp.json();
      const output = Array.isArray(data.output) ? data.output : [];
      logInfo("llm_response", {
        operation: "responses_raw",
        provider: "openai_compatible",
        protocol: "responses",
        model: this.config.model,
        round,
        duration_ms: Date.now() - startedAt,
        response_len: extractResponsesText(data).length,
        output_items: output.length,
        function_calls_count: output.filter((item: any) => item.type === "function_call").length,
      });
      return data;
    } catch (error) {
      logError("llm_error", {
        operation: "responses_raw",
        provider: "openai_compatible",
        protocol: "responses",
        model: this.config.model,
        round,
        duration_ms: Date.now() - startedAt,
        error: safeErrorMessage(error),
      });
      throw error;
    }
  }

  private provider(): "ollama" | "openai_compatible" {
    return this.config.baseUrl.includes("11434") ? "ollama" : "openai_compatible";
  }

  private protocol(): "chat" | "responses" | "ollama_chat" {
    return this.config.baseUrl.includes("11434") ? "ollama_chat" : this.config.protocol || "chat";
  }
}

/**
 * 解析 LLM 返回的 JSON，对常见“脏 JSON”做一次修复后再试。
 * 主要修复点：抽取器要求 original_span/surface 原样照抄原文，模型会把原文里的半角双引号
 * 一并塞进字符串值且不转义（如 `波波池里"游泳"`），导致字符串被提前闭合、JSON.parse 抛错。
 * 修复成功则记一条 warn，失败则抛出原始解析错误，交由上层走既有降级路径。
 */
export function parseJsonLenient<T = unknown>(jsonStr: string): T {
  try {
    return JSON.parse(jsonStr) as T;
  } catch (error) {
    const repaired = repairUnescapedQuotes(jsonStr);
    if (repaired !== jsonStr) {
      try {
        const parsed = JSON.parse(repaired) as T;
        logWarn("llm_json_repaired", { error: safeErrorMessage(error) });
        return parsed;
      } catch {
        // 修复后仍失败：抛出原始错误，保留可读的原因
      }
    }
    throw error;
  }
}

/**
 * 把字符串值内部未转义的双引号转义。状态机扫描：一个 `"` 是字符串的结束引号，
 * 当且仅当其后第一个非空白字符是 JSON 结构符（, } ] :）或到达结尾；否则视为内容里的杂散引号并转义。
 */
function repairUnescapedQuotes(input: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (ch === "\\") {
      out += ch + (input[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j]!)) j++;
      const next = input[j];
      if (next === undefined || next === "," || next === "}" || next === "]" || next === ":") {
        out += ch;
        inString = false;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function safeParseJson(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function messageStats(messages: Array<{ role?: string; content?: unknown }>): Record<string, unknown> {
  const lengths = messages.map(message => contentLength(message.content));
  return {
    message_count: messages.length,
    input_chars: lengths.reduce((sum, len) => sum + len, 0),
    message_lengths: lengths.slice(0, 12),
    max_message_len: lengths.reduce((max, len) => Math.max(max, len), 0),
  };
}

function contentLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + contentLength(item), 0);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text.length;
    if (typeof record.content === "string") return record.content.length;
    try {
      return JSON.stringify(value).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

function responseInputChars(input: any[]): number {
  return input.reduce((sum, item) => {
    if (typeof item?.output === "string") return sum + item.output.length;
    if (typeof item?.arguments === "string") return sum + item.arguments.length;
    return sum + contentLength(item?.content);
  }, 0);
}

function toolNamesFromChatDefs(tools?: any[]): string[] {
  return (tools || [])
    .map(tool => tool?.function?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

function toolNamesFromResponsesDefs(tools?: any[]): string[] {
  return (tools || [])
    .map(tool => tool?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

function extractResponsesText(data: any): string {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text;
  const parts: string[] = [];
  for (const item of data.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("").trim();
}

let defaultClient: LLMClient | null = null;
export function getLLM(config?: Partial<LLMConfig>): LLMClient {
  if (!config && defaultClient) return defaultClient;
  const client = new LLMClient(config);
  if (!config) defaultClient = client;
  return client;
}

function readCodexConfig(): Partial<LLMConfig> {
  try {
    const codexDir = process.env.CODEX_HOME || join(homedir(), ".codex");
    const configPath = join(codexDir, "config.toml");
    if (!existsSync(configPath)) return {};

    const parsed = parseCodexToml(readFileSync(configPath, "utf8"));
    const provider = parsed.model_provider ? parsed.model_providers[parsed.model_provider] : undefined;
    const apiKey = provider?.requires_openai_auth ? readCodexOpenAIKey(join(codexDir, "auth.json")) : undefined;

    return {
      baseUrl: provider?.base_url,
      model: parsed.model,
      apiKey,
    };
  } catch {
    return {};
  }
}

function readCodexOpenAIKey(authPath: string): string | undefined {
  try {
    if (!existsSync(authPath)) return undefined;
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
    return typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.trim()
      ? auth.OPENAI_API_KEY
      : undefined;
  } catch {
    return undefined;
  }
}

interface ParsedCodexToml {
  model_provider?: string;
  model?: string;
  model_providers: Record<string, { base_url?: string; requires_openai_auth?: boolean }>;
}

function parseCodexToml(input: string): ParsedCodexToml {
  const result: ParsedCodexToml = { model_providers: {} };
  let section: string[] = [];

  for (const rawLine of input.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1]!.split(".");
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!kv) continue;

    const key = kv[1]!;
    const value = parseTomlScalar(kv[2]!.trim());
    if (section.length === 0) {
      if (key === "model_provider" && typeof value === "string") result.model_provider = value;
      if (key === "model" && typeof value === "string") result.model = value;
      continue;
    }

    if (section[0] === "model_providers" && section[1]) {
      const providerName = section[1];
      const provider = result.model_providers[providerName] || {};
      if (key === "base_url" && typeof value === "string") provider.base_url = value;
      if (key === "requires_openai_auth" && typeof value === "boolean") provider.requires_openai_auth = value;
      result.model_providers[providerName] = provider;
    }
  }

  return result;
}

function stripTomlComment(line: string): string {
  let inString = false;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (ch === "#" && !inString) return line.slice(0, i);
  }

  return line;
}

function parseTomlScalar(raw: string): string | boolean | number {
  if (raw.startsWith("\"") && raw.endsWith("\"")) return raw.slice(1, -1);
  if (raw === "true") return true;
  if (raw === "false") return false;
  const num = Number(raw);
  return Number.isFinite(num) ? num : raw;
}

function getOpenAIChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1")
    ? `${trimmed}/chat/completions`
    : `${trimmed}/v1/chat/completions`;
}

function getResponsesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}/responses` : `${trimmed}/v1/responses`;
}
