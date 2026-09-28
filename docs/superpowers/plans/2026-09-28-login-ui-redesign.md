# 登录界面 UI 重做 + 第三批次 follow-ups 修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登录/verify 页纳入自有设计体系（globals.css），OTP 改 6 格分格输入；顺带修复第三批次 follow-ups 8 项 + `/api/auth/*` 命名空间 L0 限流。

**Architecture:** 零新依赖。UI 复用 `app/globals.css` 既有 CSS 变量与组件类，新增登录/OTP 专用区块（camelCase 命名跟随现状）。OTP 输入用「单透明 input + 6 格视觉层」自实现组件。限流复用 `lib/rate-limit.ts` 的 `checkLimit` 固定窗口基础设施。

**Tech Stack:** Next.js 16 App Router、React 19、Tailwind 4（仅体系外孤岛清理）、Vitest + @testing-library/react。

**Spec:** `docs/superpowers/specs/2026-09-28-login-ui-redesign-design.md`

---

### Task 1: follow-ups 后端快修包（404 文案 / 冗余 catch / outputCover / 时区断言 / dev URL / _resetRedis）

**Files:**
- Modify: `app/api/render-projects/outputs/[id]/route.ts`
- Modify: `lib/storage.ts:221-226`
- Modify: `app/globals.css`（`.outputCover`，约 L985-991）
- Modify: `tests/render-output-card.test.tsx:47`
- Modify: `auth.ts:46`
- Modify: `tests/rate-limit.test.ts`（rateLimitOtpAttempt describe，约 L175-215）
- Test: `tests/outputs-delete-route.test.ts`（新建）

- [ ] **Step 1: 写失败测试（404 文案锁定）**

新建 `tests/outputs-delete-route.test.ts`，参照项目既有 API 路由测试模式（mock `@/lib/auth-helpers` 的 `getOwnerId`、`@/lib/rate-limit` 的 `applyRateLimit`、`@/lib/repositories`、`@/lib/storage`）：

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetOwnerId, mockFindOutputById, mockDeleteOutput, mockDeleteObject } = vi.hoisted(() => ({
  mockGetOwnerId: vi.fn(),
  mockFindOutputById: vi.fn(),
  mockDeleteOutput: vi.fn(),
  mockDeleteObject: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({ getOwnerId: mockGetOwnerId }));
vi.mock("@/lib/rate-limit", () => ({ applyRateLimit: vi.fn(async () => null) }));
vi.mock("@/lib/repositories", () => ({
  getRenderRepository: () => ({
    findOutputById: mockFindOutputById,
    deleteOutput: mockDeleteOutput,
  }),
}));
vi.mock("@/lib/storage", () => ({ deleteObject: mockDeleteObject }));

import { DELETE } from "@/app/api/render-projects/outputs/[id]/route";

function makeRequest(): Request {
  return new Request("http://localhost/api/render-projects/outputs/out_1", { method: "DELETE" });
}
function makeCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("DELETE /api/render-projects/outputs/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOwnerId.mockResolvedValue("user_1");
  });

  it("returns English 404 message for missing or foreign output (IDOR-safe)", async () => {
    mockFindOutputById.mockResolvedValue(null);
    const res = await DELETE(makeRequest(), makeCtx("out_x"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Output not found");
  });

  it("returns English 404 when output belongs to another owner", async () => {
    mockFindOutputById.mockResolvedValue({ ownerId: "user_2", storageKey: "k" });
    const res = await DELETE(makeRequest(), makeCtx("out_1"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Output not found");
  });

  it("deletes row and best-effort R2 objects (incl. cover) without try/catch wrap", async () => {
    mockFindOutputById.mockResolvedValue({
      ownerId: "user_1",
      storageKey: "renders/out_1.mp4",
      coverStorageKey: "renders/out_1.jpg",
    });
    mockDeleteOutput.mockResolvedValue(true);
    mockDeleteObject.mockResolvedValue(undefined);
    const res = await DELETE(makeRequest(), makeCtx("out_1"));
    expect(res.status).toBe(200);
    expect(mockDeleteObject).toHaveBeenCalledWith("renders/out_1.mp4");
    expect(mockDeleteObject).toHaveBeenCalledWith("renders/out_1.jpg");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/outputs-delete-route.test.ts`
Expected: FAIL（当前文案是「产物不存在」，断言 `"Output not found"` 不通过）

- [ ] **Step 3: 改路由 + storage 契约注释**

`app/api/render-projects/outputs/[id]/route.ts`：

1. L26 `"产物不存在"` → `"Output not found"`
2. 删 L31-41 的 try/catch（`deleteObject` 契约保证不 reject），替换为：

```ts
  await repo.deleteOutput(id);

  // R2 清理为尽力而为：deleteObject 契约保证永不 reject（见 lib/storage.ts），
  // 路由层不再需要 try/catch——与素材删除端点一致。
  await deleteObject(output.storageKey);
  if (output.coverStorageKey) {
    await deleteObject(output.coverStorageKey);
  }
```

`lib/storage.ts` L221-226 注释强化为显式契约：

```ts
/**
 * Best-effort object deletion. Swallows "not found" so DB-record deletion is
 * never blocked by a missing/stale S3 object — the DB row is the source of
 * truth.
 *
 * CONTRACT: this function NEVER rejects. All non-config errors are logged via
 * console.warn and swallowed (NoSuchBucket included — it surfaces via warn for
 * operators). Callers MUST NOT wrap in try/catch; if this contract ever
 * changes, update all call sites (asset deletion, output deletion).
 */
```

- [ ] **Step 4: outputCover 改 contain + 时区断言放宽 + dev fallback 打印 URL + _resetRedis 显式化**

`app/globals.css` `.outputCover`（约 L985）：

```css
.outputCover {
  aspect-ratio: 9 / 16;
  background: #000;
  border-radius: 10px;
  display: block;
  object-fit: contain; /* 非竖屏成片（1:1/16:9）不裁切，黑底留白 */
  width: 100%;
}
```

`tests/render-output-card.test.tsx` L47：

```ts
    expect(screen.getByText(/\d{2}-\d{2}/)).toBeTruthy(); // 放宽：不依赖本地时区的具体日期
```

`auth.ts` L46 dev fallback 补打 url：

```ts
          console.log(`[auth] otp dev fallback (no RESEND_API_KEY): ${email} → ${token} | url: ${url}`);
```

`tests/rate-limit.test.ts` 的 `describe("rateLimitOtpAttempt")` 内，每个测试在 `_resetMemoryStore()` 调用后紧跟显式 Redis 复位（`_resetRedis` 已存在于 `lib/session-blacklist.ts:69`，直接引入使用；共享连接缓存污染由此变为显式契约而非 describe 位置依赖）：

```ts
    const { _resetRedis } = await import("@/lib/session-blacklist");
    _resetRedis();
```

（共 3 处：约 L177-183、L191-197、L205-211 三个测试的 `_resetMemoryStore()` 之后）

- [ ] **Step 5: 全绿 + commit**

Run: `npx vitest run tests/outputs-delete-route.test.ts tests/render-output-card.test.tsx tests/rate-limit.test.ts`
Expected: 全 PASS

```bash
git add app/api/render-projects/outputs/\[id\]/route.ts lib/storage.ts app/globals.css tests/render-output-card.test.tsx auth.ts tests/rate-limit.test.ts tests/outputs-delete-route.test.ts
git commit -m "fix(follow-ups): 404文案统一英文+删冗余catch+outputCover改contain+时区断言放宽+dev打印OTP链接+OTP测试显式_resetRedis

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: magic-link-email → otp-email 改名

**Files:**
- Rename: `lib/auth/magic-link-email.ts` → `lib/auth/otp-email.ts`
- Rename: `tests/magic-link-email.test.ts` → `tests/otp-email.test.ts`
- Modify: `auth.ts:10`

- [ ] **Step 1: git mv 两文件**

```bash
git mv lib/auth/magic-link-email.ts lib/auth/otp-email.ts
git mv tests/magic-link-email.test.ts tests/otp-email.test.ts
```

- [ ] **Step 2: 更新引用**

`auth.ts` L10：

```ts
import { renderOtpEmail } from "@/lib/auth/otp-email";
```

`tests/otp-email.test.ts` L2：

```ts
import { renderOtpEmail } from "@/lib/auth/otp-email";
```

确认无其他引用：`grep -r "magic-link-email" --include="*.ts" --include="*.tsx" lib app tests auth.ts` 应只剩文档（docs/ 下历史计划可不动）。

- [ ] **Step 3: 跑测试 + commit**

Run: `npx vitest run tests/otp-email.test.ts && npm run typecheck`
Expected: PASS + 无类型错误

```bash
git add -A
git commit -m "refactor(auth): magic-link-email 改名 otp-email——文件名与 OTP 语义对齐

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: `/api/auth/*` 命名空间 L0 限流

**Files:**
- Modify: `lib/rate-limit.ts`（`IP_LIMIT_CONFIG` 附近，约 L233-246）
- Modify: `middleware.ts`（/api/auth 段，L19-33）
- Test: `tests/rate-limit.test.ts`（新增 describe）

- [ ] **Step 1: 写失败测试**

`tests/rate-limit.test.ts` 末尾新增：

```ts
describe("rateLimitAuthNamespace", () => {
  it("allows up to 60 requests per minute per IP, then rejects", async () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("REDIS_URL", "");
    const { rateLimitAuthNamespace, _resetMemoryStore } = await import("@/lib/rate-limit");
    const { _resetRedis } = await import("@/lib/session-blacklist");
    _resetMemoryStore();
    _resetRedis();
    for (let i = 0; i < 60; i++) {
      expect(await rateLimitAuthNamespace("9.9.9.9")).toBe(true);
    }
    expect(await rateLimitAuthNamespace("9.9.9.9")).toBe(false);
  });

  it("isolates counters per IP", async () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("REDIS_URL", "");
    const { rateLimitAuthNamespace, _resetMemoryStore } = await import("@/lib/rate-limit");
    const { _resetRedis } = await import("@/lib/session-blacklist");
    _resetMemoryStore();
    _resetRedis();
    for (let i = 0; i < 60; i++) await rateLimitAuthNamespace("9.9.9.9");
    expect(await rateLimitAuthNamespace("8.8.8.8")).toBe(true);
  });
});

describe("isAuthL0Exempt", () => {
  it("exempts the session endpoint only", async () => {
    const { isAuthL0Exempt } = await import("@/lib/rate-limit");
    expect(isAuthL0Exempt("/api/auth/session")).toBe(true);
    expect(isAuthL0Exempt("/api/auth/csrf")).toBe(false);
    expect(isAuthL0Exempt("/api/auth/callback/email")).toBe(false);
    expect(isAuthL0Exempt("/api/auth/signin/email")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/rate-limit.test.ts -t "rateLimitAuthNamespace"`
Expected: FAIL（`rateLimitAuthNamespace is not a function` / `isAuthL0Exempt is not a function`）

- [ ] **Step 3: 实现**

`lib/rate-limit.ts` 在 `rateLimitByIp` 之后（约 L246 后）新增：

```ts
// ── L0-auth: /api/auth/* 命名空间级限流 ──────────────────────────────────────

const AUTH_NAMESPACE_LIMIT: RateLimitConfig = { windowSeconds: 60, maxRequests: 60 };

/**
 * L0-auth: /api/auth/* 命名空间级 IP 限流（OTP 专项限流之外的兜底）。
 * 正常登录流程一分钟约十余次请求（csrf+signin+callback+页面加载），60/min
 * 只挡脚本级刷量。/api/auth/session 由 middleware 豁免（每次页面加载都打）。
 * 与 L0/L2 同一后端：无 Redis 时 demo 走 memory / production fail-open（既有口径）。
 */
export async function rateLimitAuthNamespace(ip: string): Promise<boolean> {
  const result = await checkLimit(`auth:ns:${ip}`, AUTH_NAMESPACE_LIMIT, false);
  return result.allowed;
}

/** 豁免 L0 命名空间限流的 auth 路径（高频只读，限流会误伤正常浏览）。 */
export function isAuthL0Exempt(pathname: string): boolean {
  return pathname === "/api/auth/session";
}
```

`middleware.ts` L4 import 更新 + /api/auth 段（L19-33）改为：

```ts
import { rateLimitByIp, getClientIp, rateLimitOtpAttempt, rateLimitAuthNamespace, isAuthL0Exempt } from "@/lib/rate-limit";
```

```ts
  if (pathname.startsWith("/api/auth")) {
    const ip = getClientIp(req.headers);
    // OTP 校验端点爆破防护（专项、更严）：6 位码若无尝试上限可在线爆破。
    if (pathname === "/api/auth/callback/email") {
      const email = req.nextUrl.searchParams.get("email") ?? "";
      if (email && !(await rateLimitOtpAttempt(ip, email))) {
        return NextResponse.json(
          { error: "rate_limited", message: "尝试次数过多，请 10 分钟后再试" },
          { status: 429 },
        );
      }
    }
    // L0 命名空间兜底：csrf/signin 等端点此前零限流可刷 DB（session 豁免）。
    if (!isAuthL0Exempt(pathname) && !(await rateLimitAuthNamespace(ip))) {
      return NextResponse.json(
        { error: "rate_limited", message: "请求过于频繁，请稍后再试" },
        { status: 429 },
      );
    }
    return NextResponse.next();
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/rate-limit.test.ts`
Expected: 全 PASS（含既有用例）

- [ ] **Step 5: commit**

```bash
git add lib/rate-limit.ts middleware.ts tests/rate-limit.test.ts
git commit -m "feat(security): /api/auth/* 命名空间 L0 限流（60/min/IP，session 豁免）——堵 csrf/signin 零限流刷 DB 缺口

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: OTP 6 格分格输入组件

**Files:**
- Create: `app/login/verify/otp-input.tsx`
- Modify: `app/globals.css`（末尾新增登录/OTP 区块）
- Test: `tests/otp-input.test.tsx`（新建）

- [ ] **Step 1: 写失败测试**

新建 `tests/otp-input.test.tsx`：

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OtpInput, OTP_LENGTH } from "@/app/login/verify/otp-input";

describe("OtpInput", () => {
  it("renders 6 cells and an accessible hidden input", () => {
    render(<OtpInput value="" onChange={() => {}} />);
    expect(screen.getByLabelText("登录验证码")).toBeInTheDocument();
    expect(document.querySelectorAll(".otpCell")).toHaveLength(OTP_LENGTH);
  });

  it("filters non-digits and truncates to 6", () => {
    const onChange = vi.fn();
    render(<OtpInput value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("登录验证码"), { target: { value: "12ab3456789" } });
    expect(onChange).toHaveBeenCalledWith("123456");
  });

  it("fires onComplete exactly when reaching 6 digits", () => {
    const onComplete = vi.fn();
    const { rerender } = render(<OtpInput value="12345" onChange={() => {}} onComplete={onComplete} />);
    fireEvent.change(screen.getByLabelText("登录验证码"), { target: { value: "123456" } });
    expect(onComplete).toHaveBeenCalledWith("123456");
    rerender(<OtpInput value="123456" onChange={() => {}} onComplete={onComplete} />);
    fireEvent.change(screen.getByLabelText("登录验证码"), { target: { value: "123456" } });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("renders filled cells from value (paste path)", () => {
    render(<OtpInput value="123456" onChange={() => {}} />);
    const cells = document.querySelectorAll(".otpCell");
    expect(cells[0].textContent).toBe("1");
    expect(cells[5].textContent).toBe("6");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/otp-input.test.tsx`
Expected: FAIL（`@/app/login/verify/otp-input` 不存在）

- [ ] **Step 3: 实现组件**

新建 `app/login/verify/otp-input.tsx`：

```tsx
"use client";

import { useRef, useState } from "react";

/**
 * OTP 6 格分格输入：单透明 input 覆盖 + 视觉格层。
 * 选此方案（而非 6 个独立 input）因为：粘贴拆分、iOS one-time-code 自动
 * 填充、移动端数字键盘、退格导航全部天然正确，无需自管 focus 跳转。
 */
export const OTP_LENGTH = 6;

export function OtpInput({
  value,
  onChange,
  onComplete,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  function handleChange(raw: string) {
    const next = raw.replace(/\D/g, "").slice(0, OTP_LENGTH);
    onChange(next);
    if (next.length === OTP_LENGTH && next !== value) {
      onComplete?.(next);
    }
  }

  return (
    <div className="otpWrap" onClick={() => inputRef.current?.focus()}>
      <input
        ref={inputRef}
        className="otpHiddenInput"
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="登录验证码"
        maxLength={OTP_LENGTH}
        value={value}
        disabled={disabled}
        autoFocus
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => handleChange(e.target.value)}
      />
      {Array.from({ length: OTP_LENGTH }, (_, i) => {
        const filled = i < value.length;
        const active = focused && !disabled && i === Math.min(value.length, OTP_LENGTH - 1);
        return (
          <div
            key={i}
            aria-hidden
            className={`otpCell${filled ? " otpCellFilled" : ""}${active ? " otpCellActive" : ""}`}
          >
            {filled ? value[i] : active ? <span className="otpCaret" /> : ""}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: 加样式**

`app/globals.css` 末尾新增：

```css
/* ── 登录/验证码页（第三批次补充：纳入设计体系）── */
.otpWrap {
  cursor: text;
  display: flex;
  gap: 10px;
  justify-content: center;
  position: relative;
}

.otpHiddenInput {
  cursor: text;
  inset: 0;
  opacity: 0;
  position: absolute;
  width: 100%;
}

.otpHiddenInput:focus {
  border-color: transparent;
  box-shadow: none;
}

.otpCell {
  align-items: center;
  background: var(--input);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  color: var(--title);
  display: flex;
  font-size: 22px;
  font-weight: 700;
  height: 52px;
  justify-content: center;
  transition: border-color 150ms ease, box-shadow 150ms ease;
  width: 44px;
}

.otpCellFilled {
  background: var(--input-raised);
  border-color: rgba(255, 255, 255, 0.2);
}

.otpCellActive {
  border-color: var(--primary);
  box-shadow: var(--focus);
}

.otpCaret {
  animation: otpBlink 1.1s step-end infinite;
  background: var(--primary-hover);
  display: block;
  height: 24px;
  width: 2px;
}

@keyframes otpBlink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
```

- [ ] **Step 5: 全绿 + commit**

Run: `npx vitest run tests/otp-input.test.tsx`
Expected: 全 PASS

```bash
git add app/login/verify/otp-input.tsx app/globals.css tests/otp-input.test.tsx
git commit -m "feat(login): OTP 6 格分格输入组件（单透明 input+视觉格层，输满自动提交）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: verify 页体系化重做 + 倒计时 useEffect 重构 + 测试补缺口

**Files:**
- Create: `app/login/verify/otp-callback.ts`
- Modify: `app/login/verify/page.tsx`
- Modify: `app/globals.css`（登录区块追加 verify 样式）
- Test: `tests/login-verify.test.tsx`（改造）、`tests/otp-callback.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `tests/otp-callback.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { buildOtpCallbackUrl } from "@/app/login/verify/otp-callback";

describe("buildOtpCallbackUrl", () => {
  it("builds the NextAuth email callback URL with encoded params", () => {
    const url = buildOtpCallbackUrl("a+b@example.com", "123456");
    expect(url).toBe(
      "/api/auth/callback/email?email=a%2Bb%40example.com&token=123456&callbackUrl=%2F",
    );
  });
});
```

`tests/login-verify.test.tsx` 改造（现有 4 用例保留但更新查询方式，新增 2 用例）：

- `getByPlaceholderText("6 位验证码")` 不再存在（视觉格层取代 placeholder）→ 全部改用 `getByLabelText("登录验证码")`
- 首个用例的 submit 按钮禁用逻辑变化（6 格组件满 6 位自动提交，按钮仍保留作兜底）：`disabled={code.length !== 6}` 逻辑保留，用例同步为 label 查询
- 新增 email 缺失兜底用例：

```tsx
  it("shows fallback when email param is missing", () => {
    // 本文件顶部 vi.mock next/navigation 固定带 email；此用例需独立 mock——
    // 拆到独立 describe 用 vi.doMock 或新建测试文件 tests/login-verify-noemail.test.tsx：
  });
```

实际做法：**新建 `tests/login-verify-noemail.test.tsx`**（避免同文件 mock 冲突）：

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import VerifyPage from "@/app/login/verify/page";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/app/login/actions", () => ({
  sendMagicLink: vi.fn(),
}));

describe("/login/verify without email param", () => {
  it("shows the missing-email fallback with a link back to /login", () => {
    render(<VerifyPage />);
    expect(screen.getByText("缺少邮箱参数，请重新发起登录。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← 返回登录" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/otp-callback.test.ts tests/login-verify.test.tsx tests/login-verify-noemail.test.tsx`
Expected: FAIL（`otp-callback` 不存在；旧用例 placeholder 查询失败）

- [ ] **Step 3: 实现**

新建 `app/login/verify/otp-callback.ts`：

```ts
/** 构造 NextAuth Email provider 的 OTP 校验回跳 URL（整页跳转，cookie 随 302 落盘）。 */
export function buildOtpCallbackUrl(email: string, code: string): string {
  const params = new URLSearchParams({ email, token: code, callbackUrl: "/" });
  return `/api/auth/callback/email?${params.toString()}`;
}
```

`app/login/verify/page.tsx` 整体替换为：

```tsx
"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { sendMagicLink } from "../actions";
import { OtpInput } from "./otp-input";
import { buildOtpCallbackUrl } from "./otp-callback";

function VerifyContent() {
  const searchParams = useSearchParams();
  const email = searchParams.get("email") ?? "";
  const [code, setCode] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendError, setResendError] = useState(false);

  // useEffect 驱动倒计时（替代裸 setInterval）：组件卸载自动清理，无泄漏。
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  function submit(finalCode: string) {
    // 整页跳转交给浏览器：NextAuth 校验成功 302 到 callbackUrl（/），失败回
    // /login?error=Verification（pages.signIn）——session cookie 随响应落盘。
    window.location.assign(buildOtpCallbackUrl(email, finalCode));
  }

  async function resend() {
    if (resendCooldown > 0 || !email) return;
    setResendError(false);
    try {
      await sendMagicLink(email);
    } catch {
      // 发送失败：提示用户且不计冷却，允许立即重试
      setResendError(true);
      return;
    }
    setResendCooldown(60);
  }

  return (
    <main className="authPage">
      <div className="ambientGlow" aria-hidden />
      <div className="authCard">
        <div className="authCardHeader">
          <h1>输入登录验证码</h1>
          <p>
            若邮箱 <strong>{email || "已注册"}</strong> 存在，验证码已发送（10 分钟内有效）
          </p>
        </div>

        {email ? (
          <div className="authForm">
            <OtpInput value={code} onChange={setCode} onComplete={submit} />

            <button
              type="button"
              onClick={() => submit(code)}
              disabled={code.length !== 6}
              className="primaryButton"
            >
              登录
            </button>

            {resendError && (
              <div className="authError" role="alert">
                发送失败，请稍后重试
              </div>
            )}

            <div className="authLinks">
              <button
                type="button"
                onClick={() => void resend()}
                disabled={resendCooldown > 0}
                className="authLinkButton"
              >
                {resendCooldown > 0 ? `重新发送（${resendCooldown}s）` : "重新发送"}
              </button>
              <a href="/login" className="authLink">
                更换邮箱
              </a>
            </div>
          </div>
        ) : (
          <div className="authForm authFallback">
            <p>缺少邮箱参数，请重新发起登录。</p>
            <a href="/login" className="authLink">
              ← 返回登录
            </a>
          </div>
        )}
      </div>
    </main>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={<div className="authPage" />}>
      <VerifyContent />
    </Suspense>
  );
}
```

`app/globals.css` 登录区块（Task 4 的 OTP 样式之后）追加：

```css
.authPage {
  align-items: center;
  background: var(--background);
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 100vh;
  overflow: hidden;
  padding: 24px 16px;
  position: relative;
}

.authPage .ambientGlow {
  /* 复用主界面 .ambientGlow（globals.css L151），此处仅确保定位上下文 */
}

.authCard {
  background: var(--surface);
  border: 1px solid var(--border-subtle);
  border-radius: 16px;
  box-shadow: var(--shadow);
  max-width: 420px;
  padding: 32px 28px;
  position: relative;
  width: 100%;
  z-index: 1;
}

.authCardHeader {
  margin-bottom: 24px;
  text-align: center;
}

.authCardHeader h1 {
  font-size: 1.4rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0 0 8px;
}

.authCardHeader p {
  color: var(--text);
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
}

.authForm {
  display: grid;
  gap: 16px;
}

.authError {
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.35);
  border-radius: 10px;
  color: var(--warning);
  font-size: 13px;
  padding: 10px 14px;
}

.authLinks {
  align-items: center;
  display: flex;
  font-size: 13px;
  justify-content: space-between;
}

.authLink,
.authLinkButton {
  color: var(--primary-hover);
}

.authLink:hover,
.authLinkButton:hover:not(:disabled) {
  text-decoration: underline;
}

.authLinkButton {
  background: transparent;
  min-height: 0;
  padding: 0;
  width: auto;
}

.authLinkButton:disabled {
  color: var(--muted);
}

.authFallback {
  text-align: center;
}

.authFallback p {
  color: var(--text);
  font-size: 14px;
}
```

- [ ] **Step 4: 全绿 + commit**

Run: `npx vitest run tests/login-verify.test.tsx tests/login-verify-noemail.test.tsx tests/otp-callback.test.ts tests/otp-input.test.tsx`
Expected: 全 PASS

```bash
git add app/login/verify/ app/globals.css tests/login-verify.test.tsx tests/login-verify-noemail.test.tsx tests/otp-callback.test.ts
git commit -m "feat(login): verify 页纳入设计体系+OTP 6 格组件接入+倒计时改 useEffect 驱动

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 登录页体系化重做（品牌区 + 氛围背景）+ 反枚举限流用例

**Files:**
- Modify: `app/login/page.tsx`
- Modify: `app/globals.css`（登录区块追加）
- Test: `tests/login-page.test.tsx`（新建）、`tests/login-actions.test.ts`（补 1 用例）

- [ ] **Step 1: 写失败测试**

新建 `tests/login-page.test.tsx`：

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import LoginPage from "@/app/login/page";

const { sendMagicLinkMock, pushMock, signInWithWeChatMock } = vi.hoisted(() => ({
  sendMagicLinkMock: vi.fn(),
  pushMock: vi.fn(),
  signInWithWeChatMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/app/login/actions", () => ({
  sendMagicLink: sendMagicLinkMock,
  signInWithWeChat: signInWithWeChatMock,
}));

describe("/login page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMagicLinkMock.mockResolvedValue({ success: true, message: "ok" });
  });

  it("renders the brand hero with the product tagline", () => {
    render(<LoginPage />);
    expect(screen.getByText("AI 短视频助手")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "让每家店都有自己的数字人口播" })).toBeInTheDocument();
  });

  it("sends OTP then navigates to /login/verify with the email param", async () => {
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("邮箱地址"), { target: { value: "a@b.com" } });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    expect(sendMagicLinkMock).toHaveBeenCalledWith("a@b.com");
    await vi.waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/login/verify?email=a%40b.com");
    });
  });

  it("shows the Verification error banner when redirected back with ?error=Verification", () => {
    // error 回跳态需独立 mock searchParams——用 vi.doMock 方案过重，改为：
    // 本用例放在 tests/login-page-error.test.tsx（结构同 login-verify-noemail）。
  });
});
```

第三个用例**单独建文件** `tests/login-page-error.test.tsx`（searchParams mock 冲突规避，同 Task 5 模式）：

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import LoginPage from "@/app/login/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("error=Verification"),
}));

vi.mock("@/app/login/actions", () => ({
  sendMagicLink: vi.fn(),
  signInWithWeChat: vi.fn(),
}));

describe("/login?error=Verification", () => {
  it("shows the OTP-failed banner", () => {
    render(<LoginPage />);
    expect(screen.getByText("验证码错误或已过期，请重新获取")).toBeInTheDocument();
  });
});
```

`tests/login-actions.test.ts` 补限流路径同文案用例（现有 L43 已锁 malformed 邮箱路径，补限流路径）：

```ts
  it("keeps the generic success message when rate-limited (anti-enumeration)", async () => {
    // mock rateLimitLogin 返回 false，断言：返回文案与正常/畸形邮箱路径完全一致，且不调用 signIn
    const { sendMagicLink } = await import("@/app/login/actions");
    const result = await sendMagicLink("user@example.com");
    expect(result).toEqual({ success: true, message: "若邮箱存在，我们会发送邮件" });
  });
```

（该文件既有 mock 结构参照 L28-56 现有用例：`@/lib/rate-limit` 的 `rateLimitLogin` 已是 mock 对象，本用例 `mockResolvedValueOnce(false)`；`signIn` mock 断言 `not.toHaveBeenCalled()`）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/login-page.test.tsx tests/login-page-error.test.tsx`
Expected: FAIL（品牌区文案/标题不存在，页面结构未改）

- [ ] **Step 3: 重写登录页**

`app/login/page.tsx` 整体替换为：

```tsx
"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { sendMagicLink, signInWithWeChat } from "./actions";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // OTP 校验失败时 NextAuth 回跳 /login?error=Verification
  const verifyFailed = searchParams.get("error") === "Verification";
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await sendMagicLink(email);
    } catch {
      setMessage("发送失败，请稍后重试");
      setLoading(false);
      return;
    }
    // 仅发送成功后才跳验证码页；导航失败不再误报"发送失败"
    router.push(`/login/verify?email=${encodeURIComponent(email)}`);
  }

  return (
    <main className="authPage">
      <div className="ambientGlow" aria-hidden />
      <div className="authHero">
        <p className="eyebrow">AI 短视频助手</p>
        <h1>让每家店都有自己的数字人口播</h1>
        <span className="authHeroRule" aria-hidden />
      </div>

      <form onSubmit={handleSubmit} className="authCard authForm">
        {verifyFailed && (
          <div className="authError" role="alert">
            验证码错误或已过期，请重新获取
          </div>
        )}
        {message && (
          <div className="authError" role="alert">
            {message}
          </div>
        )}

        <label className="field">
          <span>邮箱地址</span>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={loading}
          />
        </label>

        <button
          type="submit"
          disabled={loading || !email}
          className="primaryButton"
        >
          {loading ? "发送中..." : "发送验证码"}
        </button>

        <div className="authDivider">
          <span>其他登录方式</span>
        </div>

        <button
          type="button"
          onClick={() => signInWithWeChat()}
          className="secondaryButton authWechatButton"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#07C160" aria-hidden>
            <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 10.436 7.17c0-.651.52-1.18 1.162-1.18z" />
          </svg>
          微信登录
        </button>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="authPage" />}>
      <LoginForm />
    </Suspense>
  );
}
```

注意：`label.field` + 全局 `input` 样式直接吃体系（globals.css L86-126 已有全局 input 样式与 L537 `.field` 布局），**不再手写 Tailwind 色值类**。`id="email"` 保留使 `getByLabelText("邮箱地址")` 可用（label 包裹+span 文本即可关联，无需 htmlFor——label 包裹隐式关联）。

`app/globals.css` 登录区块追加：

```css
.authHero {
  margin-bottom: 32px;
  position: relative;
  text-align: center;
  z-index: 1;
}

.authHero .eyebrow {
  margin-bottom: 12px;
}

.authHero h1 {
  color: var(--title);
  font-size: clamp(1.6rem, 4vw, 2.2rem);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.2;
  margin: 0;
}

.authHeroRule {
  background: linear-gradient(90deg, transparent, rgba(59, 130, 246, 0.35), transparent);
  border-radius: 999px;
  display: block;
  filter: blur(8px);
  height: 2px;
  margin: 20px auto 0;
  width: min(280px, 60vw);
}

.authDivider {
  align-items: center;
  display: flex;
  gap: 12px;
  margin: 4px 0;
}

.authDivider::before,
.authDivider::after {
  background: var(--border);
  content: "";
  flex: 1;
  height: 1px;
}

.authDivider span {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}

.authWechatButton {
  gap: 8px;
}
```

`.authHero` 的 `margin-bottom: 32px;`（注意冒号，CSS 语法）。

- [ ] **Step 4: 全绿 + commit**

Run: `npx vitest run tests/login-page.test.tsx tests/login-page-error.test.tsx tests/login-actions.test.ts`
Expected: 全 PASS

```bash
git add app/login/page.tsx app/globals.css tests/login-page.test.tsx tests/login-page-error.test.tsx tests/login-actions.test.ts
git commit -m "feat(login): 登录页纳入设计体系——ambientGlow+品牌区 hero+体系卡片/按钮，删 Tailwind 孤岛类

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: 五件套 + 视觉验收

**Files:** 无新增（验证任务）

- [ ] **Step 1: 五件套全绿**

```bash
npm test && npm run typecheck && npm run lint && npx prisma validate && npm run build
```

Expected: 全部通过（测试数较第三批次基线 +10 左右）

- [ ] **Step 2: 本地起页 + Playwright 截图**

```bash
npm run dev
```

Playwright 截图四张（存 `research/login-ui-review/`）：
1. `/login` 正常态
2. `/login?error=Verification` 错误态
3. `/login/verify?email=a@b.com` 空码态
4. verify 页输入 6 位后的填满态（截图前向 OTP input 输入 123456）

demo 模式下 middleware 放行，两页均可直接访问。

- [ ] **Step 3: 用户肉眼验收**

向用户展示四张截图，确认视觉达标后再 push（push 即触发 Zeabur 自动部署，必须用户点头）。

---

## Self-Review 记录

- **Spec 覆盖**：spec 第 3 节（登录/verify 设计）→ Task 4/5/6；第 4 节 follow-ups 8 项 → Task 1（#1/2/3/4/5/11）+ Task 2（#6）+ Task 5（#7/8 部分）+ Task 6（#8 反枚举部分）；第 5 节 L0 限流 → Task 3；第 6 节测试策略 → 各任务 TDD + Task 7 视觉验收。✅ 全覆盖
- **类型一致性**：`OtpInput` props（value/onChange/onComplete/disabled）在 Task 4 定义、Task 5 消费一致；`buildOtpCallbackUrl(email, code)` Task 5 定义/测试一致；`rateLimitAuthNamespace`/`isAuthL0Exempt` Task 3 定义/middleware 消费一致 ✅
- **占位符**：无 TBD/TODO ✅
- **既有测试兼容**：`tests/login-verify.test.tsx` 的 placeholder 查询改 label 查询已在 Task 5 Step 1 显式说明；`tests/rate-limit.test.ts` 既有 OTP 用例仅追加 `_resetRedis()` 不改断言 ✅
