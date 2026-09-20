/**
 * 表单系统入口
 * 技术栈：Bun + Hono + bun:sqlite + EJS（服务端模板） + Alpine.js（前端交互）
 *
 * 启动：bun run dev（或 bun run src/index.ts）
 * 后台：http://localhost:3000/admin  默认密码 admin123
 */
import { Hono } from "hono";
import ejs from "ejs";
import { join } from "node:path";
import adminRoutes from "./routes/admin";
import publicRoutes from "./routes/public";
import { db, ensureDefaultAdmin, migrateFormWebhooks, type FormRow } from "./db";
import { sanitizePublicFields, type FormField } from "./fields";
import { assertSecureConfig } from "./auth";
import { getClientIp } from "./ip";

const VIEWS_DIR = join(import.meta.dir, "..", "views");
const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const ALPINE_PATH = join(
  import.meta.dir, "..", "node_modules", "alpinejs", "dist", "cdn.min.js"
);

// 生产环境安全配置校验（未设置 ADMIN_SECRET 时拒绝启动）
assertSecureConfig();
// 首次启动：创建默认超级管理员（admin / admin123，可用环境变量覆盖）
await ensureDefaultAdmin();
// 旧版按表单直填的 Webhook 地址迁移为预设
migrateFormWebhooks();

const app = new Hono();

/** EJS 渲染：模板很小，按需读取文件（便于开发期直接改模板生效） */
async function render(view: string, data: Record<string, unknown> = {}): Promise<string> {
  const tpl = await Bun.file(join(VIEWS_DIR, view)).text();
  return ejs.render(tpl, data, { filename: join(VIEWS_DIR, view), root: VIEWS_DIR });
}

// ---------- API ----------
app.route("/api", publicRoutes);
app.route("/admin", adminRoutes);

// ---------- 页面（EJS 服务端渲染） ----------
// 前台首页「表单中心」：展示已发布且勾选首页展示的表单
app.get("/", async (c) => {
  const forms = db
    .query(
      "SELECT id, title, description, slug FROM forms WHERE status = 'published' AND show_on_home = 1 ORDER BY id DESC"
    )
    .all();
  return c.html(await render("home.ejs", { forms }));
});
app.get("/admin", async (c) => c.html(await render("admin.ejs")));
app.get("/admin/login", async (c) => c.html(await render("login.ejs")));

// 填写页：服务端直出表单结构与状态（含 IP 上限判断），Alpine 负责交互
app.get("/f/:slug", async (c) => {
  const row = db.query("SELECT * FROM forms WHERE slug = ?").get(c.req.param("slug")) as
    | FormRow
    | undefined;

  if (!row) {
    return c.html(await render("form.ejs", { form: null, reachedLimit: false, fieldsJson: "[]" }));
  }

  let fields: FormField[] = [];
  try {
    const raw: unknown = JSON.parse(row.fields || "[]");
    // 清洗非法字段 id（历史脏数据），防止注入 Alpine 表达式（XSS）
    if (Array.isArray(raw)) fields = sanitizePublicFields(raw as FormField[]);
  } catch {
    fields = [];
  }

  let ipCount = 0;
  if (row.ip_limit > 0) {
    const ip = getClientIp(c);
    ipCount = (db
      .query("SELECT COUNT(*) AS n FROM submissions WHERE form_id = ? AND ip = ?")
      .get(row.id, ip) as { n: number }).n;
  }
  const reachedLimit = row.ip_limit > 0 && ipCount >= row.ip_limit;

  // 内嵌给 Alpine 的字段 JSON：转义 < 防止 </script> 提前闭合
  const fieldsJson = JSON.stringify(fields).replace(/</g, "\u003c");

  return c.html(
    await render("form.ejs", {
      form: {
        title: row.title,
        description: row.description,
        slug: row.slug,
        status: row.status,
        fields,
      },
      reachedLimit,
      fieldsJson,
    })
  );
});

// ---------- 静态资源 ----------
app.get("/app.css", () => new Response(Bun.file(join(PUBLIC_DIR, "app.css"))));
app.get("/admin-app.js", () => new Response(Bun.file(join(PUBLIC_DIR, "admin-app.js"))));
app.get("/form-app.js", () => new Response(Bun.file(join(PUBLIC_DIR, "form-app.js"))));
// Alpine.js 本地分发（来自依赖，无需外网 CDN）
app.get("/vendor/alpine.js", () => new Response(Bun.file(ALPINE_PATH)));

// ---------- 兜底 ----------
app.notFound((c) => c.text("404 Not Found", 404));
app.onError((err, c) => {
  console.error("[form-system] 未处理异常：", err);
  return c.json({ error: "服务器内部错误" }, 500);
});

const port = Number(process.env.PORT || 3000);


export default { port, fetch: app.fetch };