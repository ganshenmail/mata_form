/**
 * 角色与权限定义
 * - super  超级管理员：全部权限（含管理员管理）
 * - editor 编辑：管理表单与数据（不能删除表单、不能清空数据、不能管理管理员）
 * - viewer 观察者：只读（查看数据/统计/导出）
 */

export interface AdminUser {
  id: number;
  username: string;
  role: string;
}

export const ROLE_PERMS: Record<string, string[]> = {
  super: [
    "form:create", "form:update", "form:delete", "form:publish",
    "data:view", "data:delete", "data:clear", "data:export", "stats:view",
    "admin:manage",
  ],
  editor: [
    "form:create", "form:update", "form:publish",
    "data:view", "data:delete", "data:export", "stats:view",
  ],
  viewer: [
    "data:view", "data:export", "stats:view",
  ],
};

export const ROLE_LABELS: Record<string, string> = {
  super: "超级管理员",
  editor: "编辑",
  viewer: "观察者",
};

export const PERM_LABELS: Record<string, string> = {
  "form:create": "创建表单",
  "form:update": "编辑表单",
  "form:delete": "删除表单",
  "form:publish": "发布/关闭表单",
  "data:view": "查看数据",
  "data:delete": "删除提交数据",
  "data:clear": "清空提交数据",
  "data:export": "导出数据",
  "stats:view": "查看统计",
  "admin:manage": "管理管理员",
};

export function hasPerm(role: string, perm: string): boolean {
  return (ROLE_PERMS[role] || []).includes(perm);
}
