import { createHash } from "node:crypto";

export type LogFields = Record<string, unknown>;

const DEFAULT_PREVIEW_LIMIT = 80;
const MAX_STRING_LENGTH = 220;
const MAX_ARRAY_ITEMS = 12;
const MAX_OBJECT_DEPTH = 3;
const SENSITIVE_KEY_RE = /(authorization|api[_-]?key|access[_-]?token|token|secret|password|connection[_-]?string)/i;
const CREDENTIAL_FRAGMENT_RE = /(?:bearer\s+[^\s,;]+)|(?:(?:authorization|api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*[^&\s,;]+)/gi;

export function previewText(value: unknown, max = DEFAULT_PREVIEW_LIMIT): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

export function hashId(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  if (!normalized) return undefined;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function maskId(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  if (!normalized) return undefined;
  if (normalized.length <= 6) return `${normalized.slice(0, 1)}***`;
  return `${normalized.slice(0, 2)}***${normalized.slice(-4)}`;
}

export function textLogFields(name: string, value: unknown, max = DEFAULT_PREVIEW_LIMIT): LogFields {
  const text = String(value ?? "");
  return {
    [`${name}_len`]: text.length,
    [`${name}_hash`]: hashId(text),
    [`${name}_preview`]: previewText(text, max),
  };
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactString(message).slice(0, MAX_STRING_LENGTH);
}

export function summarizeValue(value: unknown): LogFields {
  if (Array.isArray(value)) {
    return { type: "array", count: value.length };
  }
  if (value && typeof value === "object") {
    return { type: "object", keys: Object.keys(value).slice(0, MAX_ARRAY_ITEMS), key_count: Object.keys(value).length };
  }
  if (typeof value === "string") {
    return { type: "string", len: value.length, hash: hashId(value), preview: previewText(value) };
  }
  return { type: typeof value };
}

export function logInfo(event: string, fields: LogFields = {}): void {
  writeLog("info", event, fields);
}

export function logWarn(event: string, fields: LogFields = {}): void {
  writeLog("warn", event, fields);
}

export function logError(event: string, fields: LogFields = {}): void {
  writeLog("error", event, fields);
}

function writeLog(level: "info" | "warn" | "error", event: string, fields: LogFields): void {
  const payload = sanitizeObject({ level, event, time: new Date().toISOString(), ...fields }, 0);
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

function sanitizeObject(input: LogFields, depth: number): LogFields {
  const output: LogFields = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      output.credential_redacted = true;
      continue;
    }
    output[key] = sanitizeValue(value, depth + 1);
  }
  return output;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const redacted = redactString(value);
    return redacted.length > MAX_STRING_LENGTH ? `${redacted.slice(0, MAX_STRING_LENGTH)}...` : redacted;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return safeErrorMessage(value);
  if (Array.isArray(value)) {
    if (depth >= MAX_OBJECT_DEPTH) return { type: "array", count: value.length };
    return value.slice(0, MAX_ARRAY_ITEMS).map(item => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= MAX_OBJECT_DEPTH) return { type: "object", keys: Object.keys(value).slice(0, MAX_ARRAY_ITEMS), key_count: Object.keys(value).length };
    return sanitizeObject(value as LogFields, depth);
  }
  return String(value);
}

function redactString(input: string): string {
  return input.replace(CREDENTIAL_FRAGMENT_RE, "[credential_redacted]");
}
