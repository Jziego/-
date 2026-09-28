# 登录界面 UI 重做 + 第三批次 follow-ups 修复

- 日期：2026-09-28
- 状态：设计已敲定，待实施
- 上游：`docs/superpowers/plans/2026-09-27-ui-batch-outputs-login.md`（第三批次产物 UI + 登录 OTP 已完成，本 spec 为其补充批次）

---

## 1. 背景

第三批次交付了 OTP 验证码登录的**功能**，但登录页/verify 页 UI 未动。诊断根因：登录页是**设计体系外孤岛**——主界面已有完整体系（`app/globals.css`：`ambientGlow` 光晕、`hero` 品牌区、`.card`、`.primaryButton` 发光 hover、全局 input 样式），而登录页用 Tailwind 裸类手搓（`bg-neutral-900`/`bg-blue-600`），与主界面不像同一个产品。

**选型决策**：放弃外部模板（shadcn login-01 会引入第二套视觉语言），**把登录页纳入自有体系**。已拍板：居中卡片+氛围增强布局、OTP 6 格分格输入。

同时顺带修复 `docs/superpowers/follow-ups.md` 第三批次的 Minor 项（第 4 节清单）。

## 2. 范围

| 块 | 内容 |
|----|------|
| A. 登录页重做 | `app/login/page.tsx` 纳入体系 + 品牌区 + 氛围背景 |
| B. verify 页重做 | `app/login/verify/page.tsx` 体系化 + OTP 6 格分格组件 |
| C. follow-ups 修复 | 见第 4 节清单（8 项） |

## 3. 登录页与 verify 页设计

### 3.1 登录页（`app/login/page.tsx`）

```
┌─ ambientGlow 顶部光晕（复用主界面类）──────────┐
│  eyebrow: AI 短视频助手                          │
│  H1: 让每家店都有自己的数字人口播                  │
│  蓝色光线分隔（hero::after 同款）                 │
│  ┌─ .card 体系卡片 ────────────────────────┐   │
│  │ 邮箱地址（全局 input 样式，删除手搓类）     │   │
│  │ [发送验证码]  .primaryButton（发光 hover） │   │
│  │ ──── 其他登录方式 ────                    │   │
│  │ [💬 微信登录]  体系 secondary 风格+绿 icon │   │
│  └─────────────────────────────────────────┘   │
└────────────────────────────────────────────────┘
```

- 删除全部 Tailwind 裸色类（`bg-neutral-900`、`bg-blue-600` 等），改用体系类；新增 CSS 进 `globals.css` 末尾登录区块（命名跟随现有 camelCase 风格：`.loginHero`/`.loginCard`/`.divider` 等）
- 错误提示（`?error=Verification` 回跳）用体系 warning 样式（参照 `statusBadge.warning` 色板）
- 品牌区文案：eyebrow「AI 短视频助手」+ 标题「让每家店都有自己的数字人口播」（拍板 preview 中文案）
- 微信按钮：保留 `#07C160` 绿 icon，按钮体改为体系 secondary 风格（透明底 + 边框 + hover 微亮），与 primary 层级拉开
- 逻辑不变：`sendMagicLink` action、`?error=Verification` 回跳、`signInWithWeChat` 均保持

### 3.2 verify 页（`app/login/verify/page.tsx`）

- 同样的 ambientGlow + 体系卡片；📧 emoji 删除（不引图标库，用纯 CSS/排版处理标题区）
- **OTP 6 格分格组件**（新组件 `app/login/verify/otp-input.tsx`）：
  - 实现方案：**单个透明 input 覆盖 + 6 格视觉层**（不引第三方库；`input-otp` 库同思路，自实现约 80 行）。理由：粘贴、iOS `one-time-code` 自动填充、移动端数字键盘、无障碍全部天然正确；6 独立 input 方案需自管 focus 跳转/退格回退，代码多且边界 case 多
  - 交互：数字过滤（沿用现有 `replace(/\D/g, "")`）；**输满 6 位自动提交**；当前待填格高亮（体系 focus 光环）；已填格显示数字
  - 保留 `inputMode="numeric"`、`autoComplete="one-time-code"`、`maxLength=6`
- 倒计时重构：`setInterval` → `useEffect` 驱动（修 follow-up #7 的 unmount 泄漏）
- 保留：重发冷却 60s、更换邮箱链接、email 缺失兜底分支、整页跳转 submit（`/api/auth/callback/email` 302 机制）

### 3.3 验证方式

本地 dev server 起页 → Playwright 截图两页（含 OTP 填态/错误态）→ 用户肉眼验收。UI 皮肤改动不以单测为主，交互逻辑（OTP 组件、倒计时）走单测。

## 4. follow-ups 修复清单

| # | 项 | 修法 |
|---|----|------|
| 1 | 产物删除 404 文案中英不一 | `outputs/[id]/route.ts` 中文「产物不存在」→ `"Output not found"`（与同目录 url 路由一致，中文留给前端层） |
| 2 | 路由层 try/catch 与 storage「错误内部消化」契约重复 | **删路由层冗余 catch**（已拍板）；`lib/storage.ts` 契约注释强化为显式契约说明 |
| 3 | `.outputCover` 硬编码 9/16 裁切非竖屏 | 改 `object-fit: contain`（黑底已有，不裁切不露馅）；aspect-ratio 保留 9/16 作容器比例 |
| 4 | 测试时区断言依赖本地时区 | `/09-27/` 具体日期断言 → 放宽为 `/\d{2}-\d{2}/` 格式断言 |
| 5 | OTP dev fallback 不打印 URL | `auth.ts` dev fallback 打印 email→token 之外补打完整 callback URL |
| 6 | `lib/auth/magic-link-email.ts` 文件名语义过期 | 改名 `otp-email.ts`，测试文件同步改，全部引用更新 |
| 7 | verify 倒计时 interval 无 unmount 清理 | 并入 3.2 重构（useEffect 驱动） |
| 8 | 登录/verify 测试缺口 | 补用例：email 缺失兜底、重发冷却、submit URL 构造；`sendMagicLink` 反枚举三路径同文案锁定 |
| 11 | OTP 测试隔离位置依赖 | `tests/rate-limit.test.ts` 加显式 `_resetRedis()`，去位置依赖 |

**明确不修**：#9 OTP 撞库唯一索引（概率可忽略，备注保留）；#10 拆出为下条。

## 5. 安全：`/api/auth/*` 命名空间 L0 限流（follow-up #10，已拍板本次做）

现状：OTP 校验端点（callback/email）已有专项限流；但 `/api/auth/csrf`、`/api/auth/session`、`/api/auth/signin/*` 等无 IP 级限流，缺 email 参数的 callback 请求可零限流打 DB。

设计：

- `middleware.ts` 加 auth 命名空间 L0 桶：**IP 维度 60 次/分钟**（Redis 计数，复用现有 `rateLimitByIp` 基础设施）
- **豁免 `/api/auth/session`**（每次页面加载都打，限了会误伤正常浏览；它是 JWT 解码+Redis 黑名单读，成本可控）
- OTP 专项限流（更严）保持不动，L0 是兜底不是替代
- 沿用现有模式：仅 production 模式启用，demo 放行；超限返回 429 JSON（API 路径）
- 单测：middleware 层覆盖新桶触发/豁免路径/demo 放行

## 6. 测试策略

- TDD：OTP 输入组件（跳格/粘贴拆分/自动提交/非数字过滤）、倒计时 useEffect 重构、限流桶、404 文案、改名后引用完整性
- 回归：既有登录/OTP 测试全绿；`npm test && npm run typecheck && npm run lint && npx prisma validate && npm run build` 五件套
- 视觉验收：Playwright 截图（登录页、verify 空态/填态/错误态），用户确认后 push

## 7. 明确不做（YAGNI）

- 不引入 shadcn/ui 体系或任何组件库/图标库
- 不做左右分屏布局（已拍板居中卡片）
- 不做暗色/亮色主题切换（产品仅深色）
- 不动微信登录逻辑与 `app/login/actions.ts` 的限流参数
- 不做 OTP 撞库唯一索引改造（#9，备注保留观察）
- 不做登录页多语言
