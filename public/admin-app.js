/* 表单管理系统 · 后台 Alpine 组件（配合 views/admin.ejs） */
document.addEventListener("alpine:init", () => {
  // 表单模板库（新建空表单时可一键套用）
  const TEMPLATES = {
    signup: { name: "活动报名", fields: [
      { type: "text", label: "姓名", required: true },
      { type: "text", label: "手机号", required: true, pattern: "^1[0-9]{10}$", placeholder: "11 位手机号" },
      { type: "select", label: "参加场次", required: true, options: ["上午场", "下午场", "全天"] },
      { type: "number", label: "随行人数", min: 0, max: 10 },
      { type: "textarea", label: "备注", placeholder: "选填" },
    ] },
    survey: { name: "满意度调查", fields: [
      { type: "radio", label: "总体满意度", required: true, options: ["非常满意", "满意", "一般", "不满意"] },
      { type: "number", label: "评分（1-10）", required: true, min: 1, max: 10 },
      { type: "checkbox", label: "希望通过哪些渠道接收活动信息", options: ["微信公众号", "邮件", "短信", "朋友推荐"] },
      { type: "textarea", label: "意见与建议" },
    ] },
    register: { name: "信息登记", fields: [
      { type: "text", label: "姓名", required: true },
      { type: "radio", label: "性别", options: ["男", "女"] },
      { type: "date", label: "出生日期" },
      { type: "text", label: "联系电话", required: true, pattern: "^1[0-9]{10}$" },
      { type: "email", label: "邮箱" },
    ] },
    feedback: { name: "反馈收集", fields: [
      { type: "select", label: "反馈类别", required: true, options: ["功能建议", "问题反馈", "其他"] },
      { type: "text", label: "标题", required: true },
      { type: "textarea", label: "详细描述", required: true },
      { type: "file", label: "附件", maxSizeMB: 10, accept: "jpg,png,pdf,zip" },
    ] },
  };

  Alpine.data("admin", () => ({
    // ---------- 路由与通用 ----------
    view: "list",
    id: null,
    loading: true,
    loadError: "",
    toast: { show: false, text: "", type: "ok" },
    modal: null,
    me: null,
    csrf: "",

    // 列表
    forms: [],
    // 编辑
    editing: null,
    saving: false,
    newFieldType: "text",
    // 数据
    d: { formId: null, page: 1, q: "", from: "", to: "", filters: {}, showFilters: false, fields: [], rows: [], total: 0, pages: 1, form: null },
    exportHref: "#",
    exportXlsxHref: "#",
    // 统计
    s: null,
    sform: null,
    statsRange: { days: 14, from: "", to: "" },
    // 管理员管理
    admins: [],
    newAdmin: { username: "", password: "", role: "viewer" },
    // 二维码 / 审计 / 改密码
    qr: null,
    auditLogs: [],
    pwd: { open: false, old: "", n1: "", n2: "" },
    // Webhook 管理
    webhooks: [],
    webhookPresets: [],
    whForm: { id: null, name: "", url: "", method: "POST", body: "" },

    async init() {
      window.addEventListener("hashchange", () => this.route());
      await this.fetchMe();
      await this.route();
    },
    async fetchMe() {
      const res = await this.api("/admin/api/me");
      this.me = res.me;
      this.csrf = res.csrf || "";
    },
    /** 当前账号是否拥有某权限 */
    has(p) { return !!this.me && (this.me.perms || []).includes(p); },
    roleText(r) { return { super: "超级管理员", editor: "编辑", viewer: "观察者" }[r] || r; },

    nav(hash) { location.hash = hash; },
    goHome() { this.editing = null; this.nav("/"); },
    async route() {
      this.modal = null;
      this.loadError = "";
      this.loading = true;
      const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
      try {
        if (parts[0] === "edit") {
          this.view = "edit";
          this.id = parts[1] ? Number(parts[1]) : null;
          await this.loadEdit();
        } else if (parts[0] === "data") {
          this.view = "data";
          this.id = Number(parts[1]) || 0;
          await this.loadData();
        } else if (parts[0] === "stats") {
          this.view = "stats";
          this.id = Number(parts[1]) || 0;
          await this.loadStats();
        } else if (parts[0] === "admins") {
          this.view = "admins";
          await this.loadAdmins();
        } else if (parts[0] === "audit") {
          this.view = "audit";
          await this.loadAudit();
        } else if (parts[0] === "webhooks") {
          this.view = "webhooks";
          await this.loadWebhooks();
        } else {
          this.view = "list";
          this.id = null;
          await this.loadList();
        }
      } catch (e) {
        if (e && e.message === "未登录") return;
        this.loadError = e && e.message ? e.message : String(e);
      } finally {
        this.loading = false;
      }
    },

    async api(path, opts = {}) {
      const init = { method: opts.method || "GET", headers: {} };
      if (opts.body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(opts.body);
      }
      // 写请求附带 CSRF 令牌（与 httpOnly Cookie 配对，防跨站请求伪造）
      const m = init.method.toUpperCase();
      if (m !== "GET" && m !== "HEAD" && this.csrf) {
        init.headers["X-CSRF-Token"] = this.csrf;
      }
      const res = await fetch(path, init);
      if (res.status === 401 && !path.includes("/api/login")) {
        location.href = "/admin/login";
        throw new Error("未登录");
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "请求失败（HTTP " + res.status + "）");
      return json;
    },

    say(text, type) {
      this.toast = { show: true, text, type: type || "ok" };
      clearTimeout(this._t);
      this._t = setTimeout(() => { this.toast.show = false; }, 2400);
    },

    fmtTime(iso) {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso ?? "");
      const p = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
        " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    },
    stText(s) { return { draft: "草稿", published: "收集中", closed: "已关闭" }[s] || s; },
    stCls(s) { return { draft: "st-draft", published: "st-published", closed: "st-closed" }[s] || "st-draft"; },
    isChoice(t) { return ["radio", "checkbox", "select"].includes(t); },
    isTextLike(t) { return ["text", "textarea", "number", "email", "phone"].includes(t); },
    typeLabel(t) {
      return { text: "单行文本", textarea: "多行文本", number: "数字", email: "邮箱", phone: "手机号", date: "日期", radio: "单选", checkbox: "多选", select: "下拉选择" }[t] || t;
    },
    round2(n) { return Math.round(n * 100) / 100; },

    get pageTitle() {
      if (this.view === "edit") return this.editing && this.editing.id ? "编辑表单" : "新建表单";
      if (this.view === "data") return (this.d.form ? this.d.form.title : "") + " · 提交数据（" + this.d.total + "）";
      if (this.view === "stats") return (this.sform ? this.sform.title : "") + " · 统计分析";
      if (this.view === "admins") return "管理员管理";
      if (this.view === "webhooks") return "Webhook 管理";
      if (this.view === "audit") return "审计日志";
      return "表单管理";
    },

    // ---------- 视图：表单列表 ----------
    async loadList() {
      this.forms = (await this.api("/admin/api/forms")).forms;
    },
    createNew() {
      this.editing = { id: null, title: "", description: "", status: "draft", ipLimit: 0, showOnHome: true, webhookIds: [], slug: "", fields: [] };
      this.nav("/edit");
    },
    editForm(id) { this.editing = null; this.nav("/edit/" + id); },
    openData(id) { this.nav("/data/" + id); },
    openStats(id) { this.nav("/stats/" + id); },
    async toggleStatus(f) {
      try {
        const to = f.status === "published" ? "closed" : "published";
        await this.api("/admin/api/forms/" + f.id + "/status", { method: "PATCH", body: { status: to } });
        this.say(to === "published" ? "已发布，开始收集" : "已关闭收集");
        this.loadList();
      } catch (e) { this.say(e.message, "err"); }
    },
    async toggleHome(f) {
      try {
        const show = !f.show_on_home;
        await this.api("/admin/api/forms/" + f.id + "/show", { method: "PATCH", body: { show } });
        this.say(show ? "已在首页展示" : "已从首页隐藏");
        this.loadList();
      } catch (e) { this.say(e.message, "err"); }
    },
    async delForm(f) {
      if (!confirm("确定删除表单「" + f.title + "」吗？\n其所有提交数据将一并删除，且不可恢复！")) return;
      try {
        await this.api("/admin/api/forms/" + f.id, { method: "DELETE" });
        this.say("已删除");
        this.loadList();
      } catch (e) { this.say(e.message, "err"); }
    },
    async logout() {
      try { await this.api("/admin/api/logout", { method: "POST" }); } catch (e) {}
      location.href = "/admin/login";
    },

    // ---------- 管理员管理 ----------
    async loadAdmins() {
      if (!this.has("admin:manage")) throw new Error("没有管理管理员的权限");
      this.admins = (await this.api("/admin/api/admins")).admins;
    },
    openAdmins() { this.nav("/admins"); },
    async addAdmin() {
      const n = this.newAdmin;
      if (!n.username.trim()) return this.say("请填写用户名", "err");
      if ((n.password || "").length < 6) return this.say("密码至少 6 位", "err");
      try {
        await this.api("/admin/api/admins", {
          method: "POST",
          body: { username: n.username.trim(), password: n.password, role: n.role },
        });
        this.say("已添加");
        this.newAdmin = { username: "", password: "", role: "viewer" };
        this.loadAdmins();
      } catch (e) { this.say(e.message, "err"); }
    },
    async changeRole(a, role) {
      if (role === a.role) return;
      try {
        await this.api("/admin/api/admins/" + a.id, { method: "PUT", body: { role } });
        this.say("角色已更新");
        this.loadAdmins();
      } catch (e) { this.say(e.message, "err"); this.loadAdmins(); }
    },
    async resetPwd(a) {
      const pw = prompt("为「" + a.username + "」设置新密码（至少 6 位）：");
      if (pw === null) return;
      if (pw.length < 6) return this.say("密码至少 6 位", "err");
      try {
        await this.api("/admin/api/admins/" + a.id, { method: "PUT", body: { password: pw } });
        this.say("密码已重置");
      } catch (e) { this.say(e.message, "err"); }
    },
    async delAdmin(a) {
      if (!confirm("确定删除管理员「" + a.username + "」吗？")) return;
      try {
        await this.api("/admin/api/admins/" + a.id, { method: "DELETE" });
        this.say("已删除");
        this.loadAdmins();
      } catch (e) { this.say(e.message, "err"); }
    },

    // ---------- 二维码 / 克隆 ----------
    openQr(f) { this.qr = f; },
    async cloneForm(f) {
      try {
        const { form } = await this.api("/admin/api/forms/" + f.id + "/clone", { method: "POST" });
        this.say("已克隆为草稿副本：" + form.title);
        this.loadList();
      } catch (e) { this.say(e.message, "err"); }
    },

    // ---------- Webhook 管理 ----------
    async loadWebhooks() {
      if (!this.has("admin:manage")) throw new Error("没有管理 Webhook 的权限");
      this.webhooks = (await this.api("/admin/api/webhooks")).webhooks;
    },
    openWebhooks() { this.nav("/webhooks"); },
    cancelWhEdit() { this.whForm = { id: null, name: "", url: "", method: "POST", body: "" }; },
    async saveWebhook() {
      const w = this.whForm;
      if (!w.name.trim()) return this.say("请填写名称", "err");
      if (!/^https?:\/\//.test(w.url.trim())) return this.say("地址需以 http(s):// 开头", "err");
      if (w.method === "GET" && w.body.trim() !== "") return this.say("GET 请求不支持请求数据", "err");
      if (w.body.trim() !== "" && !w.body.includes("{{")) {
        try { JSON.parse(w.body); } catch (e) { return this.say("请求数据不是合法的 JSON", "err"); }
      }
      try {
        const payload = { name: w.name.trim(), url: w.url.trim(), method: w.method, body: w.body };
        if (w.id) {
          await this.api("/admin/api/webhooks/" + w.id, { method: "PUT", body: payload });
          this.say("已保存修改");
        } else {
          await this.api("/admin/api/webhooks", { method: "POST", body: payload });
          this.say("已添加");
        }
        this.cancelWhEdit();
        this.loadWebhooks();
      } catch (e) { this.say(e.message, "err"); }
    },
    editWebhook(w) { this.whForm = { id: w.id, name: w.name, url: w.url, method: w.method || "POST", body: w.body || "" }; },
    async delWebhook(w) {
      if (!confirm("确定删除 Webhook「" + w.name + "」吗？所有引用它的表单将自动解除关联。")) return;
      try {
        await this.api("/admin/api/webhooks/" + w.id, { method: "DELETE" });
        this.say("已删除");
        this.loadWebhooks();
      } catch (e) { this.say(e.message, "err"); }
    },

    // ---------- 审计日志 ----------
    openAudit() { this.nav("/audit"); },
    async loadAudit() {
      if (!this.has("admin:manage")) throw new Error("没有查看审计日志的权限");
      this.auditLogs = (await this.api("/admin/api/audit")).logs;
    },
    actionLabel(a) {
      return {
        "form.create": "创建表单", "form.update": "编辑表单", "form.delete": "删除表单",
        "form.publish": "发布/关闭", "form.show": "首页展示", "form.clone": "克隆表单",
        "data.delete": "删除提交", "data.clear": "清空数据",
        "admin.create": "添加管理员", "admin.update": "更新管理员", "admin.delete": "删除管理员",
        "password.change": "修改密码", login: "登录",
      }[a] || a;
    },

    // ---------- 修改密码 ----------
    async submitPwd() {
      if (!this.pwd.old) return this.say("请输入旧密码", "err");
      if (this.pwd.n1.length < 6) return this.say("新密码至少 6 位", "err");
      if (this.pwd.n1 !== this.pwd.n2) return this.say("两次输入的新密码不一致", "err");
      try {
        await this.api("/admin/api/me/password", {
          method: "POST",
          body: { oldPassword: this.pwd.old, newPassword: this.pwd.n1 },
        });
        this.say("密码已修改");
        this.pwd = { open: false, old: "", n1: "", n2: "" };
      } catch (e) { this.say(e.message, "err"); }
    },

    // ---------- 模板库 ----------
    applyTemplate(key) {
      const t = TEMPLATES[key];
      if (!t) return;
      this.editing.fields = t.fields.map((f, i) => ({
        inList: true,
        inFilter: true,
        inStats: true,
        ...f,
        id: this.genFieldId() + i,
      }));
      this.say("已套用模板：" + t.name);
    },

    // ---------- 视图：表单编辑 ----------
    async loadEdit() {
      const whRes = await this.api("/admin/api/webhooks");
      this.webhookPresets = whRes.webhooks;
      if (this.id) {
        if (!this.editing || this.editing.id !== this.id) {
          this.editing = (await this.api("/admin/api/forms/" + this.id)).form;
        }
      } else if (!this.editing) {
        this.editing = { id: null, title: "", description: "", status: "draft", ipLimit: 0, showOnHome: true, webhookIds: [], slug: "", fields: [] };
      }
      // 显示开关缺省值（旧数据无此键 = 显示）
      this.editing.fields = (this.editing.fields || []).map((f) => ({ inList: true, inFilter: true, inStats: true, ...f }));
    },
    genFieldId() { return "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); },
    addField() {
      const f = { id: this.genFieldId(), type: this.newFieldType, label: "", required: false, inList: true, inFilter: true, inStats: true };
      if (this.isChoice(this.newFieldType)) f.options = ["选项1", "选项2"];
      this.editing.fields.push(f);
    },
    delField(i) { this.editing.fields.splice(i, 1); },
    moveField(i, dir) {
      const a = this.editing.fields;
      const j = i + dir;
      if (j < 0 || j >= a.length) return;
      [a[i], a[j]] = [a[j], a[i]];
    },
    clearCons(f) {
      ["minLength", "maxLength", "pattern", "min", "max", "minSelect", "maxSelect", "placeholder"].forEach((k) => delete f[k]);
    },
    changeType(f, v) {
      if (f.type === v) return;
      f.type = v;
      this.clearCons(f);
      if (this.isChoice(v) && !(Array.isArray(f.options) && f.options.length)) f.options = ["选项1", "选项2"];
    },
    async save() {
      const e = this.editing;
      if (!e) return;
      if (!String(e.title || "").trim()) return this.say("请填写表单标题", "err");
      if (!e.fields.length) return this.say("请至少添加一个字段", "err");
      if (e.fields.some((f) => !String(f.label || "").trim())) return this.say("存在未命名的字段，请补全字段标题", "err");
      this.saving = true;
      try {
        const body = {
          title: String(e.title).trim(),
          description: String(e.description || "").trim(),
          fields: e.fields,
          status: e.status,
          ipLimit: e.ipLimit,
          showOnHome: !!e.showOnHome,
          webhookIds: Array.isArray(e.webhookIds) ? e.webhookIds : [],
        };
        const { form } = e.id
          ? await this.api("/admin/api/forms/" + e.id, { method: "PUT", body })
          : await this.api("/admin/api/forms", { method: "POST", body });
        this.editing = null;
        this.say("保存成功");
        this.nav("/"); // 保存后返回表单列表
      } catch (err) {
        this.say(err.message, "err");
      } finally {
        this.saving = false;
      }
    },
    copyLink() {
      const url = location.origin + "/f/" + this.editing.slug;
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
        .then(() => this.say("链接已复制"))
        .catch(() => prompt("请手动复制：", url));
    },

    // ---------- 视图：提交数据 ----------
    get fltActive() {
      const o = {};
      for (const [k, v] of Object.entries(this.d.filters || {})) {
        if (v !== "" && v !== undefined && v !== null) o[k] = v;
      }
      return o;
    },
    get fltCount() { return Object.keys(this.fltActive).length; },
    /** 数据列表列 = 勾选了「列表」的字段 */
    get listFields() { return (this.d.fields || []).filter((f) => f.inList !== false); },
    /** 筛选条件 = 勾选了「筛选」的字段 */
    get filterFields() { return (this.d.fields || []).filter((f) => f.inFilter !== false); },
    /** 统计分析 = 勾选了「统计」的字段 */
    get statFields() { return (this.s ? this.s.fields : []).filter((f) => f.inStats !== false); },
    subParams(withPage) {
      const p = new URLSearchParams();
      if (withPage) { p.set("page", String(this.d.page)); p.set("size", "20"); }
      if (this.d.q) p.set("q", this.d.q);
      if (this.d.from) p.set("from", this.d.from);
      if (this.d.to) p.set("to", this.d.to);
      const filters = this.fltActive;
      if (Object.keys(filters).length) p.set("filters", JSON.stringify(filters));
      return p;
    },
    async loadData() {
      if (this.d.formId !== this.id) {
        this.d = { formId: this.id, page: 1, q: "", filters: {}, showFilters: false, fields: [], rows: [], total: 0, pages: 1, form: null };
      }
      const [formRes, listRes] = await Promise.all([
        this.api("/admin/api/forms/" + this.id),
        this.api("/admin/api/forms/" + this.id + "/submissions?" + this.subParams(true).toString()),
      ]);
      this.d.form = formRes.form;
      this.d.fields = formRes.form.fields;
      this.d.rows = listRes.rows;
      this.d.total = listRes.total;
      this.d.pages = Math.max(1, Math.ceil(listRes.total / listRes.size));
      const ep = this.subParams(false);
      const base = "/admin/api/forms/" + this.id + "/submissions/export";
      const qs = ep.toString();
      this.exportHref = base + (qs ? "?" + qs : "");
      // Excel 链接始终带 ?format=xlsx（不能直接往 exportHref 拼 &，无筛选参数时会生成非法地址）
      this.exportXlsxHref = base + "?" + (qs ? qs + "&" : "") + "format=xlsx";
    },
    doSearch() { this.d.page = 1; this.loadData(); },
    applyFilters() { this.d.page = 1; this.loadData(); },
    resetFilters() { this.d.filters = {}; this.d.from = ""; this.d.to = ""; this.d.page = 1; this.loadData(); },
    cellText(r, f) {
      const v = r.data[f.id];
      if (v && typeof v === "object" && !Array.isArray(v)) return String(v.name ?? "");
      return Array.isArray(v) ? v.join("、") : String(v ?? "");
    },
    showDetail(r) {
      this.modal = {
        id: r.id,
        ip: r.ip,
        created_at: r.created_at,
        rows: this.d.fields.map((f) => {
          const v = r.data[f.id];
          const isFile = v && typeof v === "object" && !Array.isArray(v) && v.path;
          return {
            key: f.label,
            val: this.cellText(r, f),
            href: isFile ? "/admin/api/forms/" + this.d.formId + "/submissions/" + r.id + "/files/" + f.id : "",
          };
        }),
      };
    },
    async delRow(id) {
      if (!confirm("确定删除提交 #" + id + " 吗？")) return;
      try {
        await this.api("/admin/api/submissions/" + id, { method: "DELETE" });
        this.say("已删除");
        this.loadData();
      } catch (e) { this.say(e.message, "err"); }
    },
    async clearData() {
      if (!confirm("确定清空该表单的全部提交数据吗？此操作不可恢复！")) return;
      try {
        await this.api("/admin/api/forms/" + this.id + "/submissions", { method: "DELETE" });
        this.say("已清空");
        this.d.page = 1;
        this.loadData();
      } catch (e) { this.say(e.message, "err"); }
    },

    // ---------- 视图：统计分析 ----------
    async loadStats() {
      const r = this.statsRange;
      let qs = "days=" + (r.days || 14);
      if (r.from && r.to && r.from <= r.to) qs = "from=" + r.from + "&to=" + r.to;
      const [formRes, stats] = await Promise.all([
        this.api("/admin/api/forms/" + this.id),
        this.api("/admin/api/forms/" + this.id + "/stats?" + qs),
      ]);
      this.sform = formRes.form;
      this.s = stats;
    },
    setStatsDays(n) { this.statsRange = { days: n, from: "", to: "" }; this.loadStats(); },
    applyStatsRange() { this.loadStats(); },
    get sMax() { return this.s ? Math.max(1, ...this.s.trend.map((t) => t.count)) : 1; },
    optW(f, o) {
      if (!f.options || !f.options.length) return 0;
      const max = Math.max(1, ...f.options.map((x) => x.count));
      return Math.round((o.count / max) * 100);
    },
  }));
});
