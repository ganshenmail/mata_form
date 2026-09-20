/* 表单填写页 Alpine 组件（配合 views/form.ejs）：文件上传 / 蜜罐 / 草稿自动保存 */
document.addEventListener("alpine:init", () => {
  Alpine.data("filler", () => ({
    FIELDS: window.__FORM_FIELDS__ || [],
    slug: decodeURIComponent(location.pathname.replace(/^\/f\/?/, "")),
    values: {},
    errors: {},
    banner: "",
    draftNote: "",
    done: false,
    busy: false,
    honeypot: "",
    regionData: [],
    renderedAt: Date.now(),
    DRAFT_KEY: "form_draft_" + location.pathname,

    init() {
      const v = {};
      for (const f of this.FIELDS) {
        v[f.id] = f.type === "checkbox" ? [] : "";
        if (f.type === "region") {
          v[f.id + ":p"] = "";
          v[f.id + ":c"] = "";
          v[f.id + ":d"] = "";
        }
      }
      this.values = v;
      if (this.FIELDS.some((f) => f.type === "region")) {
        fetch("/api/public/regions")
          .then((r) => r.json())
          .then((j) => { this.regionData = j; })
          .catch(() => {});
      }
      this.restoreDraft();
    },

    /** 地区字段联动选项：level 1=省 2=市 3=区县 */
    regionOptions(fid, level) {
      if (level === 1) return this.regionData;
      const p = this.regionData.find((x) => x.name === this.values[fid + ":p"]);
      if (level === 2) return p ? p.children || [] : [];
      const c = p && (p.children || []).find((x) => x.name === this.values[fid + ":c"]);
      return c ? c.children || [] : [];
    },

    hasFiles() { return this.FIELDS.some((f) => f.type === "file"); },

    /** 草稿：仅保存非文件字段（文件无法持久化），800ms 防抖由表单 @input 触发 */
    saveDraft() {
      if (this.done) return;
      try {
        const v = {};
        for (const f of this.FIELDS) {
          if (f.type === "file") continue;
          v[f.id] = this.values[f.id];
          if (f.type === "region") {
            v[f.id + ":p"] = this.values[f.id + ":p"];
            v[f.id + ":c"] = this.values[f.id + ":c"];
            v[f.id + ":d"] = this.values[f.id + ":d"];
          }
        }
        localStorage.setItem(this.DRAFT_KEY, JSON.stringify({ v, t: Date.now() }));
      } catch (e) {}
    },

    restoreDraft() {
      try {
        const raw = localStorage.getItem(this.DRAFT_KEY);
        if (!raw) return;
        const d = JSON.parse(raw);
        if (!d || !d.v) return;
        let restored = false;
        for (const f of this.FIELDS) {
          if (f.type === "file") continue;
          if (d.v[f.id] !== undefined && d.v[f.id] !== "" && !(Array.isArray(d.v[f.id]) && !d.v[f.id].length)) {
            this.values[f.id] = d.v[f.id];
            restored = true;
          }
        }
        // 恢复地区字段的省市县临时选择
        for (const key of Object.keys(d.v)) {
          const m = key.match(/^(.+):(p|c|d)$/);
          if (m && d.v[key] !== "" && this.FIELDS.some((f) => f.id === m[1] && f.type === "region")) {
            this.values[key] = d.v[key];
            restored = true;
          }
        }
        if (restored) {
          // 起草时间计入提交耗时，避免恢复草稿后立即提交被误判为机器人
          this.renderedAt = typeof d.t === "number" ? d.t : Date.now();
          this.draftNote = "已恢复本地草稿";
        }
      } catch (e) {}
    },

    clearDraft() {
      try { localStorage.removeItem(this.DRAFT_KEY); } catch (e) {}
      const v = {};
      for (const f of this.FIELDS) v[f.id] = f.type === "checkbox" ? [] : "";
      this.values = v;
      this.draftNote = "";
    },

    elapsedMs() { return Date.now() - this.renderedAt; },

    /** 汇总提交数据（剔除空值与文件字段，与服务端清洗逻辑一致） */
    pick() {
      const out = {};
      for (const f of this.FIELDS) {
        if (f.type === "file") continue;
        const v = this.values[f.id];
        if (typeof v === "string") {
          const s = v.trim();
          if (s) out[f.id] = s;
        } else if (Array.isArray(v)) {
          if (v.length) out[f.id] = v;
        } else if (v !== undefined && v !== null) {
          out[f.id] = v;
        }
      }
      return out;
    },

    /** 前端预校验：必填 + 各类字段约束（与服务端规则一致） */
    clientValidate() {
      const errs = {};
      for (const f of this.FIELDS) {
        if (f.type === "file") {
          const input = document.querySelector('[data-file="' + f.id + '"]');
          const has = input && input.files && input.files.length > 0;
          if (f.required && !has) errs[f.id] = "此项为必填项";
          continue;
        }
        const v = this.values[f.id];
        const empty = v === undefined || v === null ||
          (typeof v === "string" && v.trim() === "") ||
          (Array.isArray(v) && v.length === 0);
        if (empty) {
          if (f.required) errs[f.id] = "此项为必填项";
          continue;
        }
        if (f.type === "text" || f.type === "textarea") {
          const s = String(v);
          if (f.minLength && s.length < f.minLength) errs[f.id] = "内容不能少于 " + f.minLength + " 字";
          else if (f.maxLength && s.length > f.maxLength) errs[f.id] = "内容不能超过 " + f.maxLength + " 字";
          else if (f.pattern) {
            let ok = true;
            try { ok = new RegExp(f.pattern).test(s); } catch (e) { ok = true; }
            if (!ok) errs[f.id] = "内容格式不正确";
          }
        } else if (f.type === "number") {
          const s = String(v).trim();
          if (!/^-?\d+(\.\d+)?$/.test(s)) errs[f.id] = "请输入有效的数字";
          else {
            const n = Number(s);
            if (f.min !== undefined && f.min !== "" && n < Number(f.min)) errs[f.id] = "不能小于 " + f.min;
            else if (f.max !== undefined && f.max !== "" && n > Number(f.max)) errs[f.id] = "不能大于 " + f.max;
          }
        } else if (f.type === "email") {
          const s = String(v).trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) errs[f.id] = "邮箱格式不正确";
        } else if (f.type === "phone") {
          const s = String(v).trim();
          if (!/^1[3-9]\d{9}$/.test(s)) errs[f.id] = "手机号格式不正确";
        } else if (f.type === "date") {
          if (f.min && v < f.min) errs[f.id] = "日期不能早于 " + f.min;
          else if (f.max && v > f.max) errs[f.id] = "日期不能晚于 " + f.max;
        } else if (f.type === "checkbox" && Array.isArray(v)) {
          if (f.minSelect && v.length < f.minSelect) errs[f.id] = "至少选择 " + f.minSelect + " 项";
          else if (f.maxSelect && v.length > f.maxSelect) errs[f.id] = "最多选择 " + f.maxSelect + " 项";
        }
      }
      return errs;
    },

    focusFirst() {
      const first = Object.keys(this.errors)[0];
      if (!first) return;
      const el = document.querySelector('[data-fitem="' + first + '"]');
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    },

    async submit() {
      this.errors = {};
      this.banner = "";
      // 地区字段：把临时键合并为 "省/市/区" 字符串
      for (const f of this.FIELDS) {
        if (f.type !== "region") continue;
        this.values[f.id] = [this.values[f.id + ":p"], this.values[f.id + ":c"], this.values[f.id + ":d"]]
          .filter(Boolean)
          .join("/");
      }
      const errs = this.clientValidate();
      if (Object.keys(errs).length) { this.errors = errs; this.focusFirst(); return; }
      this.busy = true;
      try {
        const url = "/api/public/forms/" + encodeURIComponent(this.slug) + "/submit";
        let res;
        if (this.hasFiles()) {
          const fd = new FormData();
          fd.append("data", JSON.stringify(this.pick()));
          fd.append("_elapsed", String(this.elapsedMs()));
          fd.append("_website", this.honeypot);
          // 兜底：form.ejs 的表单应带 id="the-form"；若缺失则退回 document 级查找，避免上传提交时因 formEl 为 null 直接抛错
          const formEl = document.getElementById("the-form") || document;
          for (const f of this.FIELDS) {
            if (f.type !== "file") continue;
            const input = formEl.querySelector('[data-file="' + f.id + '"]');
            if (input && input.files && input.files[0]) fd.append(f.id, input.files[0]);
          }
          res = await fetch(url, { method: "POST", body: fd });
        } else {
          res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data: this.pick(), _website: this.honeypot, _elapsed: this.elapsedMs() }),
          });
        }
        const json = await res.json().catch(() => ({}));
        if (res.ok) {
          try { localStorage.removeItem(this.DRAFT_KEY); } catch (e) {}
          this.done = true;
          window.scrollTo({ top: 0, behavior: "smooth" });
          return;
        }
        if (json.errors) {
          const fieldErrs = {};
          for (const [k, v] of Object.entries(json.errors)) {
            if (k !== "_") fieldErrs[k] = v;
          }
          this.errors = fieldErrs;
          this.banner = json.errors._ || json.error || "";
          this.focusFirst();
        } else {
          this.banner = json.error || "提交失败，请重试";
        }
      } catch (e) {
        this.banner = "网络错误，请重试";
      } finally {
        this.busy = false;
      }
    },

    reset() {
      const v = {};
      for (const f of this.FIELDS) v[f.id] = f.type === "checkbox" ? [] : "";
      this.values = v;
      this.errors = {};
      this.banner = "";
      this.done = false;
      window.scrollTo({ top: 0 });
    },
  }));
});
