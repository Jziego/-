# Route C Phase 2 — 真实对象存储（执行总结）

**日期：** 2026-06-09  
**状态：** ✅ 已完成（任务 2.1–2.8）  
**前置：** Phase 0 + Phase 1（护栏、PostgreSQL 持久化、Dashboard API 读写）  
**设计文档：** `docs/superpowers/specs/2026-06-08-route-c-production-launch-design.md` § Phase 2

---

## 目标

用户通过浏览器上传真实视频/图片，文件存入 S3 兼容对象存储，服务端写入带 `storageKey` 的 `Asset` 记录，并可继续触发 `analyze`。

**验收标准（已达成）：** 上传 mp4/图片 → 对象存储有文件 → DB 有 Asset → analyze 可读 `storageKey`。

---

## 任务完成情况

| 任务 | 内容 | 状态 |
|------|------|------|
| 2.1 | `lib/storage.ts`：S3 客户端、presigned PUT、HeadObject、`forcePathStyle` | ✅ |
| 2.2 | `hasObjectStorage()` 环境守卫；未配置时上传 API 返回 503 | ✅ |
| 2.3 | `POST /api/assets/upload-intent` 签发真实 presigned URL | ✅ |
| 2.4 | `POST /api/assets/confirm`：HeadObject 校验后写入 Asset | ✅ |
| 2.5 | Dashboard：`<input type="file">`、进度条、`confirmAssetUpload`（不再 `saveAsset` 假上传） | ✅ |
| 2.6 | 本地 MinIO：`docker-compose.yml` + `docker/minio-cors.json` | ✅ |
| 2.7 | 测试：`upload-intent`、`assets-confirm`、storage 单元测试 | ✅ |
| 2.8 | 文档：README（MinIO + R2/Zeabur）、Skill API 地图 | ✅ |

---

## 实现要点

### 存储层（`lib/storage.ts`）

- `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
- `createPresignedPutUrl`：PUT 预签名，默认过期 900s
- `headObject`：confirm 前校验对象存在、大小与 MIME
- `forcePathStyle: true`（兼容 MinIO / R2）
- 上传限制：`MAX_UPLOAD_BYTES = 200MB`；MIME 白名单 `video/`、`image/`、`audio/`

### 环境守卫（`lib/env.ts`）

```typescript
hasObjectStorage() // 检查 OBJECT_STORAGE_ENDPOINT / BUCKET / ACCESS_KEY / SECRET_KEY
```

- `upload-intent`、`confirm` 在未配置时返回 **503**
- 生产模式禁止返回 `object-storage.local` 等假 URL

### API 流程

```
POST /api/assets/upload-intent  →  presigned PUT URL + storageKey
浏览器 PUT 文件到对象存储
POST /api/assets/confirm        →  HeadObject 校验 → 创建 Asset（status=uploaded）
POST /api/assets/analyze        →  触发素材分析
```

### Dashboard（`components/dashboard.tsx`）

- 真实文件选择器 + 上传进度
- 客户端封装：`lib/api-client.ts` → `confirmAssetUpload`

### 本地 MinIO

```bash
docker compose up -d
```

| 项 | 值 |
|----|-----|
| API | `http://127.0.0.1:9000` |
| Console | `http://127.0.0.1:9001` |
| 凭据 | `minioadmin` / `minioadmin` |
| 桶 | `ai-video-assistant` |
| CORS | `MINIO_API_CORS_ALLOW_ORIGIN` + `minio-init` 应用 `docker/minio-cors.json` |

### 健康检查

`GET /api/health` 的 `checks.objectStorage`：`configured` | `missing`

---

## 验证结果

| 检查项 | 结果 |
|--------|------|
| `npm test` | **56/56** 通过 |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过（含 `/api/assets/confirm` 路由） |
| `GET /api/health` | `objectStorage: configured` |
| API E2E（MinIO） | **SUCCESS** |

### API 链端到端（MinIO）

1. `POST /api/assets/upload-intent` → 获得 presigned URL  
2. `PUT test-upload.mp4`（16 字节）到 MinIO  
3. `POST /api/assets/confirm` → Asset `sizeBytes=16`，`status=uploaded`  
4. `POST /api/assets/analyze` → 分析记录已创建  

---

## 生产部署清单（Zeabur + Cloudflare R2）

1. 在 Cloudflare R2 创建桶 `ai-video-assistant`
2. 创建 S3 兼容 API Token（读/写）
3. 桶 CORS 配置：
   - Methods：`PUT`、`GET`、`HEAD`
   - Headers：`Content-Type`
   - Origins：`https://<your-zeabur-domain>`
4. 在 Zeabur Web 服务注入环境变量：

| 变量 | 说明 |
|------|------|
| `OBJECT_STORAGE_ENDPOINT` | `https://<account_id>.r2.cloudflarestorage.com` |
| `OBJECT_STORAGE_BUCKET` | `ai-video-assistant` |
| `OBJECT_STORAGE_ACCESS_KEY_ID` | R2 Access Key |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | R2 Secret Key |
| `OBJECT_STORAGE_REGION` | `auto` |
| `OBJECT_STORAGE_PUBLIC_URL` | 可选，CDN 公网前缀 |
| `APP_MODE` | 正式上线时设为 `production` |

5. 确认 `GET /api/health` 显示 `objectStorage: configured`

详细步骤见项目根目录 `README.md` § Object Storage (Phase 2)。

---

## 浏览器自测清单

- [ ] `docker compose up -d`，`.env` 指向 MinIO（`127.0.0.1:9000`）
- [ ] 完成门店档案三步 → `#media-upload` 区域解锁
- [ ] 选择小视频/图片 → 进度条完成 → 素材库显示文件名
- [ ] DevTools 控制台无 hydration 报错
- [ ] （生产）Zeabur 域名下重复上述上传流程，确认 R2 CORS 无误

---

## 已知问题与阻塞项

| 项 | 说明 |
|----|------|
| **阻塞** | API / 测试 / 构建：**无阻塞** |
| **生产浏览器上传** | 需在 R2 为 Zeabur 域名配置 CORS，否则 PUT 会被浏览器拦截 |
| **Hydration** | 曾在 `dashboard.tsx` hero 区域观察到 SSR/客户端不一致警告；与上传逻辑无关，建议在 Phase 3 前单独修复（见 Skill 故障排查） |

---

## 后续建议

1. **上线前**：完成 R2 CORS + 真实域名浏览器上传验证  
2. **Hydration**：首屏与 SSR 对齐，localStorage/API 数据在 mount 后恢复  
3. **运维**：R2 生命周期策略、密钥轮换；大文件可考虑 multipart（Phase 3+）  
4. **下一阶段**：Phase 3 — Worker 服务 + BullMQ 作业生命周期（渲染/训练真正执行）

---

## 关键文件索引

```
lib/storage.ts                    # S3 presigned PUT、HeadObject
lib/env.ts                        # hasObjectStorage()
lib/api-client.ts                 # confirmAssetUpload
app/api/assets/upload-intent/     # 上传意图
app/api/assets/confirm/           # 确认上传
app/api/health/route.ts           # objectStorage 检查
components/dashboard.tsx          # 文件上传 UI
docker-compose.yml                # 本地 MinIO
docker/minio-cors.json            # 桶 CORS
tests/api/upload-intent.test.ts
tests/api/assets-confirm.test.ts
```

---

## 相关文档

- Phase 0 + 1 计划：`docs/superpowers/plans/2026-06-08-route-c-phase0-phase1.md`
- 上线路径总设计：`docs/superpowers/specs/2026-06-08-route-c-production-launch-design.md`
- 领域 Skill：`.cursor/skills/ai-video-assistant/SKILL.md`
