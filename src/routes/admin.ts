/**
 * 后台管理 API（/admin/api/*）
 * 登录 / 表单 CRUD / 提交数据查看与删除 / 统计 / CSV 导出
 */
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie, generateCookie } from "hono/cookie";
import { db, now, genSlug, type FormRow, type AdminRow } from "../db";
import {
  normalizeFields,
  isChoiceType,
  type FormField,
} from "../fields";
import {
  COOKIE_NAME,
  COOKIE_MAX_AGE,
  CSRF_COOKIE,
  makeToken,
  verifyToken,
  hashPassword,
  verifyPassword,
  makeCsrf,
  verifyCsrf,
  isHttps,
} from "../auth";
import { ROLE_PERMS, hasPerm, PERM_LABELS, type AdminUser } from "../roles";
import { createCaptcha, verifyCaptcha } from "../captcha";
import { audit, listAudit } from "../audit";
import { rateLimit, isLockedOut, recordLoginFail, clearLoginFails } from "../ratelimit";
import { uploadAbsPath, deleteUploads, collectFilePaths } from "../files";
import { getClientIp } from "../ip";
import { join } from "node:path";
import QRCode from "qrcode";
import XLSX from "xlsx";

const admin = new Hono<{ Variables: { adminUser: AdminUser } }>();

// ---------- 工具 ----------
const STATUSES = new Set(["draft", "published", "closed"]);

function parseForm(row: FormRow) {
  let fields: FormField[] = [];
  try {
    fields = JSON.parse(row.fields || "[]");
  } catch {
    fields = [];
  }
  let webhookIds: number[] = [];
  try {
    webhookIds = JSON.parse(row.webhook_ids || "[]");
  } catch {
    webhookIds = [];
  }
  return {
    ...row,
    fields,
    ipLimit: row.ip_limit,
    showOnHome: !!row.show_on_home,
    webhookIds: Array.isArray(webhookIds) ? webhookIds : [],
  };
}

/** 解析 IP 上限配置：0–999 的整数，0 表示不限制 */
function parseIpLimit(x: unknown): number {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.min(999, Math.max(0, Math.floor(n)));
}

function getFormRow(id: string | number): FormRow | null {
  const row = db.query("SELECT * FROM forms WHERE id = ?").get(Number(id)) as
    | FormRow
    | undefined;
  return row ?? null;
}

// ---------- 登录 / 登出 ----------
admin.post("/api/login", async (c) => {
  const ip = getClientIp(c);
  if (!rateLimit("login:" + ip, 20, 60_000)) {
    return c.json({ error: "请求过于频繁，请稍后再试" }, 429);
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  // 验证码校验（一次性，先于密码校验，防暴力破解；id 来自生成图片时写入的 Cookie）
  if (!verifyCaptcha(getCookie(c, "captcha_id"), body.captchaCode)) {
    return c.json({ error: "验证码错误或已过期", code: "captcha" }, 401);
  }

  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");

  // 登录失败锁定：同 IP + 用户名 连续失败 5 次锁定 15 分钟
  const lockKey = ip + "|" + username;
  const locked = isLockedOut(lockKey);
  if (locked > 0) {
    return c.json({ error: "失败次数过多，请 " + Math.ceil(locked / 60) + " 分钟后再试", code: "locked" }, 429);
  }

  const row = db.query("SELECT * FROM admins WHERE username = ?").get(username) as
    | AdminRow
    | undefined;
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    recordLoginFail(lockKey);
    return c.json({ error: "用户名或密码错误" }, 401);
  }
  clearLoginFails(lockKey);
  setCookie(c, COOKIE_NAME, makeToken(row.id, row.username), {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: COOKIE_MAX_AGE,
    secure: isHttps(c),
  });
  deleteCookie(c, "captcha_id", { path: "/" });
  // 登录成功即种下 CSRF Cookie，并把令牌回传前端（后续写请求需经 X-CSRF-Token 头回传）
  let csrf = getCookie(c, CSRF_COOKIE);
  if (!csrf) {
    csrf = makeCsrf();
    setCookie(c, CSRF_COOKIE, csrf, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: isHttps(c),
    });
  }
  audit(row.username, "login", row.username);
  return c.json({ ok: true, me: { id: row.id, username: row.username, role: row.role }, csrf });
});

/**
 * 登录验证码：直接输出 SVG 图片（前端 <img> 直接引用，无任何客户端编码环节）
 * 验证码 id 写入短效 Cookie（5 分钟），与图片天然配对
 */
admin.get("/api/captcha", (c) => {
  if (!rateLimit("captcha:" + getClientIp(c), 60, 60_000)) {
    return c.json({ error: "请求过于频繁，请稍后再试" }, 429);
  }
  const { id, svg } = createCaptcha();
  // 注意：这里必须手动构造 Set-Cookie 头 —— 返回裸 Response 时，
  // Hono 不会把 setCookie() 写入的暂存头合并进响应（context.js res setter 仅合并已实例化的 #res）
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": generateCookie("captcha_id", id, {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        maxAge: 300,
        secure: isHttps(c),
      }),
    },
  });
});

admin.post("/api/logout", (c) => {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
  return c.json({ ok: true });
});

// ---------- 认证中间件（登录/登出豁免；每次请求回库核对最新角色；写请求校验 CSRF） ----------
admin.use("/api/*", async (c, next) => {
  const p = c.req.path;
  if (p.endsWith("/api/login") || p.endsWith("/api/logout") || p.endsWith("/api/captcha")) return next();
  const payload = verifyToken(getCookie(c, COOKIE_NAME));
  if (!payload) return c.json({ error: "未登录或登录已过期" }, 401);
  const row = db.query("SELECT * FROM admins WHERE id = ?").get(payload.id) as
    | AdminRow
    | undefined;
  if (!row) return c.json({ error: "账号不存在或已被删除" }, 401);
  c.set("adminUser", { id: row.id, username: row.username, role: row.role });

  // CSRF 防护：非 GET/HEAD 请求必须携带与 httpOnly Cookie 匹配的 X-CSRF-Token 头
  const method = c.req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const cookieTok = getCookie(c, CSRF_COOKIE);
    const headerTok = c.req.header("x-csrf-token");
    if (!verifyCsrf(cookieTok, headerTok)) {
      return c.json({ error: "请求校验失败，请刷新页面后重试", code: "csrf" }, 403);
    }
  }
  await next();
});

/** 权限守卫：无权限返回 403 */
function requirePerm(perm: string) {
  return async (c: { get: (k: string) => AdminUser | undefined; json: (v: unknown, s?: number) => Response }, next: () => Promise<void>) => {
    const u = c.get("adminUser");
    if (!u || !hasPerm(u.role, perm)) {
      return c.json({ error: `没有执行此操作的权限：${PERM_LABELS[perm] || perm}` }, 403);
    }
    await next();
  };
}

admin.get("/api/me", (c) => {
  const u = c.get("adminUser");
  // 确保 CSRF Cookie 存在，并把令牌回传前端（httpOnly Cookie 前端读不到，需经响应体获取）
  let csrf = getCookie(c, CSRF_COOKIE);
  if (!csrf) {
    csrf = makeCsrf();
    setCookie(c, CSRF_COOKIE, csrf, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: isHttps(c),
    });
  }
  return c.json({ ok: true, me: { ...u, perms: ROLE_PERMS[u.role] || [] }, csrf });
});

/** 自己修改密码（需验证旧密码） */
admin.post("/api/me/password", async (c) => {
  const u = c.get("adminUser");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const oldPassword = String(body.oldPassword ?? "");
  const newPassword = String(body.newPassword ?? "");
  const row = db.query("SELECT * FROM admins WHERE id = ?").get(u.id) as
    | AdminRow
    | undefined;
  if (!row) return c.json({ error: "账号不存在" }, 404);
  if (!(await verifyPassword(oldPassword, row.password_hash))) {
    return c.json({ error: "旧密码不正确" }, 400);
  }
  if (newPassword.length < 6) return c.json({ error: "新密码至少 6 位" }, 400);
  db.query("UPDATE admins SET password_hash = ? WHERE id = ?").run(
    await hashPassword(newPassword),
    row.id
  );
  audit(u.username, "password.change", u.username);
  return c.json({ ok: true });
});

/** 审计日志（仅超级管理员） */
admin.get("/api/audit", requirePerm("admin:manage"), (c) => {
  return c.json({ logs: listAudit(Number(c.req.query("limit")) || 200) });
});

// ---------- 表单 CRUD ----------
admin.get("/api/forms", (c) => {
  const rows = db
    .query(
      `SELECT f.id, f.title, f.slug, f.status, f.show_on_home, f.created_at, f.updated_at,
              (SELECT COUNT(*) FROM submissions s WHERE s.form_id = f.id) AS submission_count
       FROM forms f
       ORDER BY f.id DESC`
    )
    .all();
  return c.json({ forms: rows });
});

admin.post("/api/forms", requirePerm("form:create"), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const title = String(body.title ?? "").trim();
  if (!title) return c.json({ error: "表单标题不能为空" }, 400);
  if (title.length > 100) return c.json({ error: "表单标题过长（≤100 字）" }, 400);
  const description = String(body.description ?? "").trim().slice(0, 1000);
  const ipLimit = parseIpLimit(body.ipLimit ?? 0);
  const showOnHome = body.showOnHome === undefined ? 1 : (body.showOnHome ? 1 : 0);
  const nf = normalizeFields(body.fields);
  if (!nf.ok) return c.json({ error: nf.error }, 400);

  const t = now();
  const r = db
    .query(
      "INSERT INTO forms (title, description, slug, status, fields, created_at, updated_at, ip_limit, show_on_home) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)"
    )
    .run(title, description, genSlug(), JSON.stringify(nf.fields), t, t, ipLimit, showOnHome);
  const row = getFormRow(Number(r.lastInsertRowid))!;
  return c.json({ form: parseForm(row) }, 201);
});

admin.get("/api/forms/:id", (c) => {
  const row = getFormRow(c.req.param("id"));
  if (!row) return c.json({ error: "表单不存在" }, 404);
  return c.json({ form: parseForm(row) });
});

admin.put("/api/forms/:id", requirePerm("form:update"), async (c) => {
  const row = getFormRow(c.req.param("id"));
  if (!row) return c.json({ error: "表单不存在" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const title = String(body.title ?? row.title).trim();
  if (!title) return c.json({ error: "表单标题不能为空" }, 400);
  const description = String(body.description ?? row.description).trim().slice(0, 1000);

  let rawFields: unknown = body.fields;
  if (rawFields === undefined) {
    try {
      rawFields = JSON.parse(row.fields || "[]");
    } catch {
      rawFields = [];
    }
  }
  const nf = normalizeFields(rawFields);
  if (!nf.ok) return c.json({ error: nf.error }, 400);

  let status = row.status;
  if (body.status !== undefined) {
    status = String(body.status);
    if (!STATUSES.has(status)) return c.json({ error: "状态值无效" }, 400);
    // 状态变更（发布/关闭）属 form:publish 权限范围，PUT 同样受此约束（与 PATCH /status 一致）
    if (status !== row.status && !hasPerm(c.get("adminUser").role, "form:publish")) {
      return c.json({ error: "没有执行此操作的权限：" + (PERM_LABELS["form:publish"] || "发布表单") }, 403);
    }
  }
  const ipLimit = body.ipLimit === undefined ? row.ip_limit : parseIpLimit(body.ipLimit);
  const showOnHome = body.showOnHome === undefined ? row.show_on_home : (body.showOnHome ? 1 : 0);
  // 表单引用的 Webhook 预设：只保留真实存在的 id
  let webhookIdsJson = row.webhook_ids;
  if (body.webhookIds !== undefined) {
    const wanted = (Array.isArray(body.webhookIds) ? body.webhookIds : [])
      .map(Number)
      .filter((n) => Number.isInteger(n));
    const existing = new Set(
      (db.query("SELECT id FROM webhooks").all() as { id: number }[]).map((r) => r.id)
    );
    webhookIdsJson = JSON.stringify([...new Set(wanted)].filter((id) => existing.has(id)));
  }

  db.query(
    "UPDATE forms SET title = ?, description = ?, fields = ?, status = ?, ip_limit = ?, show_on_home = ?, webhook_ids = ?, updated_at = ? WHERE id = ?"
  ).run(title, description, JSON.stringify(nf.fields), status, ipLimit, showOnHome, webhookIdsJson, now(), row.id);
  audit(c.get("adminUser").username, "form.update", title);
  if (status !== row.status) {
    audit(c.get("adminUser").username, "form.publish", title, status);
  }
  return c.json({ form: parseForm(getFormRow(row.id)!) });
});

/** 克隆表单（草稿态副本，默认不在首页展示） */
admin.post("/api/forms/:id/clone", requirePerm("form:create"), async (c) => {
  const row = getFormRow(c.req.param("id"));
  if (!row) return c.json({ error: "表单不存在" }, 404);
  const t = now();
  const title = (row.title + "（副本）").slice(0, 100);
  const r = db
    .query(
      "INSERT INTO forms (title, description, slug, status, fields, created_at, updated_at, ip_limit, show_on_home, webhook_url, webhook_type) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, 0, ?, ?)"
    )
    .run(title, row.description, genSlug(), row.fields, t, t, row.ip_limit, row.webhook_url, row.webhook_type);
  const created = getFormRow(Number(r.lastInsertRowid))!;
  audit(c.get("adminUser").username, "form.clone", created.title);
  return c.json({ form: parseForm(created) }, 201);
});

admin.patch("/api/forms/:id/status", requirePerm("form:publish"), async (c) => {
  const row = getFormRow(c.req.param("id"));
  if (!row) return c.json({ error: "表单不存在" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const status = String(body.status ?? "");
  if (!STATUSES.has(status)) return c.json({ error: "状态值无效" }, 400);
  db.query("UPDATE forms SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    now(),
    row.id
  );
  audit(c.get("adminUser").username, "form.publish", row.title, status);
  return c.json({ ok: true, status });
});

/** 设置表单是否在首页「表单中心」展示 */
admin.patch("/api/forms/:id/show", requirePerm("form:update"), async (c) => {
  const row = getFormRow(c.req.param("id"));
  if (!row) return c.json({ error: "表单不存在" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const show = body.show ? 1 : 0;
  db.query("UPDATE forms SET show_on_home = ?, updated_at = ? WHERE id = ?").run(show, now(), row.id);
  audit(c.get("adminUser").username, "form.show", row.title, show ? "显示" : "隐藏");
  return c.json({ ok: true, showOnHome: !!show });
});

admin.delete("/api/forms/:id", requirePerm("form:delete"), async (c) => {
  const row = getFormRow(c.req.param("id"));
  if (!row) return c.json({ error: "表单不存在" }, 404);
  const rows = db.query("SELECT data FROM submissions WHERE form_id = ?").all(row.id) as {
    data: string;
  }[];
  const rels: string[] = [];
  for (const r of rows) {
    try {
      rels.push(...collectFilePaths(JSON.parse(r.data || "{}")));
    } catch {}
  }
  await deleteUploads(row.id, rels);
  db.query("DELETE FROM submissions WHERE form_id = ?").run(row.id);
  db.query("DELETE FROM forms WHERE id = ?").run(row.id);
  audit(c.get("adminUser").username, "form.delete", row.title);
  return c.json({ ok: true });
});

// ---------- 提交数据 ----------
// ---------- 提交数据 / 字段筛选 ----------
interface SubmissionRecord {
  id: number;
  ip: string;
  data: Record<string, unknown>;
  created_at: string;
}

/** 解析筛选参数（filters=JSON）：仅保留合法字段 id，值裁剪为 ≤200 字符的非空字符串 */
function parseFilters(
  raw: string | undefined,
  fields: FormField[]
): Record<string, string> {
  if (!raw) return {};
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const ids = new Set(fields.map((f) => f.id));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!ids.has(k)) continue;
    const s = String(v ?? "").trim().slice(0, 200);
    if (s) out[k] = s;
  }
  return out;
}

/** 单条提交是否匹配某字段的筛选值 */
function matchFilter(f: FormField, v: unknown, fv: string): boolean {
  switch (f.type) {
    case "radio":
    case "select":
    case "date":
      return String(v ?? "") === fv;
    case "checkbox":
      return Array.isArray(v) && v.map(String).includes(fv);
    case "number": {
      const n = Number(fv);
      if (Number.isFinite(n)) return Number(v) === n;
      return String(v ?? "").toLowerCase().includes(fv.toLowerCase());
    }
    default: {
      const s = Array.isArray(v) ? v.join("、") : String(v ?? "");
      return s.toLowerCase().includes(fv.toLowerCase());
    }
  }
}

/**
 * 加载表单全部提交（按 id 倒序）并应用关键词 + 字段筛选。
 * 提交内容以 JSON 存储，筛选在应用层完成，适合中小数据量。
 */
function loadSubmissions(
  formId: number,
  fields: FormField[],
  keyword: string,
  filters: Record<string, string>,
  from = "",
  to = ""
): SubmissionRecord[] {
  const rows = db
    .query("SELECT id, ip, data, created_at FROM submissions WHERE form_id = ? ORDER BY id DESC")
    .all(formId) as { id: number; ip: string; data: string; created_at: string }[];

  const kw = keyword.toLowerCase();
  const fieldMap = new Map(fields.map((f) => [f.id, f]));
  const filterEntries = Object.entries(filters);
  const out: SubmissionRecord[] = [];

  for (const r of rows) {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(r.data || "{}");
    } catch {
      data = {};
    }
    if (kw && !(r.data + " " + r.ip).toLowerCase().includes(kw)) continue;
    const dkey = localDate(new Date(r.created_at));
    if (from && dkey < from) continue;
    if (to && dkey > to) continue;
    let ok = true;
    for (const [fid, fv] of filterEntries) {
      const f = fieldMap.get(fid)!;
      if (!matchFilter(f, data[fid], fv)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    out.push({ id: r.id, ip: r.ip, data, created_at: r.created_at });
  }
  return out;
}

admin.get("/api/forms/:id/submissions", requirePerm("data:view"), (c) => {
  const row = getFormRow(c.req.param("id"));
  if (!row) return c.json({ error: "表单不存在" }, 404);
  const fields = parseForm(row).fields;

  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const size = Math.min(100, Math.max(1, Number(c.req.query("size")) || 20));
  const keyword = (c.req.query("q") || "").trim();
  const filters = parseFilters(c.req.query("filters"), fields);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("from") || "") ? c.req.query("from")! : "";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("to") || "") ? c.req.query("to")! : "";

  const all = loadSubmissions(row.id, fields, keyword, filters, from, to);
  const total = all.length;
  const rows = all.slice((page - 1) * size, page * size);

  return c.json({ total, page, size, filters, rows });
});

admin.delete("/api/forms/:id/submissions", requirePerm("data:clear"), async (c) => {
  const row = getFormRow(c.req.param("id"));
  if (!row) return c.json({ error: "表单不存在" }, 404);
  const rows = db.query("SELECT data FROM submissions WHERE form_id = ?").all(row.id) as {
    data: string;
  }[];
  const rels: string[] = [];
  for (const r of rows) {
    try {
      rels.push(...collectFilePaths(JSON.parse(r.data || "{}")));
    } catch {}
  }
  await deleteUploads(row.id, rels);
  db.query("DELETE FROM submissions WHERE form_id = ?").run(row.id);
  audit(c.get("adminUser").username, "data.clear", row.title);
  return c.json({ ok: true });
});

admin.delete("/api/submissions/:id", requirePerm("data:delete"), async (c) => {
  const id = Number(c.req.param("id"));
  const row = db.query("SELECT form_id, data FROM submissions WHERE id = ?").get(id) as
    | { form_id: number; data: string }
    | undefined;
  if (row) {
    await deleteUploads(row.form_id, collectFilePaths(JSON.parse(row.data || "{}")));
    db.query("DELETE FROM submissions WHERE id = ?").run(id);
    audit(c.get("adminUser").username, "data.delete", "#" + id);
  }
  return c.json({ ok: true });
});

// CSV 导出（带 BOM，Excel 直接打开不乱码；支持与列表一致的关键词/字段筛选）
admin.get("/api/forms/:id/submissions/export", requirePerm("data:export"), async (c) => {
  const row = getFormRow(c.req.param("id"));
  if (!row) return c.json({ error: "表单不存在" }, 404);
  const fields = parseForm(row).fields;
  const keyword = (c.req.query("q") || "").trim();
  const filters = parseFilters(c.req.query("filters"), fields);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("from") || "") ? c.req.query("from")! : "";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("to") || "") ? c.req.query("to")! : "";

  // 导出按 id 正序（列表默认倒序）
  const recs = loadSubmissions(row.id, fields, keyword, filters, from, to).reverse();

  const header = ["提交ID", "提交时间", "提交IP", ...fields.map((f) => f.label)];
  const cellText = (v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) return (v as { name?: unknown }).name ?? "";
    return Array.isArray(v) ? v.join("; ") : v;
  };
  const rowCells = (r: { id: number; ip: string; data: Record<string, unknown>; created_at: string }) =>
    fields.map((f) => cellText(r.data[f.id]));

  if (c.req.query("format") === "xlsx") {
    const ws = XLSX.utils.aoa_to_sheet([
      header,
      ...recs.map((r) => [r.id, r.created_at, r.ip, ...rowCells(r)]),
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "submissions");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="form-' + row.slug + '-submissions.xlsx"',
      },
    });
  }

  // 公式注入防护：以 = + - @ \t \r 开头的值前置单引号，避免 Excel 打开时执行公式
  const DANGEROUS_LEAD = /^[=+\-@\t\r]/;
  const csvEsc = (v: unknown) => {
    let s = String(v ?? "");
    if (DANGEROUS_LEAD.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [header.map(csvEsc).join(",")];
  for (const r of recs) {
    lines.push([r.id, r.created_at, r.ip, ...rowCells(r)].map(csvEsc).join(","));
  }
  const csv = "\ufeff" + lines.join("\r\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="form-' + row.slug + '-submissions.csv"',
    },
  });
});

// ---------- 统计 ----------
function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

admin.get("/api/forms/:id/stats", requirePerm("stats:view"), (c) => {
  const row = getFormRow(c.req.param("id"));
  if (!row) return c.json({ error: "表单不存在" }, 404);
  const fields = parseForm(row).fields;

  const rows = db
    .query("SELECT ip, data, created_at FROM submissions WHERE form_id = ?")
    .all(row.id) as { ip: string; data: string; created_at: string }[];

  const total = rows.length;
  const todayKey = localDate(new Date());

  // 趋势与字段统计的时间范围：?days=N（默认 14，上限 90）或 ?from=&to= 自定义
  const qDays = Math.min(90, Math.max(1, Number(c.req.query("days")) || 14));
  const qFrom = c.req.query("from") || "";
  const qTo = c.req.query("to") || "";
  const rangeKeys: string[] = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(qFrom) && /^\d{4}-\d{2}-\d{2}$/.test(qTo) && qFrom <= qTo) {
    const cursor = new Date(qFrom + "T00:00:00");
    const end = new Date(qTo + "T00:00:00");
    while (cursor <= end && rangeKeys.length < 120) {
      rangeKeys.push(localDate(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
  } else {
    for (let i = qDays - 1; i >= 0; i--) {
      rangeKeys.push(localDate(new Date(Date.now() - i * 86400000)));
    }
  }
  const rangeSet = new Set(rangeKeys);
  const trendMap = new Map<string, number>();
  for (const k of rangeKeys) trendMap.set(k, 0);
  const weekStart = localDate(new Date(Date.now() - 6 * 86400000));

  // 各字段聚合器
  type Agg = {
    field: FormField;
    answered: number;
    counts: Map<string, number>; // 选项 -> 次数
    num: { min: number; max: number; sum: number; count: number };
    texts: Map<string, number>; // 文本值 -> 次数
  };
  const aggs = new Map<string, Agg>(
    fields.map((f) => [
      f.id,
      {
        field: f,
        answered: 0,
        counts: new Map(),
        num: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
        texts: new Map(),
      },
    ])
  );

  const ipSet = new Set<string>();
  let today = 0;
  let week = 0;
  for (const r of rows) {
    if (r.ip) ipSet.add(r.ip);
    const key = localDate(new Date(r.created_at));
    if (key === todayKey) today++;
    if (key >= weekStart && key <= todayKey) week++;
    if (!rangeSet.has(key)) continue;
    if (trendMap.has(key)) trendMap.set(key, trendMap.get(key)! + 1);

    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(r.data || "{}");
    } catch {
      data = {};
    }
    for (const f of fields) {
      const agg = aggs.get(f.id)!;
      const v = data[f.id];
      if (
        v === undefined || v === null || v === "" ||
        (Array.isArray(v) && v.length === 0)
      ) {
        continue;
      }
      agg.answered++;
      if (isChoiceType(f.type)) {
        for (const item of Array.isArray(v) ? v : [v]) {
          const s = String(item);
          agg.counts.set(s, (agg.counts.get(s) || 0) + 1);
        }
      } else if (f.type === "number") {
        const n = Number(v);
        if (Number.isFinite(n)) {
          agg.num.min = Math.min(agg.num.min, n);
          agg.num.max = Math.max(agg.num.max, n);
          agg.num.sum += n;
          agg.num.count++;
        }
      } else if (f.type === "file") {
        // 文件：仅统计提交数
      } else {
        const s = String(v).trim();
        if (s) agg.texts.set(s, (agg.texts.get(s) || 0) + 1);
      }
    }
  }

  const trend = [...trendMap.entries()].map(([date, count]) => ({ date, count }));

  const fieldStats = fields.map((f) => {
    const agg = aggs.get(f.id)!;
    const base: Record<string, unknown> = {
      id: f.id,
      type: f.type,
      label: f.label,
      answered: agg.answered,
      // 显示开关随字段定义回传（前端按此过滤统计卡片）
      inStats: f.inStats !== false,
      inList: f.inList !== false,
      inFilter: f.inFilter !== false,
    };
    if (isChoiceType(f.type)) {
      // 选项按定义顺序输出；兼容历史数据中可能出现的不在选项内的值
      const extra = [...agg.counts.keys()].filter((k) => !f.options!.includes(k));
      const values = [...f.options!, ...extra];
      const sum = values.reduce((acc, v) => acc + (agg.counts.get(v) || 0), 0) || 1;
      base.options = values.map((v) => {
        const count = agg.counts.get(v) || 0;
        return { value: v, count, pct: Math.round((count / sum) * 100) };
      });
    } else if (f.type === "number") {
      if (agg.num.count > 0) {
        base.min = agg.num.min;
        base.max = agg.num.max;
        base.sum = agg.num.sum;
        base.avg = agg.num.sum / agg.num.count;
      }
    } else if (f.type === "file") {
      // 文件：仅 answered
    } else {
      base.top = [...agg.texts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([value, count]) => ({ value, count }));
    }
    return base;
  });

  return c.json({
    total,
    today,
    week,
    ips: ipSet.size,
    range: { from: rangeKeys[0] || "", to: rangeKeys[rangeKeys.length - 1] || "" },
    trend,
    fields: fieldStats,
  });
});

// ---------- 管理员管理（仅超级管理员） ----------
admin.get("/api/admins", requirePerm("admin:manage"), (c) => {
  const rows = db
    .query("SELECT id, username, role, created_at FROM admins ORDER BY id ASC")
    .all();
  return c.json({ admins: rows });
});

admin.post("/api/admins", requirePerm("admin:manage"), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  const role = String(body.role ?? "");
  if (username.length < 2 || username.length > 32) {
    return c.json({ error: "用户名需 2-32 个字符" }, 400);
  }
  if (password.length < 6) return c.json({ error: "密码至少 6 位" }, 400);
  if (!ROLE_PERMS[role]) return c.json({ error: "角色无效" }, 400);
  const exists = db.query("SELECT id FROM admins WHERE username = ?").get(username);
  if (exists) return c.json({ error: "用户名已存在" }, 409);
  const hash = await hashPassword(password);
  const t = now();
  const r = db
    .query("INSERT INTO admins (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)")
    .run(username, hash, role, t);
  audit(c.get("adminUser").username, "admin.create", username, role);
  return c.json({ admin: { id: Number(r.lastInsertRowid), username, role, created_at: t } }, 201);
});

admin.put("/api/admins/:id", requirePerm("admin:manage"), async (c) => {
  const row = db.query("SELECT * FROM admins WHERE id = ?").get(Number(c.req.param("id"))) as
    | AdminRow
    | undefined;
  if (!row) return c.json({ error: "管理员不存在" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  let newHash: string | null = null;
  if (body.password !== undefined && body.password !== "") {
    const password = String(body.password);
    if (password.length < 6) return c.json({ error: "密码至少 6 位" }, 400);
    newHash = await hashPassword(password);
  }

  let newRole: string | null = null;
  if (body.role !== undefined) {
    const role = String(body.role);
    if (!ROLE_PERMS[role]) return c.json({ error: "角色无效" }, 400);
    if (role !== row.role && row.role === "super") {
      const supers = (db
        .query("SELECT COUNT(*) AS n FROM admins WHERE role = 'super'")
        .get() as { n: number }).n;
      if (supers <= 1) return c.json({ error: "至少保留一名超级管理员" }, 400);
    }
    newRole = role;
  }

  if (newHash) db.query("UPDATE admins SET password_hash = ? WHERE id = ?").run(newHash, row.id);
  if (newRole) db.query("UPDATE admins SET role = ? WHERE id = ?").run(newRole, row.id);
  const changed: string[] = [];
  if (newHash) changed.push("密码");
  if (newRole) changed.push("角色=" + newRole);
  audit(c.get("adminUser").username, "admin.update", row.username, changed.join("，"));
  return c.json({ ok: true });
});

admin.delete("/api/admins/:id", requirePerm("admin:manage"), async (c) => {
  const me = c.get("adminUser");
  const row = db.query("SELECT * FROM admins WHERE id = ?").get(Number(c.req.param("id"))) as
    | AdminRow
    | undefined;
  if (!row) return c.json({ error: "管理员不存在" }, 404);
  if (row.id === me.id) return c.json({ error: "不能删除当前登录的账号" }, 400);
  if (row.role === "super") {
    const supers = (db
      .query("SELECT COUNT(*) AS n FROM admins WHERE role = 'super'")
      .get() as { n: number }).n;
    if (supers <= 1) return c.json({ error: "至少保留一名超级管理员" }, 400);
  }
  db.query("DELETE FROM admins WHERE id = ?").run(row.id);
  audit(c.get("adminUser").username, "admin.delete", row.username);
  return c.json({ ok: true });
});

/** 上传文件下载（需登录 + data:view 权限） */
admin.get("/api/forms/:id/submissions/:subId/files/:fieldId", requirePerm("data:view"), async (c) => {
  const row = getFormRow(c.req.param("id"));
  if (!row) return c.json({ error: "表单不存在" }, 404);
  const sub = db
    .query("SELECT data FROM submissions WHERE id = ? AND form_id = ?")
    .get(Number(c.req.param("subId")), row.id) as { data: string } | undefined;
  if (!sub) return c.json({ error: "提交不存在" }, 404);
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(sub.data || "{}");
  } catch {
    data = {};
  }
  const meta = data[c.req.param("fieldId")] as { path?: string; name?: string } | undefined;
  if (!meta || typeof meta.path !== "string") return c.json({ error: "文件不存在" }, 404);
  const abs = uploadAbsPath(row.id, meta.path);
  if (!abs) return c.json({ error: "文件路径无效" }, 400);
  const file = Bun.file(abs);
  if (!(await file.exists())) return c.json({ error: "文件不存在" }, 404);
  const fname = encodeURIComponent(String(meta.name || "file"));
  return new Response(file, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment; filename=\"file\"; filename*=UTF-8''" + fname,
    },
  });
});

/** 填写页链接二维码（SVG，无外部服务）；链接基址可用 PUBLIC_BASE_URL 固定（防 Host 头影响） */
admin.get("/api/forms/:id/qrcode", requirePerm("data:view"), async (c) => {
  const row = getFormRow(c.req.param("id"));
  if (!row) return c.json({ error: "表单不存在" }, 404);
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "") || new URL(c.req.url).origin;
  const url = base + "/f/" + row.slug;
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, width: 240 });
  return new Response(svg, {
    headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store" },
  });
});

// ---------- Webhook 预设管理（增删改仅超级管理员） ----------

/** 校验 Webhook 输入（名称/地址/请求方式/请求数据模板） */
function parseWebhookInput(
  input: Record<string, unknown>
): { error: string } | { name: string; url: string; method: string; body: string } {
  const name = String(input.name ?? "").trim();
  const url = String(input.url ?? "").trim();
  const method = String(input.method ?? "POST").toUpperCase();
  const body = String(input.body ?? "").slice(0, 2000);
  if (!name) return { error: "名称不能为空" };
  if (!/^https?:\/\//.test(url)) return { error: "地址需以 http(s):// 开头" };
  if (!["GET", "POST", "PUT"].includes(method)) return { error: "请求方式无效" };
  if (method === "GET" && body.trim() !== "") return { error: "GET 请求不支持请求数据" };
  if (body.trim() !== "" && !body.includes("{{")) {
    try {
      JSON.parse(body);
    } catch {
      return { error: "请求数据不是合法的 JSON" };
    }
  }
  return { name, url, method, body };
}
// 列表需 form:update（编辑表单时勾选 Webhook 要用）；增删改仅超级管理员
admin.get("/api/webhooks", requirePerm("form:update"), (c) => {
  return c.json({
    webhooks: db
      .query("SELECT id, name, url, method, body, created_at FROM webhooks ORDER BY id ASC")
      .all(),
  });
});

admin.post("/api/webhooks", requirePerm("admin:manage"), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const input = parseWebhookInput({
    name: body.name,
    url: body.url,
    method: body.method ?? "POST",
    body: body.body ?? "",
  });
  if ("error" in input) return c.json({ error: input.error }, 400);
  const t = now();
  const r = db
    .query("INSERT INTO webhooks (name, url, method, body, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(input.name, input.url, input.method, input.body, t);
  audit(c.get("adminUser").username, "webhook.create", input.name);
  return c.json(
    { webhook: { id: Number(r.lastInsertRowid), name: input.name, url: input.url, method: input.method, body: input.body, created_at: t } },
    201
  );
});

admin.put("/api/webhooks/:id", requirePerm("admin:manage"), async (c) => {
  const row = db.query("SELECT * FROM webhooks WHERE id = ?").get(Number(c.req.param("id"))) as
    | { id: number; name: string; url: string; method: string; body: string }
    | undefined;
  if (!row) return c.json({ error: "Webhook 不存在" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const input = parseWebhookInput({
    name: body.name ?? row.name,
    url: body.url ?? row.url,
    method: body.method ?? row.method,
    body: body.body ?? row.body,
  });
  if ("error" in input) return c.json({ error: input.error }, 400);
  db.query("UPDATE webhooks SET name = ?, url = ?, method = ?, body = ? WHERE id = ?").run(
    input.name,
    input.url,
    input.method,
    input.body,
    row.id
  );
  audit(c.get("adminUser").username, "webhook.update", input.name);
  return c.json({ ok: true });
});

admin.delete("/api/webhooks/:id", requirePerm("admin:manage"), async (c) => {
  const row = db.query("SELECT * FROM webhooks WHERE id = ?").get(Number(c.req.param("id"))) as
    | { id: number; name: string; url: string; type: string }
    | undefined;
  if (!row) return c.json({ error: "Webhook 不存在" }, 404);
  db.query("DELETE FROM webhooks WHERE id = ?").run(row.id);
  // 解除所有表单对该 Webhook 的引用
  const forms = db
    .query("SELECT id, webhook_ids FROM forms WHERE webhook_ids LIKE ?")
    .all('%"' + String(row.id) + '"%') as { id: number; webhook_ids: string }[];
  for (const fm of forms) {
    try {
      const ids = JSON.parse(fm.webhook_ids || "[]").filter((x: number) => x !== row.id);
      db.query("UPDATE forms SET webhook_ids = ? WHERE id = ?").run(JSON.stringify(ids), fm.id);
    } catch {}
  }
  audit(c.get("adminUser").username, "webhook.delete", row.name);
  return c.json({ ok: true });
});

export default admin;
