/**
 * 管理操作审计日志（写入 SQLite，超管可查）
 */
import { db, now } from "./db";

export function audit(username: string, action: string, target = "", detail = ""): void {
  try {
    db.query(
      "INSERT INTO audit_logs (username, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(username, action, target, detail, now());
  } catch (e) {
    console.error("[audit] 写入失败:", e);
  }
}

/** 审计日志保留条数上限（超出自动清理最旧的记录） */
const RETENTION = 2000;

export function listAudit(limit = 200) {
  // 保留上限 2000 条，超出自动清理最旧记录（id 单调递增）
  db.exec(
    `DELETE FROM audit_logs WHERE id <= (
       SELECT id FROM audit_logs ORDER BY id DESC LIMIT 1 OFFSET ${RETENTION}
     )`
  );
  return db
    .query(
      "SELECT id, username, action, target, detail, created_at FROM audit_logs ORDER BY id DESC LIMIT ?"
    )
    .all(Math.min(500, Math.max(1, limit)));
}
