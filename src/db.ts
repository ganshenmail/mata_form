/**
 * 数据库初始化（bun:sqlite，Bun 内置 SQLite，零原生依赖）
 * 数据文件位于项目根目录 data/form.db
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const dataDir = join(import.meta.dir, "..", "data");
mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, "form.db"));

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
// 写事务（BEGIN IMMEDIATE）并发时等待锁，而不是立即失败
db.exec("PRAGMA busy_timeout = 5000;");

db.exec(`
  CREATE TABLE IF NOT EXISTS forms (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    slug        TEXT    NOT NULL UNIQUE,
    status      TEXT    NOT NULL DEFAULT 'draft',  -- draft | published | closed
    ip_limit    INTEGER NOT NULL DEFAULT 0,        -- 同一 IP 提交上限（0 = 不限制）
    show_on_home INTEGER NOT NULL DEFAULT 1,       -- 是否在首页「表单中心」展示（1 = 显示）
    webhook_url  TEXT    NOT NULL DEFAULT '',      -- （旧）按表单直填地址，已由 webhook_ids 取代
    webhook_type TEXT    NOT NULL DEFAULT '',      -- （旧）
    webhook_ids  TEXT    NOT NULL DEFAULT '[]',    -- 引用的 Webhook 预设 id（JSON 数组）
    fields      TEXT    NOT NULL DEFAULT '[]',     -- 字段定义 JSON
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    form_id    INTEGER NOT NULL,
    ip         TEXT    NOT NULL DEFAULT '',       -- 提交者 IP（用于 IP 限制与溯源）
    data       TEXT    NOT NULL DEFAULT '{}',     -- 提交数据 JSON：{ 字段ID: 值 }
    created_at TEXT    NOT NULL,
    FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS admins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'viewer',
    created_at    TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL,
    action     TEXT    NOT NULL,
    target     TEXT    NOT NULL DEFAULT '',
    detail     TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS webhooks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    url        TEXT    NOT NULL,
    method     TEXT    NOT NULL DEFAULT 'POST',   -- GET | POST | PUT
    body       TEXT    NOT NULL DEFAULT '',       -- 请求数据模板（占位符），空 = 内置通用 JSON
    created_at TEXT    NOT NULL
  );
`);

// ---------- 旧库平滑迁移：缺列自动补列 ----------
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn("forms", "ip_limit", "ip_limit INTEGER NOT NULL DEFAULT 0");
ensureColumn("forms", "show_on_home", "show_on_home INTEGER NOT NULL DEFAULT 1");
ensureColumn("forms", "webhook_url", "webhook_url TEXT NOT NULL DEFAULT ''");
ensureColumn("forms", "webhook_type", "webhook_type TEXT NOT NULL DEFAULT ''");
ensureColumn("forms", "webhook_ids", "webhook_ids TEXT NOT NULL DEFAULT '[]'");
ensureColumn("webhooks", "method", "method TEXT NOT NULL DEFAULT 'POST'");
ensureColumn("webhooks", "body", "body TEXT NOT NULL DEFAULT ''");
ensureColumn("submissions", "ip", "ip TEXT NOT NULL DEFAULT ''");

// 建索引（必须放在补列迁移之后，确保新旧库列均已存在）
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_submissions_form ON submissions(form_id, id);
  CREATE INDEX IF NOT EXISTS idx_submissions_form_ip ON submissions(form_id, ip);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
`);

/** 当前 UTC 时间（ISO 字符串） */
export const now = (): string => new Date().toISOString();

// ---------- 类型 ----------
export interface FormRow {
  id: number;
  title: string;
  description: string;
  slug: string;
  status: string;
  ip_limit: number; // 同一 IP 提交上限（0 = 不限制）
  show_on_home: number; // 是否在首页展示（1 = 显示）
  webhook_url: string; // （旧）按表单直填地址，已由 webhook_ids 取代
  webhook_type: string; // （旧）
  webhook_ids: string; // 引用的 Webhook 预设 id（JSON 数组）
  fields: string; // JSON 字符串
  created_at: string;
  updated_at: string;
}

/** 生成随机 slug（用于填写页链接 /f/:slug） */
export function genSlug(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  created_at: string;
}

/** 首次启动时创建默认超级管理员（可用 ADMIN_USERNAME / ADMIN_PASSWORD 覆盖） */
export async function ensureDefaultAdmin(): Promise<void> {
  const n = (db.query("SELECT COUNT(*) AS n FROM admins").get() as { n: number }).n;
  if (n > 0) return;
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "admin123";
  const hash = await Bun.password.hash(password);
  db.query(
    "INSERT INTO admins (username, password_hash, role, created_at) VALUES (?, ?, 'super', ?)"
  ).run(username, hash, now());
  // 不回显明文密码（生产日志泄漏风险）；密码来源见 README / 环境变量
  console.log(
    "  已创建默认超级管理员: " + username + "（请尽快登录后台修改密码）"
  );
}

/** 旧版按表单直填的 Webhook 地址迁移为预设（一次性）；非法地址（历史脏数据）跳过不迁移 */
export function migrateFormWebhooks(): void {
  const rows = db
    .query("SELECT id, webhook_url, webhook_type, webhook_ids FROM forms WHERE webhook_url != ''")
    .all() as { id: number; webhook_url: string; webhook_type: string; webhook_ids: string }[];
  for (const row of rows) {
    if (!/^https?:\/\//i.test(row.webhook_url)) continue; // 仅迁移 http(s) 地址
    let ids: number[] = [];
    try {
      ids = JSON.parse(row.webhook_ids || "[]");
    } catch {
      ids = [];
    }
    if (ids.length) continue;
    let wh = db.query("SELECT id FROM webhooks WHERE url = ?").get(row.webhook_url) as
      | { id: number }
      | undefined;
    if (!wh) {
      const r = db
        .query("INSERT INTO webhooks (name, url, method, body, created_at) VALUES (?, ?, 'POST', '', ?)")
        .run("迁移-" + (row.webhook_type || "Webhook"), row.webhook_url, now());
      wh = { id: Number(r.lastInsertRowid) };
    }
    db.query("UPDATE forms SET webhook_ids = ? WHERE id = ?").run(JSON.stringify([wh.id]), row.id);
  }
}
