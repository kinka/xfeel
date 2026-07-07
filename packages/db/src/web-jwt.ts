import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 极简 HS256 JWT（零依赖，node:crypto 实现）——只服务网页登录这一个场景。
 * 无状态：中间件仅校验签名 + exp，不查库（吊销另由 web_sessions 记录兜底）。
 *
 * 密钥来源优先级：
 *   1. XFEEL_JWT_SECRET 环境变量（生产建议显式配置，多实例共享同一值）；
 *   2. 落地文件 <data 目录>/.jwt-secret（首次自动生成并持久化，重启后 token 依旧有效）。
 * 绝不硬编码兜底密钥——避免"人人可伪造 token"。
 */

let cachedSecret: string | null = null;

function dataDir(): string {
  const dbPath = process.env.XFEEL_DB_PATH;
  if (dbPath) return dirname(resolve(dbPath));
  return resolve(process.cwd(), "data");
}

export function getJwtSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.XFEEL_JWT_SECRET?.trim();
  if (fromEnv) return (cachedSecret = fromEnv);

  const file = resolve(dataDir(), ".jwt-secret");
  try {
    if (existsSync(file)) {
      const persisted = readFileSync(file, "utf8").trim();
      if (persisted) return (cachedSecret = persisted);
    }
    const generated = randomBytes(32).toString("base64url");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, generated, { mode: 0o600 });
    return (cachedSecret = generated);
  } catch {
    // 极端只读环境：退化为进程级随机密钥（重启后旧 token 失效，但绝不弱于可预测值）
    return (cachedSecret = randomBytes(32).toString("base64url"));
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export interface WebTokenClaims {
  /** owner_id（记忆分区键） */
  sub?: string;
  /** family_id */
  fam?: string;
  /** external_user_id（openid） */
  uid?: string;
  /** platform，默认 weixin */
  plat?: string;
  /** 说话人称呼，用于前端问候 */
  label?: string;
  /** token id，对应 web_sessions.token 中记录，便于吊销/审计 */
  jti?: string;
  /** 权限范围："media" 为只读媒体 token（短期，可放进 <img> URL），缺省为完整会话 */
  scope?: string;
  iat: number;
  exp: number;
}

/** 签发一个 HS256 JWT，返回紧凑串与到期时间。 */
export function signWebToken(
  claims: Omit<WebTokenClaims, "iat" | "exp">,
  ttlMs: number,
  secret: string = getJwtSecret(),
): { token: string; expiresAt: string } {
  const now = Date.now();
  const payload: WebTokenClaims = {
    ...claims,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ttlMs) / 1000),
  };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signature = sign(`${header}.${body}`, secret);
  return { token: `${header}.${body}.${signature}`, expiresAt: new Date(payload.exp * 1000).toISOString() };
}

/** 校验签名 + 过期时间；任一不通过返回 null。纯函数，不查库。 */
export function verifyWebToken(token: string, secret: string = getJwtSecret()): WebTokenClaims | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];

  const expected = sign(`${header}.${body}`, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let head: { alg?: string };
  let claims: WebTokenClaims;
  try {
    head = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (head.alg !== "HS256") return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
  return claims;
}
