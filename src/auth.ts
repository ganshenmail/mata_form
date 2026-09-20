/**
 * 后台认证：多管理员登录 + HMAC 签名 Cookie（7 天有效）
 * - 密码使用 Bun 内置 argon2id 哈希（Bun.password）
 * - Token 携带管理员 id/用户名，中间件每次请求回库核对角色（角色变更即时生效）
 * 可通过环境变量覆盖：ADMIN_SECRET（签名密钥）
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import type { Context } from "hono";

const DEFAULT_SECRET = "form-system-default-secret-change-me";
const SECRET = process.env.ADMIN_SECRET || DEFAULT_SECRET;
export const COOKIE_NAME = "form_admin_token";
export const CSRF_COOKIE = "form_csrf_token";
const MAX_AGE = 7 * 24 * 60 * 60; // 7 天（秒）

export const COOKIE_MAX_AGE = MAX_AGE;

/**
 * 生产环境安全配置校验：未显式设置签名密钥时拒绝启动，
 * 防止使用内置默认密钥导致登录 Cookie 可被伪造。
 */
export function assertSecureConfig(): void {
  if (process.env.NODE_ENV === "production" && !process.env.ADMIN_SECRET) {
    throw new Error(
      "[form-system] 生产环境必须显式设置 ADMIN_SECRET（登录 Cookie 签名密钥），拒绝启动。"
    );
  }
}

/** 当前请求是否走 HTTPS（优先读反代头 X-Forwarded-Proto，其次当前 URL 协议） */
export function isHttps(c: Context): boolean {
  const fwd = c.req.header("x-forwarded-proto");
  if (fwd) return fwd.split(",")[0].trim().toLowerCase() === "https";
  return c.req.url.startsWith("https://");
}

interface TokenPayload {
  id: number;
  username: string;
  ts: number;
}

/** 生成签名 token：base64url(payload).hmac(payload) */
export function makeToken(id: number, username: string): string {
  const payload: TokenPayload = { id, username, ts: Date.now() };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token: string | undefined): TokenPayload | null {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expect = createHmac("sha256", SECRET).update(body).digest("base64url");
  if (sig.length !== expect.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as TokenPayload;
    if (!payload || typeof payload.id !== "number") return null;
    if (Date.now() - payload.ts > MAX_AGE * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 密码哈希（Bun 内置 argon2id） */
export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

// ---------- CSRF 防护（双提交 Cookie + 自定义头） ----------

/** 生成一次性 CSRF 令牌（httpOnly Cookie 中保存，接口响应体回传，前端经自定义头回传） */
export function makeCsrf(): string {
  return randomBytes(32).toString("base64url");
}

/** 校验 CSRF：Cookie 值与请求头值需一致（常量时间比较） */
export function verifyCsrf(cookieTok: string | undefined, headerTok: string | undefined): boolean {
  if (!cookieTok || !headerTok) return false;
  const a = Buffer.from(cookieTok);
  const b = Buffer.from(headerTok);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
