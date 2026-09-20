/**
 * 字段类型定义、字段约束、字段规范化与提交数据校验
 */
import { isValidRegion } from "./region";

export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "email"
  | "phone"
  | "date"
  | "radio"
  | "checkbox"
  | "select"
  | "file"
  | "region";

export interface FieldTypeMeta {
  type: FieldType;
  label: string;
  hasOptions: boolean;
}

export const FIELD_TYPES: FieldTypeMeta[] = [
  { type: "text", label: "单行文本", hasOptions: false },
  { type: "textarea", label: "多行文本", hasOptions: false },
  { type: "number", label: "数字", hasOptions: false },
  { type: "email", label: "邮箱", hasOptions: false },
  { type: "phone", label: "手机号", hasOptions: false },
  { type: "date", label: "日期", hasOptions: false },
  { type: "radio", label: "单选", hasOptions: true },
  { type: "checkbox", label: "多选", hasOptions: true },
  { type: "select", label: "下拉选择", hasOptions: true },
  { type: "file", label: "文件上传", hasOptions: false },
  { type: "region", label: "地区（省市县）", hasOptions: false },
];

const CHOICE_TYPES = new Set<string>(["radio", "checkbox", "select"]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 中国大陆手机号：1 开头，第二位 3-9，共 11 位数字 */
const PHONE_RE = /^1[3-9]\d{9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 字段 id 允许的字符集：只含字母数字下划线连字符，可安全嵌入 HTML 属性与 Alpine 表达式 */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 数字字段严格格式：整数或小数（拒绝 0x/科学计数法等宽松解析） */
const NUMBER_RE = /^-?\d+(\.\d+)?$/;

export interface FormField {
  id: string;
  type: FieldType;
  label: string;
  placeholder?: string;
  required?: boolean;
  options?: string[];
  // ---- 字段约束（按类型生效，均可选） ----
  minLength?: number;    // text/textarea：最少字符
  maxLength?: number;    // text/textarea：最多字符
  pattern?: string;      // text/textarea：正则校验（JS 语法）
  min?: number | string; // number：最小值；date：最早日期（YYYY-MM-DD）
  max?: number | string; // number：最大值；date：最晚日期（YYYY-MM-DD）
  minSelect?: number;    // checkbox：最少勾选数
  maxSelect?: number;    // checkbox：最多勾选数
  maxSizeMB?: number;    // file：单文件大小上限（MB，1-50，默认 10）
  accept?: string;       // file：允许的扩展名，逗号分隔（如 jpg,png,pdf）
  inList?: boolean;      // 数据列表中是否显示此列（缺省显示）
  inFilter?: boolean;    // 筛选条件中是否提供此字段（缺省提供）
  inStats?: boolean;     // 统计分析中是否显示此字段（缺省显示）
}

export function isChoiceType(type: string): boolean {
  return CHOICE_TYPES.has(type);
}

function genFieldId(): string {
  return "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 解析非负整数约束，空/非法返回 undefined */
function intOrNull(x: unknown): number | undefined {
  if (x === undefined || x === null || String(x).trim() === "") return undefined;
  const n = Number(x);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** 解析数值约束，空/非法返回 undefined */
function numOrNull(x: unknown): number | undefined {
  if (x === undefined || x === null || String(x).trim() === "") return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

type NormalizeResult =
  | { ok: true; fields: FormField[] }
  | { ok: false; error: string };

/** 生成「字段 xxx」格式的校验错误 */
function fieldError(label: string, msg: string): NormalizeResult {
  return { ok: false, error: `字段「${label}」${msg}` };
}

/**
 * 规范化字段定义：
 * - 校验类型 / 标题 / 选项 / 约束的合法性（不合法直接拒绝保存）
 * - 只保留当前类型支持的键（自动清洗切换类型后残留的约束）
 * - 补全字段 id 并保证 id 唯一
 */
export function normalizeFields(raw: unknown): NormalizeResult {
  if (raw === undefined || raw === null) return { ok: true, fields: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "fields 必须是数组" };
  if (raw.length > 50) return { ok: false, error: "字段数量不能超过 50 个" };

  const fields: FormField[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "字段格式错误" };
    }
    const it = item as Record<string, unknown>;
    const type = String(it.type ?? "");
    if (!FIELD_TYPES.some((t) => t.type === type)) {
      return { ok: false, error: `不支持的字段类型：${type || "(空)"}` };
    }
    const label = String(it.label ?? "").trim();
    if (!label) return { ok: false, error: "存在未命名的字段，请填写字段标题" };
    if (label.length > 100) {
      return { ok: false, error: `字段标题过长：${label.slice(0, 20)}…` };
    }

    const field: FormField = {
      // id 只接受安全字符集，非法 id（含引号等可能注入 Alpine 表达式）一律重新生成
      id: typeof it.id === "string" && SAFE_ID_RE.test(it.id) ? it.id : genFieldId(),
      type: type as FieldType,
      label,
      required: it.required === true,
    };

    if (!CHOICE_TYPES.has(type)) {
      const placeholder = String(it.placeholder ?? "").trim();
      if (placeholder) field.placeholder = placeholder.slice(0, 200);
    } else {
      const options = Array.isArray(it.options)
        ? it.options.map((o) => String(o).trim()).filter(Boolean)
        : [];
      if (options.length < 1) {
        return fieldError(label, "至少需要 1 个选项");
      }
      field.options = options.slice(0, 100).map((o) => o.slice(0, 200));
    }

    // ---------- 字段约束（按类型校验并清洗） ----------
    if (type === "text" || type === "textarea") {
      const cap = type === "text" ? 500 : 2000;
      const minLength = intOrNull(it.minLength);
      const maxLength = intOrNull(it.maxLength);
      if (minLength !== undefined && minLength >= 1) {
        if (minLength > cap) return fieldError(label, `最少字符不能超过 ${cap}`);
        field.minLength = minLength;
      }
      if (maxLength !== undefined && maxLength >= 1) {
        field.maxLength = Math.min(maxLength, cap);
      }
      if (
        field.minLength !== undefined &&
        field.maxLength !== undefined &&
        field.minLength > field.maxLength
      ) {
        return fieldError(label, "最少字符不能大于最多字符");
      }
      const pattern = String(it.pattern ?? "").trim();
      if (pattern) {
        if (pattern.length > 200) return fieldError(label, "正则表达式过长");
        try {
          new RegExp(pattern);
        } catch {
          return fieldError(label, "正则表达式无效");
        }
        field.pattern = pattern;
      }
    } else if (type === "number") {
      const min = numOrNull(it.min);
      const max = numOrNull(it.max);
      if (min !== undefined) field.min = min;
      if (max !== undefined) field.max = max;
      if (min !== undefined && max !== undefined && min > max) {
        return fieldError(label, "最小值不能大于最大值");
      }
    } else if (type === "date") {
      const dmin = String(it.min ?? "").trim();
      const dmax = String(it.max ?? "").trim();
      if (dmin) {
        if (!DATE_RE.test(dmin)) return fieldError(label, "最早日期格式应为 YYYY-MM-DD");
        field.min = dmin;
      }
      if (dmax) {
        if (!DATE_RE.test(dmax)) return fieldError(label, "最晚日期格式应为 YYYY-MM-DD");
        field.max = dmax;
      }
      if (dmin && dmax && dmin > dmax) {
        return fieldError(label, "最早日期不能晚于最晚日期");
      }
    } else if (type === "checkbox") {
      const minSelect = intOrNull(it.minSelect);
      const maxSelect = intOrNull(it.maxSelect);
      const optCount = field.options!.length;
      if (minSelect !== undefined && minSelect >= 1) {
        if (minSelect > optCount) return fieldError(label, "最少选择数不能超过选项数");
        field.minSelect = minSelect;
      }
      if (maxSelect !== undefined && maxSelect >= 1) {
        if (maxSelect > optCount) return fieldError(label, "最多选择数不能超过选项数");
        field.maxSelect = maxSelect;
      }
      if (
        field.minSelect !== undefined &&
        field.maxSelect !== undefined &&
        field.minSelect > field.maxSelect
      ) {
        return fieldError(label, "最少选择数不能大于最多选择数");
      }
    } else if (type === "file") {
      const maxSizeMB = intOrNull(it.maxSizeMB);
      field.maxSizeMB = maxSizeMB !== undefined && maxSizeMB >= 1 ? Math.min(maxSizeMB, 50) : 10;
      const accept = String(it.accept ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9,]/g, "");
      if (accept) field.accept = accept.slice(0, 200);
    }

    // 数据列表 / 筛选条件显示开关（缺省为显示，旧数据自动兼容）
    field.inList = it.inList === false ? false : true;
    field.inFilter = it.inFilter === false ? false : true;
    field.inStats = it.inStats === false ? false : true;

    fields.push(field);
  }

  // 保证字段 id 唯一
  const seen = new Set<string>();
  for (const f of fields) {
    while (seen.has(f.id)) f.id = genFieldId();
    seen.add(f.id);
  }
  return { ok: true, fields };
}

/**
 * 公开侧字段 id 清洗（防御性，针对历史库中可能存在的非法 id）：
 * - 非法 id（含引号等字符，可被注入 Alpine 表达式造成 XSS）替换为安全 id；
 * - 替换是确定性的（按位置生成），保证「模板渲染」与「提交校验」两次调用得到同一套 id；
 * - 替换结果保证唯一。
 */
export function sanitizePublicFields(fields: FormField[]): FormField[] {
  const used = new Set<string>();
  return fields.map((f, i) => {
    let id = typeof f.id === "string" && SAFE_ID_RE.test(f.id) ? f.id : "";
    if (!id) {
      id = "f" + i;
      while (used.has(id)) id = "f" + i + "_" + used.size;
    }
    while (used.has(id)) id = id + "_" + i;
    used.add(id);
    return { ...f, id };
  });
}

// ---------- 提交数据校验 ----------

export type ValidateResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> };

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** 正则匹配（防御性兜底：非法正则视为通过，规范化阶段已拦截） */
function matchPattern(pattern: string, s: string): boolean {
  try {
    return new RegExp(pattern).test(s);
  } catch {
    return true;
  }
}

/** 按字段定义（含约束）校验提交数据，返回清洗后的数据（丢弃未定义字段的值） */
export function validateSubmission(
  fields: FormField[],
  input: unknown
): ValidateResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: { _: "提交数据格式错误" } };
  }
  const data = input as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  for (const f of fields) {
    const v = data[f.id];
    if (isEmpty(v)) {
      if (f.required) errors[f.id] = "此项为必填项";
      continue;
    }
    switch (f.type) {
      case "text":
      case "textarea": {
        const s = String(v).trim();
        const cap = f.type === "text" ? 500 : 2000;
        if (s.length > cap) errors[f.id] = `内容不能超过 ${cap} 字`;
        else if (f.minLength !== undefined && s.length < f.minLength) {
          errors[f.id] = `内容不能少于 ${f.minLength} 字`;
        } else if (f.maxLength !== undefined && s.length > f.maxLength) {
          errors[f.id] = `内容不能超过 ${f.maxLength} 字`;
        } else if (f.pattern !== undefined && !matchPattern(f.pattern, s)) {
          errors[f.id] = "内容格式不正确";
        } else {
          clean[f.id] = s;
        }
        break;
      }
      case "number": {
        const s = String(v).trim();
        if (!NUMBER_RE.test(s)) {
          errors[f.id] = "请输入有效的数字";
        } else {
          const n = Number(s);
          if (f.min !== undefined && n < (f.min as number)) {
            errors[f.id] = `不能小于 ${f.min}`;
          } else if (f.max !== undefined && n > (f.max as number)) {
            errors[f.id] = `不能大于 ${f.max}`;
          } else {
            clean[f.id] = n;
          }
        }
        break;
      }
      case "email": {
        const s = String(v).trim();
        if (!EMAIL_RE.test(s) || s.length > 200) errors[f.id] = "邮箱格式不正确";
        else clean[f.id] = s;
        break;
      }
      case "phone": {
        const s = String(v).trim();
        if (s.length > 20 || !PHONE_RE.test(s)) errors[f.id] = "手机号格式不正确";
        else clean[f.id] = s;
        break;
      }
      case "date": {
        const s = String(v).trim();
        if (!DATE_RE.test(s)) errors[f.id] = "日期格式不正确";
        else if (typeof f.min === "string" && s < f.min) {
          errors[f.id] = `日期不能早于 ${f.min}`;
        } else if (typeof f.max === "string" && s > f.max) {
          errors[f.id] = `日期不能晚于 ${f.max}`;
        } else {
          clean[f.id] = s;
        }
        break;
      }
      case "radio":
      case "select": {
        const s = String(v).trim();
        if (!f.options!.includes(s)) errors[f.id] = "所选选项无效";
        else clean[f.id] = s;
        break;
      }
      case "file": {
        // 上传文件在提交接口已处理，这里校验并透传文件元数据
        if (!v || typeof v !== "object" || Array.isArray(v)) {
          errors[f.id] = "文件无效";
          break;
        }
        const o = v as Record<string, unknown>;
        clean[f.id] = {
          name: String(o.name ?? "").slice(0, 255),
          size: Number(o.size) || 0,
          path: String(o.path ?? ""),
        };
        break;
      }
      case "region": {
        const s = String(v).trim().slice(0, 100);
        if (!isValidRegion(s)) errors[f.id] = "请选择有效的地区";
        else clean[f.id] = s;
        break;
      }
      case "checkbox": {
        const arr = (Array.isArray(v) ? v : [v]).map((x) => String(x).trim());
        if (arr.some((x) => !f.options!.includes(x))) {
          errors[f.id] = "所选选项无效";
        } else {
          const uniq = [...new Set(arr)];
          if (f.minSelect !== undefined && uniq.length < f.minSelect) {
            errors[f.id] = `至少选择 ${f.minSelect} 项`;
          } else if (f.maxSelect !== undefined && uniq.length > f.maxSelect) {
            errors[f.id] = `最多选择 ${f.maxSelect} 项`;
          } else {
            clean[f.id] = uniq;
          }
        }
        break;
      }
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, data };
}
