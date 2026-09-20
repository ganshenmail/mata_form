/**
 * 上传文件存储：data/uploads/form-{表单ID}/xxx.ext
 * 下载走后台专用接口（需登录 + data:view 权限），不对外暴露静态路径
 */
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

export const UPLOADS_DIR = join(import.meta.dir, "..", "data", "uploads");

export interface SavedFile {
  name: string;
  size: number;
  path: string; // 相对 uploads 目录：form-{id}/xxx.ext
}

export async function saveUpload(formId: number, file: File): Promise<SavedFile> {
  const ext =
    (file.name.split(".").pop() || "bin").toLowerCase().slice(0, 10).replace(/[^a-z0-9]/g, "") ||
    "bin";
  const relDir = "form-" + formId;
  const rel =
    relDir + "/" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + "." + ext;
  mkdirSync(join(UPLOADS_DIR, relDir), { recursive: true });
  await Bun.write(join(UPLOADS_DIR, rel), file);
  return { name: String(file.name).slice(0, 255), size: file.size, path: rel };
}

/** 校验相对路径并换算绝对路径（防目录穿越） */
export function uploadAbsPath(formId: number, rel: string): string | null {
  const norm = String(rel).replace(/\\/g, "/");
  if (!norm.startsWith("form-" + formId + "/") || norm.includes("..")) return null;
  return join(UPLOADS_DIR, norm);
}

/** 静默删除文件 */
export async function deleteUploads(formId: number, rels: string[]): Promise<void> {
  for (const rel of rels) {
    const abs = uploadAbsPath(formId, rel);
    if (!abs) continue;
    try {
      await rm(abs, { force: true });
    } catch {}
  }
}

/** 从提交 data JSON 中收集文件相对路径 */
export function collectFilePaths(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const v of Object.values(data)) {
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      typeof (v as { path?: unknown }).path === "string"
    ) {
      out.push((v as { path: string }).path);
    }
  }
  return out;
}
