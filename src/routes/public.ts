/**
 * 公开 API（/api/public/*）：填写者获取表单、提交数据
 * - 提交支持 JSON（纯文本表单）与 multipart（含文件上传字段）
 * - 内置防滥用：IP 限流、蜜罐字段、提交耗时检查、表单级 IP 提交上限
 * - 新提交可触发 Webhook 通知（钉钉 / 企业微信 / 飞书 / 通用 JSON）
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { db, now, type FormRow } from "../db";
import { validateSubmission, sanitizePublicFields, type FormField } from "../fields";
import { getClientIp } from "../ip";
import { rateLimit } from "../ratelimit";
import { saveUpload, deleteUploads } from "../files";
import { regionTree } from "../region";

const pub = new Hono();

/** 单次提交的请求体总量上限（含全部文件与字段，经 bodyLimit 流式强制） */
const MAX_UPLOAD_TOTAL = 64 * 1024 * 1024; // 64MB
/** 单次提交允许的最大文件数 */
const MAX_UPLOAD_FILES = 20;
/** 纯 JSON 提交体上限 */
const MAX_JSON_BODY = 1024 * 1024; // 1MB
/** Webhook 渲染结果上限（防占位符无限展开） */
const MAX_WEBHOOK_URL = 2048;
const MAX_WEBHOOK_BODY = 128 * 1024;

function getFormBySlug(slug: string): FormRow | null {
  const row = db.query("SELECT * FROM forms WHERE slug = ?").get(slug) as
    | FormRow
    | undefined;
  return row ?? null;
}

/** 解析字段定义并清洗非法字段 id（与渲染端 index.ts 使用同一套确定性替换） */
function parseFields(row: FormRow): FormField[] {
  try {
    const raw: unknown = JSON.parse(row.fields || "[]");
    if (!Array.isArray(raw)) return [];
    return sanitizePublicFields(raw as FormField[]);
  } catch {
    return [];
  }
}

function countByIp(formId: number, ip: string): number {
  return (db
    .query("SELECT COUNT(*) AS n FROM submissions WHERE form_id = ? AND ip = ?")
    .get(formId, ip) as { n: number }).n;
}

/** 省市县区划数据（供地区字段联动，静态数据可长缓存） */
pub.get("/public/regions", (c) => {
  return new Response(JSON.stringify(regionTree()), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

/** 提交值转展示文本（文件取文件名） */
function fieldText(v: unknown): string {
  if (v && typeof v === "object" && !Array.isArray(v) && (v as { name?: unknown }).name) {
    return String((v as { name: unknown }).name);
  }
  return Array.isArray(v) ? v.join("、") : String(v ?? "");
}

/** 渲染模板占位符：{{title}} {{formId}} {{slug}} {{submissionId}} {{time}} {{fields}} {{json}}；超长截断防展开膨胀 */
function renderTemplate(tpl: string, vars: Record<string, string>, maxLen = 65536): string {
  const out = tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  return out.length > maxLen ? out.slice(0, maxLen) + "…(truncated)" : out;
}

/** 逐行「字段：值」文本 */
function fieldsText(data: Record<string, unknown>, fields: FormField[]): string {
  return fields
    .filter((f) => data[f.id] !== undefined)
    .map((f) => {
      const s = fieldText(data[f.id]);
      return f.label + "：" + (s.length > 100 ? s.slice(0, 100) + "…" : s);
    })
    .join("\n");
}

/** 内置通用 JSON 报文（未自定义请求数据模板时使用） */
function buildWebhookPayload(
  form: FormRow,
  subId: number,
  data: Record<string, unknown>
): Record<string, unknown> {
  return {
    event: "form.submitted",
    formId: form.id,
    formTitle: form.title,
    submissionId: subId,
    submittedAt: now(),
    data,
  };
}

/**
 * IP 上限检查 + 入库放在同一事务内（BEGIN IMMEDIATE 先取写锁，并发请求串行化），
 * 避免「先查后插」的竞态导致同一 IP 略超上限。
 */
function insertSubmission(
  formId: number,
  ip: string,
  limit: number,
  dataJson: string,
  ts: string
): number | null {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (limit > 0) {
      const n = (db
        .query("SELECT COUNT(*) AS n FROM submissions WHERE form_id = ? AND ip = ?")
        .get(formId, ip) as { n: number }).n;
      if (n >= limit) {
        db.exec("ROLLBACK");
        return null;
      }
    }
    const r = db
      .query("INSERT INTO submissions (form_id, ip, data, created_at) VALUES (?, ?, ?, ?)")
      .run(formId, ip, dataJson, ts);
    db.exec("COMMIT");
    return Number(r.lastInsertRowid);
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw e;
  }
}

/** 获取表单（任何状态都返回，由前端根据 status 提示；附带当前 IP 的提交情况） */
pub.get("/public/forms/:slug", (c) => {
  const row = getFormBySlug(c.req.param("slug"));
  if (!row) return c.json({ error: "表单不存在" }, 404);

  let ipCount = 0;
  let reachedLimit = false;
  if (row.ip_limit > 0) {
    ipCount = countByIp(row.id, getClientIp(c));
    reachedLimit = ipCount >= row.ip_limit;
  }

  return c.json({
    form: {
      id: row.id,
      title: row.title,
      description: row.description,
      slug: row.slug,
      status: row.status,
      fields: parseFields(row),
    },
    ipCount,
    reachedLimit,
  });
});

/** 提交表单数据（仅 published 状态；受 IP 上限与限流约束） */
pub.post(
  "/public/forms/:slug/submit",
  // 请求体总量硬上限（流式计数 + Content-Length 预检，multipart 与 JSON 均适用）
  bodyLimit({
    maxSize: MAX_UPLOAD_TOTAL,
    onError: (c) => c.json({ error: "提交内容过大，请压缩后重试" }, 413),
  }),
  async (c) => {
    const ip = getClientIp(c);
    if (!rateLimit("submit:" + ip, 10, 60_000)) {
      return c.json({ error: "提交过于频繁，请稍后再试" }, 429);
    }

    const row = getFormBySlug(c.req.param("slug"));
    if (!row) return c.json({ error: "表单不存在" }, 404);
    if (row.status !== "published") {
      return c.json({ error: "该表单当前未开放填写", code: "closed" }, 403);
    }
    // 快速失败：已超 IP 上限则不再解析请求体（省资源），最终以事务内检查为准
    if (row.ip_limit > 0 && countByIp(row.id, ip) >= row.ip_limit) {
      return c.json(
        {
          error: "该表单限制同一 IP 最多提交 " + row.ip_limit + " 次，您已达到上限",
          code: "ip_limit",
        },
        403
      );
    }

    const fields = parseFields(row);
    const hasFiles = fields.some((f) => f.type === "file");
    const errors: Record<string, string> = {};
    const data: Record<string, unknown> = {}; // 上传文件元数据
    let raw: Record<string, unknown> = {};    // 常规字段值
    let honeypot = "";
    let elapsed = 999999;
    const savedFiles: string[] = []; // 本次请求已落盘的文件，出错时统一清理

    if (hasFiles) {
      // multipart：常规字段在 "data"（JSON 字符串），文件以字段 id 为 key
      let form: Record<string, string | File>;
      try {
        form = (await c.req.parseBody()) as Record<string, string | File>;
      } catch {
        return c.json({ error: "提交格式错误" }, 400);
      }
      honeypot = String(form["_website"] ?? "");
      elapsed = Number(form["_elapsed"] ?? 999999);
      try {
        const parsed: unknown = JSON.parse(String(form["data"] ?? "{}"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          raw = parsed as Record<string, unknown>;
        }
      } catch {
        raw = {};
      }
      // 文件字段只认真实上传结果，丢弃客户端伪造的元数据（防引用/删除他人文件路径）
      for (const f of fields) {
        if (f.type === "file") delete raw[f.id];
      }
      let fileCount = 0;
      for (const f of fields) {
        if (f.type !== "file") continue;
        const file = form[f.id];
        if (!(file instanceof File) || file.size === 0) {
          if (f.required) errors[f.id] = "此项为必填项";
          continue;
        }
        fileCount++;
        if (fileCount > MAX_UPLOAD_FILES) {
          await deleteUploads(row.id, savedFiles);
          return c.json({ error: "文件数量过多（上限 " + MAX_UPLOAD_FILES + " 个）" }, 413);
        }
        const maxMB = f.maxSizeMB || 10;
        if (file.size > maxMB * 1024 * 1024) {
          errors[f.id] = "文件不能超过 " + maxMB + "MB";
          continue;
        }
        const ext = (file.name.split(".").pop() || "").toLowerCase();
        const allow = (f.accept || "").split(",").map((s) => s.trim()).filter(Boolean);
        if (allow.length && !allow.includes(ext)) {
          errors[f.id] = "不支持的文件类型";
          continue;
        }
        data[f.id] = await saveUpload(row.id, file);
        savedFiles.push((data[f.id] as { path: string }).path);
      }
    } else {
      // JSON 提交：按 Content-Length 预检（bodyLimit 已做 64MB 总量兜底，此处收紧到 1MB）
      const len = Number(c.req.header("content-length") || 0);
      if (len > MAX_JSON_BODY) {
        return c.json({ error: "提交内容过大" }, 413);
      }
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      honeypot = String(body._website ?? "");
      elapsed = Number(body._elapsed ?? 999999);
      if (body.data && typeof body.data === "object" && !Array.isArray(body.data)) {
        raw = body.data as Record<string, unknown>;
      }
    }

    // 蜜罐命中：疑似机器人，假装成功但不入库（同时清理本次已保存的文件）
    if (honeypot.trim() !== "") {
      await deleteUploads(row.id, savedFiles);
      return c.json({ ok: true, id: 0 });
    }
    // 提交过快：明确报错而非静默丢弃，避免误伤真实用户
    if (Number.isFinite(elapsed) && elapsed < 2000) {
      await deleteUploads(row.id, savedFiles);
      return c.json({ error: "提交过快，请稍候片刻再试" }, 400);
    }

    const result = validateSubmission(fields, { ...raw, ...data });
    if (!result.ok) {
      await deleteUploads(row.id, savedFiles);
      return c.json(
        { error: "提交内容有误，请检查后重试", errors: { ...result.errors, ...errors } },
        400
      );
    }
    if (Object.keys(errors).length > 0) {
      await deleteUploads(row.id, savedFiles);
      return c.json({ error: "提交内容有误，请检查后重试", errors }, 400);
    }

    const subId = insertSubmission(row.id, ip, row.ip_limit, JSON.stringify(result.data), now());
    if (subId === null) {
      await deleteUploads(row.id, savedFiles);
      return c.json(
        {
          error: "该表单限制同一 IP 最多提交 " + row.ip_limit + " 次，您已达到上限",
          code: "ip_limit",
        },
        403
      );
    }

    // Webhook 通知（表单勾选的预设，异步发送，不阻塞响应；失败仅记录日志）
    let hookIds: number[] = [];
    try {
      hookIds = JSON.parse(row.webhook_ids || "[]");
    } catch {
      hookIds = [];
    }
    if (Array.isArray(hookIds) && hookIds.length) {
      hookIds = hookIds.filter((n) => Number.isInteger(n));
      const hooks = hookIds.length
        ? (db
            .query(
              "SELECT url, method, body FROM webhooks WHERE id IN (" +
                hookIds.map(() => "?").join(",") +
                ")"
            )
            .all(...hookIds)) as { url: string; method: string; body: string }[]
        : [];
      for (const h of hooks) {
        const vars: Record<string, string> = {
          title: row.title,
          formId: String(row.id),
          slug: row.slug,
          submissionId: String(subId),
          time: now(),
          fields: fieldsText(result.data, fields),
          json: JSON.stringify(result.data),
        };
        const method = (h.method || "POST").toUpperCase();
        const url = renderTemplate(h.url, vars, MAX_WEBHOOK_URL);
        const init: {
          method: string;
          headers: Record<string, string>;
          signal: AbortSignal;
          body?: string;
        } = {
          method,
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(5000),
        };
        // 请求数据：模板非空按模板渲染，否则使用内置通用 JSON；GET 不携带 body
        if (method !== "GET") {
          init.body = (h.body || "").trim()
            ? renderTemplate(h.body, vars, MAX_WEBHOOK_BODY)
            : JSON.stringify(buildWebhookPayload(row, subId, result.data));
        }
        fetch(url, init)
          .then((resp) => {
            if (!resp.ok) console.error("[webhook] 响应异常:", resp.status);
          })
          .catch((e) => console.error("[webhook] 发送失败:", e && e.message));
      }
    }

    return c.json({ ok: true, id: subId }, 201);
  }
);

export default pub;
