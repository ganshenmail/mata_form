/**
 * 登录验证码：内存版 SVG 图形验证码
 * - 纯文本生成 SVG，无需任何图像库 / 外部服务
 * - 5 分钟有效、一次性使用（无论对错，校验后即销毁，防重放与爆破）
 * - 内存 Map 存储，带数量上限与过期清理（单进程部署场景）
 */
import { randomUUID, randomInt } from "node:crypto";

interface CaptchaEntry {
  code: string;
  expiresAt: number;
}

const store = new Map<string, CaptchaEntry>();
const TTL = 5 * 60 * 1000; // 5 分钟
const MAX_STORED = 500;    // 内存保护上限

// 去掉易混淆字符（i/l/o/1/0 等）
const CHARS = "abcdefghjkmnpqrstuvwxyz23456789";

function gc(): void {
  const nowTs = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt < nowTs) store.delete(k);
  }
}

/** 生成一个验证码：返回 id 与可直接内嵌的 SVG */
export function createCaptcha(): { id: string; svg: string } {
  gc();
  if (store.size >= MAX_STORED) store.clear(); // 极端情况下直接清空
  const code = Array.from({ length: 4 }, () => CHARS[randomInt(CHARS.length)]).join("");
  const id = randomUUID();
  store.set(id, { code, expiresAt: Date.now() + TTL });
  return { id, svg: renderSvg(code) };
}

/** 校验并销毁验证码（大小写不敏感） */
export function verifyCaptcha(id: unknown, code: unknown): boolean {
  if (typeof id !== "string" || typeof code !== "string") return false;
  const entry = store.get(id);
  if (!entry) return false;
  store.delete(id);
  if (entry.expiresAt < Date.now()) return false;
  return entry.code === code.trim().toLowerCase();
}

function renderSvg(code: string): string {
  const W = 132, H = 44;
  const colors = ["#2563eb", "#dc2626", "#157347", "#d97706", "#7c3aed", "#0f766e"];
  const pick = () => colors[randomInt(colors.length)];
  const parts: string[] = [];

  // 干扰线
  for (let i = 0; i < 4; i++) {
    const x1 = randomInt(W), y1 = randomInt(H), x2 = randomInt(W), y2 = randomInt(H);
    parts.push('<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 +
      '" stroke="' + pick() + '" stroke-width="1" opacity="0.35" />');
  }
  // 干扰点
  for (let i = 0; i < 24; i++) {
    parts.push('<circle cx="' + randomInt(W) + '" cy="' + randomInt(H) +
      '" r="1" fill="' + pick() + '" opacity="0.4" />');
  }
  // 字符（随机颜色 / 位置抖动 / 旋转）
  const step = (W - 30) / code.length;
  code.split("").forEach((ch, i) => {
    const x = 18 + i * step + randomInt(4) - 2;
    const y = 30 + randomInt(6) - 3;
    const rot = randomInt(24) - 12;
    parts.push('<text x="' + x + '" y="' + y + '" font-family="Georgia, serif" font-size="24" font-weight="700" fill="' +
      pick() + '" transform="rotate(' + rot + ' ' + x + ' ' + y + ')">' + ch + '</text>');
  });

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H +
    '" viewBox="0 0 ' + W + ' ' + H + '">' +
    '<rect width="' + W + '" height="' + H + '" rx="8" fill="#eef1f5" />' +
    parts.join("") + '</svg>';
}
