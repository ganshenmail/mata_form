/**
 * 客户端 IP 识别（共用模块）
 *
 * 安全模型：反代头（X-Forwarded-For / X-Real-IP）只在连接来源属于「可信代理」时才采信，
 * 否则一律使用 TCP 连接信息 —— 防止客户端直接伪造请求头绕过限流 / IP 提交上限 / 溯源。
 *
 * 配置：TRUSTED_PROXIES 环境变量，逗号分隔的 IP 或 CIDR（如 "127.0.0.1,10.0.0.0/8,::1"）。
 * - 未配置时：不信任任何反代头（直连部署的安全默认）。
 * - 部署在反向代理（nginx / Caddy / 网关）之后时，必须把代理地址加入白名单，
 *   否则所有客户端都会被识别为代理自身 IP（IP 上限会按代理 IP 统计）。
 */
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";

interface Cidr {
  base: bigint;
  mask: number; // IPv4 用 0-32，IPv6 用 0-128
  bits: number; // 32（IPv4）或 128（IPv6）
}

const trustedAddrs = new Set<string>();
const trustedV4Cidrs: Cidr[] = [];
const trustedV6Cidrs: Cidr[] = [];

/** 解析 IPv4 为 32 位 BigInt，失败返回 null */
function parseIPv4(s: string): bigint | null {
  if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s)) return null;
  const p = s.split(".").map(Number);
  if (p.some((n) => n > 255)) return null;
  return (
    (BigInt(p[0]) << 24n) |
    (BigInt(p[1]) << 16n) |
    (BigInt(p[2]) << 8n) |
    BigInt(p[3])
  );
}

/** 解析 IPv6 为 128 位 BigInt，失败返回 null；支持 :: 压缩与 ::ffff:a.b.c.d 映射形式 */
function parseIPv6(s: string): bigint | null {
  s = s.trim().replace(/^\[/, "").replace(/\]$/, "").split("%")[0];
  if (s.toLowerCase().startsWith("::ffff:") && /^\d+\.\d+\.\d+\.\d+$/.test(s.slice(7))) {
    const v4 = parseIPv4(s.slice(7));
    return v4 === null ? null : 0xffff00000000n + v4; // ::ffff:a.b.c.d
  }
  let groups: string[];
  if (s.includes("::")) {
    const [l, r] = s.split("::");
    const left = l ? l.split(":") : [];
    const right = r ? r.split(":") : [];
    if (left.length + right.length >= 8) return null;
    groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  } else {
    groups = s.split(":");
    if (groups.length !== 8) return null;
  }
  if (groups.some((g) => g === "" || !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(parseInt(g, 16));
  return n;
}

function loadTrusted(): void {
  const raw = process.env.TRUSTED_PROXIES || "";
  for (const part of raw.split(",")) {
    const item = part.trim();
    if (!item) continue;
    const cidr = item.match(/^(.+?)\/(\d{1,3})$/);
    if (cidr) {
      const isV6 = cidr[1].includes(":");
      const int = isV6 ? parseIPv6(cidr[1]) : parseIPv4(cidr[1]);
      const mask = Number(cidr[2]);
      if (int === null || mask < 0 || mask > (isV6 ? 128 : 32)) continue;
      (isV6 ? trustedV6Cidrs : trustedV4Cidrs).push({
        base: int,
        mask,
        bits: isV6 ? 128 : 32,
      });
    } else if (/^[0-9a-fA-F:.]+$/.test(item)) {
      trustedAddrs.add(item);
    }
  }
}
loadTrusted();

function matchesCidr(int: bigint, list: Cidr[]): boolean {
  for (const c of list) {
    const shift = c.bits - c.mask;
    if (shift < 0) continue;
    if (int >> BigInt(shift) === c.base >> BigInt(shift)) return true;
  }
  return false;
}

/** 连接地址是否来自可信代理 */
function isTrustedProxy(addr: string | undefined): boolean {
  if (!addr) return false;
  if (trustedAddrs.has(addr)) return true;
  const lower = addr.toLowerCase();
  if (lower.includes(":")) {
    // IPv6-mapped IPv4（::ffff:a.b.c.d）：同时按 IPv4 与 IPv6 白名单匹配
    if (lower.startsWith("::ffff:")) {
      const v4 = parseIPv4(lower.slice(7));
      if (v4 !== null && matchesCidr(v4, trustedV4Cidrs)) return true;
    }
    const v6 = parseIPv6(lower);
    return v6 !== null && matchesCidr(v6, trustedV6Cidrs);
  }
  const v4 = parseIPv4(addr);
  return v4 !== null && matchesCidr(v4, trustedV4Cidrs);
}

/** 从反代头取「第一个」客户端地址（X-Forwarded-For 取最左） */
function firstProxyHeader(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.split(",")[0].trim().slice(0, 64);
}

export function getClientIp(c: Context): string {
  let peer: string | undefined;
  try {
    const info = getConnInfo(c);
    peer = info?.remote?.address;
  } catch {
    // 非 HTTP 上下文等异常情况，忽略
  }
  if (isTrustedProxy(peer)) {
    const xff = firstProxyHeader(c.req.header("x-forwarded-for"));
    if (xff) return xff;
    const xri = firstProxyHeader(c.req.header("x-real-ip"));
    if (xri) return xri;
  }
  return peer ? peer.slice(0, 64) : "unknown";
}
