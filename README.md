# 表单系统

基于 **Bun + Hono + SQLite（bun:sqlite）+ EJS + Alpine.js** 的轻量表单系统：后台创建与管理表单，公开页面填写收集，后台查看数据与统计。页面由 EJS 服务端模板渲染，Alpine.js 负责前端交互，全程无构建步骤；Alpine.js 来自本地依赖（`/vendor/alpine.js`），不依赖外网 CDN。

## 功能

### 后台管理（多管理员登录）
- **表单管理**：创建 / 编辑 / 删除 / **克隆**表单，一键发布、关闭收集，支持**表单模板库**（活动报名 / 满意度调查 / 信息登记 / 反馈收集一键套用）
- **字段设计器**：支持 11 种字段类型 —— 单行文本、多行文本、数字、邮箱、**手机号**、日期、单选、多选、下拉选择、**文件上传**、**地区（省市县联动，内置区划数据）**；可配置标题、提示文字、是否必填、选项，支持排序与删除；支持字段约束（字符数、正则、数值/日期范围、多选数量限制、文件大小与类型），前后端双重校验
- **数据查看**：分页列表（动态列）、关键词搜索、**按字段筛选** + **提交时间范围**筛选、单条详情弹窗（含文件下载）、删除单条、清空全部
- **字段显示开关**：每个字段可单独设置是否出现在「数据列表」「筛选条件」「统计分析」中（缺省全部显示，详情/导出/Webhook 始终包含全部字段）
- **统计分析**：总提交 / 今日 / 近 7 天 / 独立 IP 概览，**时间范围可切换（近 7/14/30 天或自定义起止）**，趋势图、选项分布占比、数字均值最值、文本高频值、各字段填写率
- **导出**：CSV（带 BOM）与 **Excel(xlsx)**，同步携带当前的搜索、字段筛选与时间范围
- **Webhook 管理**：专门的管理页可预设多个 Webhook，支持自定义**请求方式**（GET / POST / PUT）与**请求数据模板**（占位符 `{{title}}` `{{formId}}` `{{submissionId}}` `{{time}}` `{{fields}}` `{{json}}`，地址同样支持占位符；留空使用内置通用 JSON 报文），表单设置里勾选启用（可多选），删除预设自动解除引用
- **填写链接二维码**：后台一键生成填写页二维码（SVG，无外部服务）
- **IP 限制**：可设置「同一 IP 提交上限」（0 = 不限制），达到上限的 IP 无法再次提交
- **前台首页**：`/` 为「表单中心」，卡片式列出已发布且勾选首页展示的表单
- **多管理员与权限**：三种角色 —— 超级管理员 / 编辑 / 观察者，接口级权限校验，角色修改即时生效；**审计日志**记录全部管理操作（仅超管可查）
- **登录验证码**：SVG 图形验证码，5 分钟有效、一次性使用
- **安全加固**：登录失败锁定（同 IP+用户名 连续失败 5 次锁 15 分钟）、登录/验证码/提交接口限流、公开提交**蜜罐字段 + 耗时检查**、自改密码需验旧密码

### 公开填写页 /f/:slug
- 服务端渲染字段结构，必填项与约束前后端双重校验
- **文件上传字段**（大小 / 类型限制，附件在后台详情中下载）
- **草稿自动保存**（localStorage，刷新不丢，可一键清空）
- 蜜罐字段 + 提交耗时检查，机器人提交被静默丢弃
- 草稿 / 已关闭 / 达到 IP 上限状态自动显示提示，仅发布状态可提交

### 数据存储
- SQLite 单文件 data/form.db（Bun 内置 SQLite，无任何原生依赖）
- 表单结构（forms.fields）与提交数据（submissions.data）以 JSON 存储
- WAL 模式 + 外键约束 + busy_timeout（写事务并发时等待锁而非立即失败）+ 提交数据按表单建索引
- 提交记录保存提交者 IP：优先读反向代理头 `X-Forwarded-For` / `X-Real-IP`（需代理为可信来源），直连时取 TCP 连接地址
- 上传文件存储于 data/uploads/form-{表单ID}/，仅能通过后台接口下载（带防目录穿越校验）

## 快速开始

```bash
bun install   # 安装依赖（hono / ejs / alpinejs / qrcode / xlsx）
bun run dev   # 开发模式启动（--watch 热重载），默认端口 3000
bun run start # 生产模式启动
```

> 说明：`xlsx` 从 SheetJS 官方 CDN（cdn.sheetjs.com）安装 0.20.3（npm 上最新版 0.18.5 存在已知漏洞 CVE-2023-30533 / CVE-2024-22363 且不再更新）。
>
> 生产部署：设置 `NODE_ENV=production` 与 `ADMIN_SECRET`（见下表）后以 `bun run start` 启动；若部署在反向代理之后，还需配置 `TRUSTED_PROXIES`。

- 前台首页：http://localhost:3000/（表单中心）
- 后台地址：http://localhost:3000/admin
- 默认管理员：首次启动自动创建（`admin / admin123`，可用环境变量覆盖），请尽快在后台修改密码
- 填写页链接：`http://localhost:3000/f/<slug>`（在表单编辑页可一键复制）

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务端口 |
| `ADMIN_USERNAME` | `admin` | 首次启动创建的默认管理员用户名 |
| `ADMIN_PASSWORD` | `admin123` | 首次启动创建的默认管理员密码（仅首次生效） |
| `ADMIN_SECRET` | 内置默认值（仅开发） | 登录 Cookie 签名密钥；**生产环境（`NODE_ENV=production`）必须显式设置，否则拒绝启动** |
| `TRUSTED_PROXIES` | 空（不信任任何反代头） | 可信反向代理地址，逗号分隔的 IP 或 CIDR（如 `127.0.0.1,10.0.0.0/8`）。仅当连接来源命中白名单时才采信 `X-Forwarded-For` / `X-Real-IP`，否则一律使用 TCP 连接地址 —— 防止伪造请求头绕过 IP 上限/限流/溯源。**部署在反代之后必须配置**，否则所有客户端会被识别为代理自身 IP |
| `PUBLIC_BASE_URL` | 请求的 origin | 对外公开基址（如 `https://forms.example.com`），用于二维码等场景固定链接，避免受 Host 头影响 |

## 目录结构

```
├── src/
│   ├── index.ts          # 入口：EJS 渲染、路由装配、静态资源、启动 Bun 服务
│   ├── db.ts             # bun:sqlite 初始化、建表、迁移、通用工具
│   ├── ip.ts             # 客户端 IP 识别（反代头 / 连接信息）
│   ├── auth.ts           # 登录态签名 Cookie + 密码哈希（Bun 内置 argon2id）
│   ├── roles.ts          # 角色与权限定义
│   ├── fields.ts         # 字段类型定义、约束、规范化、提交数据校验
│   ├── ratelimit.ts      # 内存限流与登录失败锁定
│   ├── captcha.ts        # 登录验证码（纯文本生成 SVG，内存存储，一次性使用）
│   ├── audit.ts          # 管理操作审计日志
│   ├── files.ts          # 上传文件存储（防目录穿越）
│   ├── region.ts         # 省市县区划数据（来自本地依赖 china-division）
│   └── routes/
│       ├── admin.ts      # 后台 API（表单 CRUD / 数据 / 筛选 / 统计 / 导出 / 审计）
│       └── public.ts     # 公开 API（获取表单 / 提交 / Webhook 推送）
├── views/                # EJS 服务端模板
│   ├── admin.ejs         # 后台（列表 / 编辑 / 数据 / 统计，Alpine 组件挂载）
│   ├── home.ejs          # 前台首页「表单中心」
│   ├── login.ejs         # 登录页
│   └── form.ejs          # 填写页（服务端渲染字段结构与状态）
├── public/               # 静态资源（统一样式表 + Alpine 组件逻辑，无需构建）
│   ├── app.css           # 全站统一样式（设计令牌 → 通用组件 → 各页面）
│   └── admin-app.js / form-app.js   # Alpine 组件（后台 / 填写页）
└── data/                 # 运行时自动创建：SQLite 数据文件 + uploads/ 上传附件
```

## 管理员与角色

- 首次启动自动创建默认超级管理员（`admin / admin123`，可用环境变量覆盖；出于安全考虑，密码不再回显到控制台/登录页），请尽快登录后台修改密码。

| 角色 | 权限 |
| --- | --- |
| 超级管理员 | 全部权限：表单增删改、发布、数据管理、导出、统计、管理员管理 |
| 编辑 | 创建/编辑/发布表单、查看与删除提交数据、导出、统计；不能删除表单、不能清空数据、不能管理管理员 |
| 观察者 | 只读：查看数据、统计与导出 |

- 接口级权限校验：无权限的操作返回 403，前端同步隐藏对应按钮
- 角色变更即时生效（每次请求都会核对数据库中的最新角色）
- 保护规则：不能删除当前登录账号；系统至少保留一名超级管理员
- 登录验证码：一次性使用、5 分钟过期，验证失败后前端自动刷新；密码校验前先验码，可有效抵御暴力破解
- 登录失败锁定：同 IP + 用户名 连续失败 5 次锁定 15 分钟（限流与锁定基于真实客户端 IP，直连部署下伪造 `X-Forwarded-For` 无法绕过，见 `TRUSTED_PROXIES`）
- CSRF 防护：后台写请求（非 GET/HEAD）必须携带与 httpOnly Cookie 配对的 `X-CSRF-Token` 头；登录态 Cookie 与 CSRF Cookie 在 HTTPS 下自动带 `Secure` 标记
- 全部管理操作写入审计日志（超管可在后台「审计」页查看最近 500 条，自动保留最近 2000 条）
- 公开提交：蜜罐字段命中才静默丢弃；提交过快（< 2 秒）返回明确错误提示，不再静默丢数据；上传总量 64MB / 单次最多 20 个文件（超出返回 413）；校验失败时已保存的上传文件自动清理
- 字段 id 仅允许字母数字下划线连字符（保存时强制清洗，非法 id 自动重新生成），防止注入前端 Alpine 表达式（XSS）

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/api/captcha` | 获取登录验证码（无需登录） |
| POST | `/admin/api/login` | 登录 `{ username, password, captchaCode }`（验证码 id 由 Cookie 自动携带） |
| POST | `/admin/api/logout` | 退出登录 |
| GET | `/admin/api/me` | 当前管理员信息（含权限列表） |
| POST | `/admin/api/me/password` | 自己修改密码 `{ oldPassword, newPassword }` |
| GET | `/admin/api/audit` | 审计日志（仅超级管理员） |
| GET | `/admin/api/webhooks` | Webhook 预设列表（需 `form:update` 权限） |
| POST | `/admin/api/webhooks` | 添加 Webhook 预设 `{ name, url, method, body }` |
| PUT | `/admin/api/webhooks/:id` | 修改 Webhook 预设 |
| DELETE | `/admin/api/webhooks/:id` | 删除 Webhook 预设（自动解除表单引用） |
| GET | `/admin/api/admins` | 管理员列表（仅超级管理员） |
| POST | `/admin/api/admins` | 添加管理员 `{ username, password, role }` |
| PUT | `/admin/api/admins/:id` | 修改密码 / 角色 |
| DELETE | `/admin/api/admins/:id` | 删除管理员（不能删自己、至少保留一名超管） |
| GET | `/admin/api/forms` | 表单列表（含提交数） |
| POST | `/admin/api/forms` | 创建表单 `{ title, description, fields, ipLimit? }` |
| GET | `/admin/api/forms/:id` | 表单详情 |
| PUT | `/admin/api/forms/:id` | 更新表单（标题/描述/字段/状态/IP 上限） |
| PATCH | `/admin/api/forms/:id/status` | 更新状态 `{ status }` |
| PATCH | `/admin/api/forms/:id/show` | 设置是否在首页展示 `{ show: true/false }` |
| POST | `/admin/api/forms/:id/clone` | 克隆表单（生成草稿副本） |
| DELETE | `/admin/api/forms/:id` | 删除表单及全部提交 |
| GET | `/admin/api/forms/:id/submissions` | 提交数据分页 `?page=&size=&q=&filters=&from=&to=`（filters 为 JSON：字段ID→值） |
| DELETE | `/admin/api/forms/:id/submissions` | 清空提交数据 |
| GET | `/admin/api/forms/:id/submissions/export` | 导出 CSV / Excel（`format=xlsx`，支持 `q` / `filters` / `from` / `to`） |
| GET | `/admin/api/forms/:id/stats` | 统计数据 `?days=N` 或 `?from=&to=` |
| GET | `/admin/api/forms/:id/qrcode` | 填写页链接二维码（SVG） |
| GET | `/admin/api/forms/:id/submissions/:subId/files/:fieldId` | 下载提交附件（需 data:view 权限） |
| DELETE | `/admin/api/submissions/:id` | 删除单条提交 |
| GET | `/api/public/forms/:slug` | 填写页获取表单（含 `ipCount` / `reachedLimit` 当前 IP 提交情况） |
| GET | `/api/public/regions` | 省市县区划树（地区字段联动用，静态可长缓存） |
| POST | `/api/public/forms/:slug/submit` | 提交 `{ data: { 字段ID: 值 } }`（含文件字段时为 multipart/form-data）；超 IP 上限返回 403 `code=ip_limit` |

除登录 / 登出外，`/admin/api/*` 均需携带登录 Cookie。

## 字段定义格式

```json
{
  "id": "f123abc",
  "type": "radio",
  "label": "性别",
  "required": true,
  "options": ["男", "女"],
  "minSelect": 1,
  "maxSelect": 2
}
```

- `type` 取值：`text` / `textarea` / `number` / `email` / `phone` / `date` / `radio` / `checkbox` / `select` / `file` / `region`
- 地区字段（`region`）：填写页为省/市/区县三级联动下拉，提交值为 `省/市/区` 字符串，服务端基于内置区划数据校验合法性
- 文件上传字段：`maxSizeMB`（1-50，默认 10）与 `accept`（扩展名白名单，如 `jpg,png,pdf`）
- 选择类字段（radio/checkbox/select）需提供 `options` 数组；文本类字段可提供 `placeholder`
- 字段 `id` 是提交数据的存取键，编辑表单时已有字段会保留原 id

### 字段约束

| 约束键 | 适用类型 | 说明 |
| --- | --- | --- |
| `required` | 全部 | 必填 |
| `minLength` / `maxLength` | text、textarea | 字符数下限/上限（上限自动封顶：text 500、textarea 2000） |
| `pattern` | text、textarea | JS 正则表达式校验，保存时校验其合法性 |
| `min` / `max` | number | 数值最小/最大值 |
| `min` / `max` | date | 最早/最晚日期（YYYY-MM-DD） |
| `minSelect` / `maxSelect` | checkbox | 最少/最多可勾选项数（不超过选项总数） |
| `maxSizeMB` / `accept` | file | 单文件大小上限（MB，1-50，默认 10）与允许的扩展名白名单 |

- 约束在填写页（前端预校验）与提交接口（后端校验）双重生效
- 不合法的约束配置（如最小值大于最大值、正则无法编译、选择数超过选项总数）在保存表单时即被拒绝
- 切换字段类型时自动清空不适用的约束配置

> 说明：表单已收集数据后再修改字段，历史提交按字段 id 存取 —— 新增字段在旧数据中为空、被删除字段的旧数据不再展示，属预期行为。

QQ:11189484