import { describe, expect, test } from "bun:test";
import { deriveEventDate, toDateOnly } from "./provenance";

describe("provenance dates", () => {
  test("deriveEventDate fallback uses local date", () => {
    expect(deriveEventDate(new Date("2026-01-14T17:30:00.000Z"))).toBe("2026-01-15");
  });

  test("toDateOnly preserves explicit business dates", () => {
    expect(toDateOnly("2026-01-14T17:30:00.000Z")).toBe("2026-01-14");
    expect(toDateOnly("2026-01-15")).toBe("2026-01-15");
  });
});
