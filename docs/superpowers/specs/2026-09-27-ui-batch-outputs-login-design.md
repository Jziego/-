# 第三批次 UI 设计 —— 产物管理 + 登录体验（OTP）

- 日期：2026-09-27
- 状态：设计已批准（用户 2026-09-27 确认），待实施
- 关联调研：登录模板与 OTP 方案调研（2026-09-23 子代理报告，要点已固化于本文）

---

## 1. 背景与目标

| 子项 | 现状痛点 | 目标 |
|------|---------|------|
| ② 产物管理 | 产物卡片纵向平铺、所有卡同名「成片视频」无法区分、**无删除键** | 竖屏网格卡片（封面+类型+日期）+ 删除 |
| ③ 登录体验 | magic link 要去邮箱复制链接回浏览器，流程断点大；浅色白卡与主站深色（`#0a0a0a`）不搭 | 邮箱收 6 位验证码、页内填码即登录；深色风格统一 |

已拍板：产物布局=竖屏网格卡片（2-3 列）；OTP 保留 magic link 兜底（零成本）；删除确认用 `window.confirm`（与素材/分身删除一致，不扩范围）。

## 2. 产物管理设计

### 2.1 删除 API（新建 `app/api/render-projects/outputs/[id]/route.ts`）

```
DELETE /api/render-projects/outputs/[id]
  → getOwnerId()（不读 demoOwnerId，遵循 CLAUDE.md 认证模式）
  → repo.findOutputById(id)；不存在或跨租户 → 404（不泄露存在性）
  → 删 R2 产物文件（storageKey）+ 封面（coverStorageKey，若有）
  → repo.deleteOutput(id)（见 2.3）
  → jsonOk({ deleted: true })
```

- R2 删除失败不阻塞 DB 删除？——**否，fail-fast**：先删 R2 再删 DB，R2 失败则 500 且 DB 保留，用户可重试；孤儿 R2 文件比孤儿 DB 记录危害小（记录没了文件还在 = 永久泄漏存储）
- 产物删除不级联 RenderProject（渲染任务历史保留）

### 2.2 网格卡片 UI（重构 `components/dashboard.tsx` 的 `VideoOutputCard` + `#render-outputs` 区块）

- 布局：`.timeline` 纵向列表 → CSS Grid，桌面 3 列 / 平板 2 列 / 移动 1 列
- 卡片内容：
  - 封面：`coverStorageKey` 存在 → 预签名 URL `<img>`；不存在 → 回退 `<video preload="metadata">` 首帧（现状模式）
  - 类型徽标：`kind` 映射中文（talking_head→口播成片、segmented_voice→分段口播、final_composite→素材成片、slideshow→幻灯片）
  - 元信息：创建日期（`createdAt` 格式化 MM-DD HH:mm）+ 时长
  - 操作：hover/常驻「下载」「删除」按钮
- 删除流程：`window.confirm` → DELETE → 成功 invalidate `["render-outputs"]` query（现有 React Query 模式）+ 消息提示
- 标题：类型中文名 + 日期（不 join scriptDraft 封面标题——跨表 join 成本高收益低，YAGNI）

### 2.3 Repository 扩展

`RenderRepository`（`lib/repositories/types.ts`）新增 `deleteOutput(id: string): Promise<boolean>`，Prisma + memory 双实现 + 双实现测试（项目惯例）。

### 2.4 前端 API 封装

`lib/api-client.ts` 新增 `deleteVideoOutputApi(id)`；`fetchVideoOutputUrl` 模式保留。

## 3. 登录 OTP 设计（方案 A：EmailProvider 改造）

调研结论：NextAuth v5 的 Email provider 把 token 从 32 位随机串换成 6 位数字即可，哈希存储（sha256+AUTH_SECRET）、一次性消费（查完即删）、过期检查、首次登录自动建用户（走自定义 createUser，plan=free/quota=10）**全部内置**。

### 3.1 后端（`auth.ts`）

```ts
EmailProvider({
  server: {},
  from: getEmailFrom(),
  maxAge: 10 * 60,  // 10 分钟（替代默认 24h）
  async generateVerificationToken() {
    return randomInt(0, 1_000_000).toString().padStart(6, "0");
  },
  sendVerificationRequest: async ({ identifier: email, token, url }) => {
    // 发验证码邮件（renderOtpEmail(token, url)）：大字验证码 + 备用 magic link
    // dev 无 RESEND_API_KEY 时 console 打印验证码（替代现在的 URL 打印）
  },
})
```

### 3.2 verify 页两段式（改造 `app/login/verify/page.tsx`）

1. 用户输邮箱点「发送验证码」→ 现状 sendMagicLink action（三层限流已有）→ 跳 verify 页
2. verify 页：显示邮箱 + 6 位码输入框（`inputMode="numeric"`, `maxLength=6`, 大号字距样式）
3. 提交：`fetch("/api/auth/callback/email?email=..&token=..&callbackUrl=/", { redirect: "manual" })`
   - 成功：响应为重定向（3xx，Location=callbackUrl）→ `router.push("/")`
   - 失败：重定向回 `/login?error=Verification` → 显示「验证码错误或已过期」
   - **实施注意**：用 `redirect: "manual"` 读 Location，避免 follow 后吞整页 HTML；fetch 需带 `credentials: "include"` 让 Set-Cookie 落会话
4. 「重新发送」（60s 冷却，前端计时）+「更换邮箱」返回链接

### 3.3 安全前置（`middleware.ts`）——**关键缺口修复**

现状：`/api/auth` 是公开路径且在 IP 限流**之前** return，OTP 校验端点零限流 = 6 位码可在线爆破（百万空间，无尝试上限）。

新增：`/api/auth/callback/email` 专项限流（Redis 计数，fail-open 与现有限流一致）：
- `otp:try:email:{email}`：10 分钟窗口最多 **5 次**校验尝试
- `otp:try:ip:{ip}`：10 分钟窗口最多 20 次
- 超限 → 429 JSON；计数只在**校验失败**时递增（成功不算，防误伤）——实现上中间件无法先知成败，改为：进入即计数，但成功消费后 NextAuth 删 token 天然防重放；5 次硬顶对正常用户足够（输错 5 次就该重发了）

防爆破数学：6 位 = 1e6 空间，5 次/码 → 单码成功率 5e-6，发送侧限流（email 1/min + IP 20/h 已有）压制换码速度，风险可接受。

### 3.4 登录页 UI 重构（shadcn login-01 风格，深色）

- 来源：shadcn/ui login-01 block（MIT），手动复制 `login-form` 结构 + 自建 Button/Card/Input/Label 4 个极简基础组件（**不引入 shadcn 体系**，无 components.json）
- 深色对齐主站：背景 `#0a0a0a`，卡片用主站卡片色板（globals.css 变量），品牌标题「AI 短视频助手」+ 一句话价值主张
- 表单：邮箱输入 + 「发送验证码」按钮（文案从「发送登录链接」改）+ 微信登录分隔保留
- verify 页同款深色风格

## 4. 数据模型

**无迁移**。`VideoOutput` 复用；`VerificationToken` 模型已存在（NextAuth 内置流程使用）；`RenderRepository.deleteOutput` 为纯代码扩展。

## 5. 测试策略（TDD）

1. 删除端点：ownerId 归属校验、跨租户 404、R2 删除调用顺序（先 R2 后 DB）、R2 失败 DB 保留、memory/prisma 双实现 deleteOutput
2. OTP：generateVerificationToken 输出 6 位数字格式；maxAge=600 配置断言
3. 限流：5 次后 429、窗口过期重置（mock Redis）
4. UI 组件：网格卡片渲染（封面有无两态）、删除按钮触发 confirm+API、verify 页输码提交流程（mock fetch）
5. 五件套：`npm test && npm run typecheck && npm run lint && npx prisma validate && npm run build`

## 6. 明确不做（YAGNI）

- 不做产物批量删除/批量下载
- 不做产物重命名（无标题字段，卡片标题=类型+日期）
- 不做确认弹窗组件（window.confirm 统一，已有延期打磨共识）
- 不引入 shadcn 体系（手动抄 4 个基础组件）
- 不做 Credentials provider 方案 B（方案 A 已满足，安全缺口靠中间件限流补齐）
- 不动微信登录逻辑（仅样式随卡片统一）
- 不删除 magic link（邮件内附兜底链接）

## 7. 部署与验收

1. 无新环境变量、无迁移；Zeabur 自动部署
2. 生产冒烟：
   - 产物：出一条片 → 网格卡片展示 → 删除 → 列表消失 + R2 文件无残留
   - 登录：邮箱收 6 位码 → 填码登录成功；错 5 次 → 429；10 分钟后过期提示；magic link 兜底链接可用
3. 安全审查：OTP 限流生效、删除端点跨租户防护、错误文案不泄露邮箱存在性（恒定文案模式已有，保持）
