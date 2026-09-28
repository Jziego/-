# OOM 治理运行手册 — AI Video Assistant

> 4GB RAM VPS（Zeabur K3s，可用 ~3.5GB，基线占用 ~1.2GB）运行 PG + Redis + web + worker 全部四个组件。
> 本手册记录 2026-09-22 与 2026-09-27 两次 OOM 事故的根因、已落地的代码治理、以及**只能在云端手工完成**的配置项与应急流程。
> 相关代码提交：`008c1a8`（Task A 止血）/ `5f00c57`（Task B 流式化）/ `e5444b6`（Task C 数据层）。

---

## 1. 事故根因摘要

| 日期 | 现象 | 根因 |
|------|------|------|
| 09-22 | 服务离线、SSH 无响应 | 内存耗尽：V8 默认堆上限≈物理内存 75%（web+worker 两进程理论 ~6GB）、PG 连接池永不收缩、108 天慢性增长、启动尖峰叠加 |
| 09-27 | 视频渲染到一半服务器爆掉 | 渲染路径整文件进堆（下载 2×200MB + 成片 2-3× 拷贝）、worker 6 队列×并发 2 可同时跑两个渲染、ffmpeg 无限线程、BullMQ 3 次重试放大失败 |

## 2. 已落地的代码侧治理（随部署自动生效）

- **堆上限**：web `1024MB`（`package.json` start）、worker `1536MB`（Zeabur 服务变量 NODE_OPTIONS）——V8 提前 GC 而不是被 OOM-kill。2026-09-28 服务器 2C4GB→4C8GB 后从 768/1024 放宽，若降配须回落
- **talking_head 分段并发**：默认 3 路并行（`TALKING_HEAD_CONCURRENCY`，上限 4）——口播段耗时在 provider 服务端，本地只等待，并发后 talking_head 5min+ → ~2min；本地内存开销可忽略
- **成片预览 CDN**：设 `OBJECT_STORAGE_CDN_URL=https://cdn.你的域名`（Cloudflare R2 自定义域名，需先在 R2 面板绑定域名）后，预签名 URL 直接签在 CDN 域名上（R2 要求签名与访问域名一致，不能签完换 host），浏览器走 CF 边缘节点，根治跨境预览卡顿
- **worker 并发**：`video_render` 串行（concurrency 1），其余队列 2；`WORKER_CONCURRENCY` 环境变量可全局覆盖
- **ffmpeg `-threads 2`**：x264 线程不再吃满 4 核的 lookahead 帧队列（CRF 画质不变）
- **渲染全链路流式化**：输入下载直落盘（原 2× 文件大小在堆内）、成片流式上传（原 2-3× 拷贝）、底板 file_id 进程内缓存（7 天 TTL，MediaKit file_id 30 天有效的保险）
- **启动清扫**：worker 每次启动清理 /tmp 下闲置超 6 小时的 `render-*`/`tts-*`/`voice-sample-*`（SIGKILL 场景 finally 不执行的泄漏兜底）
- **7 个数据库索引**：Job/VideoOutput/Asset/ScriptDraft/AvatarProfile/RenderProject `(ownerId, createdAt)` + StoreProfile `(ownerId)`——5 秒轮询不再全表扫
- **PG 池空闲回收**：`idleTimeoutMillis: 30s`（原常驻 10 后端，空闲缩到各 1）
- **seed 一次性化**：`start:prod` 不再每次跑 seed（消掉每次重启的 tsx 临时进程）
- **列表/SSE 瘦身**：render-projects jobs/projects 各 limit 50；SSE 进度每秒只 select 4 列
- **限流免 TTL**：middleware L0 / 登录限流跳过多余的 `TTL` 往返（每次请求省 1-3 个 Redis RTT）；web 进程内 blacklist+rate-limit 共享一条 Redis 连接

## 3. 云端手工配置项（代码管不到，照此检查）

> **2026-09-27 事故后勘误（实测）**：
> 1. **容器内存无硬限制**——web/worker 容器 `/sys/fs/cgroup/memory.max` 均为 `max`；面板显示的 1024 只是占位，付费的「资源限制」功能是**加**上限，不是已有上限。**不必为此买套餐**；真正的堆上限由代码侧 NODE_OPTIONS 控制。
> 2. **worker 的 NODE_OPTIONS 必须走 Zeabur 服务环境变量**——Dockerfile `ENV` 在 Zeabur 构建管线中不会进入容器运行时（实测为空，ffmpeg/字体等其它 Dockerfile 指令正常）。web 侧无此问题（堆上限写在 `start:prod` 命令行里）。
> 3. **服务重启/重建 CLI**：`npx zeabur@latest service list --project-id 6a2388632fe98e0879e0d166` → `service restart --id <ID> -y`。机器重启后应用 pod 不会自动回来，按 PG → Redis → worker → web 顺序逐个点亮。
> 4. **构建失败先查时机**——整机内存打满时 docker build 会静默失败（deployment list 显示 FAILED，重试即可）；build log 需更高权限的 API key。
> 5. **09-27 复发根因**：当天 push 触发的 worker 构建在 OOM 中失败，**运行中的 worker 一直是旧镜像**——Task A/B/C 的保护一项都没生效。教训：部署后必须验证运行中的进程/变量与预期一致（本手册 §6 观察清单）。


### 3.1 Zeabur 服务内存限制（2026-09-27 实测：无需配置）
- 实测 web/worker 容器 `/sys/fs/cgroup/memory.max = max`（无硬限制）；面板上的 1024 是占位显示，付费「资源限制」功能是**可选地加**上限。
- 堆上限已由代码控制（web 1024MB / worker 1536MB，见 §2），**不必为此升级套餐**。
- 若未来想加保险，付费后在服务 Settings → Resources 设上限即可，但注意：上限必须**大于**堆上限 + 原生开销 + ffmpeg 子进程（渲染期约 1.2-1.6GB），worker 低于此值会导致每次渲染必炸容器。

### 3.2 Redis 容量护栏（已由 worker 启动自愈接管）
- Zeabur 托管 Redis 的 `/etc/redis-stack.conf` 是**只读挂载**（实测 CONFIG REWRITE 报 "Device or resource busy"），手工 CONFIG SET 在容器重启后丢失。
- **现由 worker 每次启动时自愈重设**：`maxmemory 512mb` + `noeviction`（`lib/queue.ts` `applyRedisGuardrails()`，可用 `REDIS_MAXMEMORY_BYTES` 覆盖）。必须 `noeviction`——BullMQ 队列流被 LRU 淘汰会丢任务。
- 若需立即生效而不等 worker 重启：`zeabur service exec --id <redis> -- sh -c 'redis-cli -a "$REDIS_PASSWORD" CONFIG SET maxmemory 536870912'`（noeviction 同理）。

### 3.3 Swap（9/22 救援时已加，重启机器后需确认仍在）
```bash
swapon --show                      # 期望看到 2G swap
# 若丢失（机器重建后）：
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl vm.swappiness=10            # 小内存机：尽量用满物理内存再进 swap
```

### 3.4 新数据库首次部署（seed 已改为手动）
```bash
npm run db:seed:on-start    # = prisma migrate deploy + prisma db seed（BGM 曲目 + demo_user）
```
漏跑的征兆：渲染时 BGM 下拉为空。随时可补跑，幂等。

## 4. OOM 应急流程

1. **确认**：Zeabur 面板看内存曲线（或 SSH `dmesg -T | grep -i oom`）。
2. **救援**：面板**重启机器但不勾选任何服务**（空载起来，基线 1.2GB）。
3. 依次点亮 **PG → Redis → web → worker**，每步盯内存表；worker 起来时会自动清扫残留临时目录（日志 `[worker] 清扫残留临时目录 N 个`）。
4. 检查磁盘：`df -h`——历史 OOM 泄漏的 render-* 若曾堆积会在这里现形（现已有启动清扫兜底）。

## 5. 画质/功能决策记录

- **服务端成片保持单次直通 H.264**（`-preset veryfast -crf 23`）：字幕烧入 + 拼接本就必需一次重编码；加 ProRes 代理中间文件在小内存机上**反向增加**内存/CPU 占用，与 OOM 治理目标冲突。
- ProRes 仅保留为「下载到本地剪辑」的可选导出格式的未来选项；实现时必须走流式 + 临时盘，不得整文件进堆。
- **BullMQ attempts 保持 3**：内存根因已由并发=1+流式化消除，保留重试弹性应对网络抖动等瞬态故障。

## 6. 观察清单（下次性能问题的第一站）

- Zeabur 面板：web/worker 内存曲线、渲染期间的峰值
- `redis-cli CLIENT LIST | wc -l`：web 2 条 + worker 13 条（6 Worker×2 + cron Queue）为基线
- `pg_stat_activity`：空闲时 web+worker 各 ≤1 条连接（`idleTimeoutMillis` 生效证据）
- worker 日志：`清扫残留临时目录` 出现 >0 即说明发生过 SIGKILL 泄漏
