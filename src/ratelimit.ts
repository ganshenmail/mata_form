/**
 * 内存版限流与登录锁定（单进程部署）
 * - rateLimit：固定窗口计数器
 * - 登录失败锁定：连续失败 N 次锁定一段时间
 * 多实例部署时需将存储替换为 Redis 等共享存储
 */

interface Win {
  count: number;
  start: number;
  windowMs: number;
}

const windows = new Map<string, Win>();
const MAX_TRACK = 5000;

/** 固定窗口限流：返回 true 表示放行 */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (windows.size > MAX_TRACK) {
    for (const [k, w] of windows) {
      if (now - w.start >= w.windowMs) windows.delete(k);
    }
  }
  let w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    w = { count: 0, start: now, windowMs };
    windows.set(key, w);
  }
  w.count++;
  return w.count <= limit;
}

interface Fail {
  n: number;
  lockedUntil: number;
}

const fails = new Map<string, Fail>();

/** 剩余锁定秒数（0 = 未锁定） */
export function isLockedOut(key: string): number {
  const e = fails.get(key);
  if (!e || e.lockedUntil <= Date.now()) return 0;
  return Math.ceil((e.lockedUntil - Date.now()) / 1000);
}

/** 记录一次登录失败（默认连续 5 次锁定 15 分钟） */
export function recordLoginFail(key: string, max = 5, lockMs = 15 * 60 * 1000): void {
  const e = fails.get(key) ?? { n: 0, lockedUntil: 0 };
  e.n += 1;
  if (e.n >= max) {
    e.lockedUntil = Date.now() + lockMs;
    e.n = 0;
  }
  fails.set(key, e);
}

export function clearLoginFails(key: string): void {
  fails.delete(key);
}
