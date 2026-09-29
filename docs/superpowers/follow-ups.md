# 后续打磨项（Follow-ups）

> 各批次评审中记录的 Minor 级问题，不阻塞功能，下一批次顺手捎带。

## 2026-09-27 第三批次（产物管理 UI + 登录 OTP）

> 本批次 11 条中 10 条已于 2026-09-28 在登录 UI 重做计划（`plans/2026-09-28-login-ui-redesign.md`）落盘，仅保留「OTP 撞库唯一索引备注」未勾（未来容量备注）。（来源：整体终审 2026-09-28）

### 产物删除端点
- [x] **404 文案中英统一**：`app/api/render-projects/outputs/[id]/route.ts` 返回中文「产物不存在」，同目录 `outputs/[id]/url/route.ts` 用英文 `"Output not found"`，全 API 以英文为主。建议统一为 `"Output not found"`（中文留给前端本地化层）。（来源：Task 2 质量评审 Minor #2）
- [x] **路由层 try/catch 与 storage 层契约重复**：`lib/storage.ts` 的 `deleteObject` 契约是"错误内部消化、永不 reject"，路由层 catch 实际不可达，真实故障会双份 warn 日志。保留=防御性契约变化，删除=与素材删除端点一致。需拍板。（来源：Task 2 质量评审 Minor #1）

### 网格卡片
- [x] **`.outputCover` 硬编码 9/16**：`VideoOutput.aspectRatio` 允许 `1:1`/`16:9`，非竖屏成片会被裁切。后续可按 aspectRatio 换 class 或改 `object-fit: contain`。（来源：Task 3 质量评审 Minor #4）
- [x] **测试时区隐患**：`tests/render-output-card.test.tsx` 的 `/09-27/` 断言依赖本地时区（UTC 负时区会显示 09-26）。建议 mock 时区或放宽断言。（来源：Task 3 规格评审 suggestion）

### 登录 / OTP
- [x] **dev fallback 不打印 URL**：`auth.ts` OTP dev fallback 只打印 `email → token`，本地 dev 需手工拼 callback URL。建议连 `url` 一起打印（旧 magic-link 实现本就打印等价凭证）。（来源：Task 4 质量评审 Minor #2）
- [x] **文件名语义过期**：`lib/auth/magic-link-email.ts` / `tests/magic-link-email.test.ts` 已改为 OTP 语义，文件名仍是旧名。建议改名 `otp-email.ts`。（来源：Task 4 质量评审 Minor #1）
- [x] **verify 页倒计时 interval 无 unmount 清理**：冷却中途离开页面泄漏单个 interval（React 18+ 无实际危害）。建议改 `useEffect` + `setTimeout` 驱动。（来源：Task 6 质量评审 Minor）
- [x] **登录/verify 页测试缺口**：verify 页缺失 email 兜底分支、重发冷却、submit URL 构造的覆盖；`sendMagicLink` 反枚举属性（无效邮箱/限流/正常三种路径同文案）值得补用例锁定。（来源：Task 6 质量评审 Minor）
- [ ] **OTP 撞库唯一索引备注**：6 位码空间 1e6，两位用户同时请求撞同一码 → `createVerificationToken` 唯一冲突 → 该次登录失败（重试即可）。当前用户量概率可忽略，未来容量上升需关注。（来源：Task 4 质量评审 Minor #3）

### 安全加固（单独评估）
- [x] **auth 端点命名空间整体 L0**：整个 `/api/auth/*`（sign-in/csrf/session）无 IP 级限流，缺 email 参数的 callback 请求可零限流打 DB。属预存在命名空间级问题，OTP 校验端点已由专项限流覆盖；建议作为独立安全任务评估。（来源：Task 5 质量评审 Minor #1）
- [x] **OTP 测试隔离改显式复位**：`tests/rate-limit.test.ts` 的 OTP describe 位置依赖"先于 Redis-mock describe"避免共享连接缓存污染，建议加显式 `_resetRedis()` 变位置依赖为契约。（来源：Task 5 质量评审 Minor #2）

---

## 2026-09-28 第四批次（登录 UI 重做后 hotfix）

### 登录 / OTP
- [ ] **EMAIL_FROM 落 resend.dev 沙箱域**：生产未设 `EMAIL_FROM` 时默认 `noreply@resend.dev`——Resend 沙箱模式只许发给账号本人邮箱，其他地址 API 层被拒（旧邮箱=账号主邮箱能收，新邮箱全丢）。**需验证自有域名**（如 `mail.jziego.win`）并在 Zeabur 设 `EMAIL_FROM=AI短视频助手 <noreply@mail.jziego.win>`。（来源：静默丢信 hotfix 2026-09-28）
- [ ] **OTP 登录不回跳原路径**：middleware 登出带 `callbackUrl=<原路径>`，登录页忽略、verify 硬编码 `/`，被踢出用户落首页。下一批次 login 页透传即可。（来源：整体终审 Minor #2）
- [ ] **Tailwind 死依赖**：全仓已零 Tailwind 类/`cn()`，`tailwindcss`+`tailwind-merge` 可卸载，CLAUDE.md 技术栈行同步更新。（来源：整体终审 Minor #4）

---

**格式约定**：新增条目注明来源（哪个批次的哪种评审），处理完打勾不删除（或归档到批次段落底部）。
