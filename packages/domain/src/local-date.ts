export function localDateString(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.TZ || "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const year = byType.year;
  const month = byType.month;
  const day = byType.day;
  return `${year}-${month}-${day}`;
}

export function normalizeLocalDate(input?: string, now: Date = new Date()): string {
  if (!input) return localDateString(now);
  const dateOnly = input.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
    throw new Error("date must be YYYY-MM-DD");
  }
  return dateOnly;
}
