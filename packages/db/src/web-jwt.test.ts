import { describe, expect, test } from "bun:test";
import { signWebToken, verifyWebToken } from "./web-jwt";

const SECRET = "test-secret-please-ignore";

describe("web-jwt (HS256)", () => {
  test("sign → verify roundtrip carries claims", () => {
    const { token, expiresAt } = signWebToken({ sub: "owner-1", fam: "fam-1", uid: "wx-a", label: "爸爸" }, 60_000, SECRET);
    const claims = verifyWebToken(token, SECRET);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("owner-1");
    expect(claims!.fam).toBe("fam-1");
    expect(claims!.uid).toBe("wx-a");
    expect(claims!.label).toBe("爸爸");
    expect(claims!.exp * 1000).toBe(Date.parse(expiresAt));
  });

  test("rejects tampered payload", () => {
    const { token } = signWebToken({ sub: "owner-1" }, 60_000, SECRET);
    const [h, , s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "attacker", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
    expect(verifyWebToken(`${h}.${forged}.${s}`, SECRET)).toBeNull();
  });

  test("rejects wrong secret", () => {
    const { token } = signWebToken({ sub: "owner-1" }, 60_000, SECRET);
    expect(verifyWebToken(token, "other-secret")).toBeNull();
  });

  test("rejects expired token", () => {
    const { token } = signWebToken({ sub: "owner-1" }, -1_000, SECRET);
    expect(verifyWebToken(token, SECRET)).toBeNull();
  });

  test("rejects malformed tokens", () => {
    expect(verifyWebToken("", SECRET)).toBeNull();
    expect(verifyWebToken("a.b", SECRET)).toBeNull();
    expect(verifyWebToken("not-a-jwt", SECRET)).toBeNull();
  });

  test("rejects alg=none downgrade", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ sub: "x", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
    expect(verifyWebToken(`${header}.${body}.`, SECRET)).toBeNull();
  });
});
