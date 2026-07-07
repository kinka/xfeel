import { localDateString } from "./local-date";

export const EXTRACTOR_VERSION = "extractor-v1";
export const VOCAB_VERSION = "vocab-v1";
export const SEARCH_TEXT_VERSION = "canonical-search-v1";

const DATE_ONLY_RE = /^(\d{4}-\d{2}-\d{2})/;

export function deriveEventDate(...candidates: Array<string | Date | null | undefined>): string {
  for (const candidate of candidates) {
    const date = toDateOnly(candidate);
    if (date) return date;
  }
  return localDateString();
}

export function toDateOnly(value?: string | Date | null): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : localDateString(value);
  }
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const direct = trimmed.match(DATE_ONLY_RE)?.[1];
  if (direct) return direct;

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return undefined;
}
