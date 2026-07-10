#!/usr/bin/env bash
# ============================================
# verify-zeabur-preview.sh
# 验证 Zeabur 部署上「产物预览」功能端到端可用。
#
# 在 push main 触发 Zeabur 重建并构建完成后运行：
#   bash scripts/verify-zeabur-preview.sh https://<your-zeabur-web>.zeabur.app
#
# 环境变量（可选）:
#   AUTH_COOKIE   - 生产模式(APP_MODE=production)下登录态 Cookie，如 'next-auth.session-token=...'
#                   demo 模式无需设置（ownerId 解析为 demo_user）。
#   HTTPS_PROXY   - 若本机走 Clash 代理(127.0.0.1:7892)访问外网，curl 会自动读取此变量。
#
# 退出码: 0=全部通过, 1=有失败项。
# ============================================
set -uo pipefail

# ── 颜色 / 计数 ────────────────────────────────
PASS=0; FAIL=0; WARN=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
warn() { echo "  ⚠️  $1"; WARN=$((WARN+1)); }

# ── 参数 ───────────────────────────────────────
BASE_URL="${1:-${ZEABUR_WEB_URL:-}}"
if [ -z "$BASE_URL" ]; then
  echo "用法: bash scripts/verify-zeabur-preview.sh <BASE_URL>"
  echo "  例: bash scripts/verify-zeabur-preview.sh https://ai-video-assistant.zeabur.app"
  echo "  或: ZEABUR_WEB_URL=https://... bash scripts/verify-zeabur-preview.sh"
  exit 2
fi
BASE_URL="${BASE_URL%/}"          # 去掉尾部斜杠
AUTH_COOKIE="${AUTH_COOKIE:-}"

echo "=== Zeabur 产物预览 验证 ==="
echo "目标: $BASE_URL"
echo "模式: $([ -n "$AUTH_COOKIE" ] && echo '带 Cookie(生产模式)' || echo '无 Cookie(demo 模式)')"
echo ""

# ── 临时文件 ───────────────────────────────────
TMP="$(mktemp -d)"
BODY="$TMP/body"; HEADERS="$TMP/headers"
trap 'rm -rf "$TMP"' EXIT

# 公共请求头
HDRS=()
[ -n "$AUTH_COOKIE" ] && HDRS+=(-H "Cookie: $AUTH_COOKIE")

# fetch <method> <path> [extra curl args...]  → 打印 HTTP code, body→$BODY, 头→$HEADERS
fetch() {
  local method="$1" path="$2"; shift 2
  curl -sS -X "$method" "${HDRS[@]}" -o "$BODY" -D "$HEADERS" \
    -w "%{http_code}" "$@" "$BASE_URL$path"
}

# 从 $BODY 取 dotted JSON path 的值（失败返回空）
jpath() {
  node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));let v=j;for(const k of (process.argv[1]||"").split(".")){if(v==null)break;v=v[k];}if(v==null)process.exit(0);process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v));' \
    "$1" < "$BODY" 2>/dev/null
}

content_type() {
  grep -i '^content-type:' "$HEADERS" 2>/dev/null | head -1 | tr -d '\r' | cut -d' ' -f2-
}

# ── 1. 健康检查 ─────────────────────────────────
echo "[1/4] 健康检查  GET /api/health"
code="$(fetch GET /api/health || true)"
if [ "$code" = "200" ]; then
  mode="$(jpath mode)"
  status="$(jpath status)"
  db="$(jpath checks.database)"
  redis="$(jpath checks.redis)"
  os="$(jpath checks.objectStorage)"
  echo "    mode=$mode  status=$status  db=$db  redis=$redis  objectStorage=$os"
  ok "health 200 (mode=$mode)"
  if [ "$os" != "configured" ]; then
    bad "对象存储未配置(objectStorage=$os) — presigned URL 无法生成，预览不可用"
  fi
  if [ "$mode" = "production" ] && [ -z "$AUTH_COOKIE" ]; then
    warn "生产模式但未设 AUTH_COOKIE — 后续 /api 调用可能 401"
  fi
else
  bad "health 非 200 (code=$code)"
  echo "    body: $(head -c 200 "$BODY" 2>/dev/null)"
fi
echo ""

# ── 2. 新路由是否已部署（关键：区分 404-JSON 与 404-HTML） ──
echo "[2/4] 新路由部署探测  GET /api/render-projects/outputs/<probe>/url"
code="$(fetch GET /api/render-projects/outputs/output_nonexistent_probe_xyz/url || true)"
ct="$(content_type)"
if [ "$code" = "404" ] && echo "$ct" | grep -qi 'application/json'; then
  err="$(jpath error)"
  ok "路由已部署: 未知 id 返回 404 JSON (error=\"$err\") — IDOR/not-found 守卫生效"
elif [ "$code" = "404" ] && echo "$ct" | grep -qi 'text/html'; then
  bad "路由未部署: 返回 HTML 404 页 — Zeabur 仍在跑旧构建，等待重建完成或确认 push 已生效"
elif [ "$code" = "401" ] || [ "$code" = "403" ]; then
  bad "鉴权失败 (code=$code) — 设 AUTH_COOKIE 后重试"
else
  bad "预期 404 JSON，实得 code=$code content-type=$ct"
  echo "    body: $(head -c 200 "$BODY" 2>/dev/null)"
fi
echo ""

# ── 3. 产物列表 ─────────────────────────────────
echo "[3/4] 产物列表  GET /api/render-projects"
code="$(fetch GET /api/render-projects || true)"
READY_IDS=()
if [ "$code" = "200" ]; then
  total="$(node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String((j.outputs||[]).length));' < "$BODY" 2>/dev/null || echo "?")"
  READY_IDS=("$(node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));(j.outputs||[]).filter(x=>x.kind==="final_composite"&&x.status==="ready").forEach(x=>console.log(x.id));' < "$BODY" 2>/dev/null)")
  ready_count="$(printf '%s\n' "${READY_IDS[@]}" | grep -c . || true)"
  ok "outputs 返回 200 (共 $total 个产物, $ready_count 个 ready final_composite)"
else
  bad "render-projects 非 200 (code=$code)"
  echo "    body: $(head -c 200 "$BODY" 2>/dev/null)"
fi
echo ""

# ── 4. 逐个验证 presigned GET URL 真能取到视频 ────
echo "[4/4] 产物预览 URL 端到端"
if [ "${#READY_IDS[@]}" -eq 0 ] || [ -z "${READY_IDS[0]}" ]; then
  warn "没有可测的完成产物。先在 dashboard 跑一次「一键成片」，等 video_render Completed 后重跑本脚本。"
else
  for id in "${READY_IDS[@]}"; do
    [ -z "$id" ] && continue
    echo "  · output $id"
    code="$(fetch GET "/api/render-projects/outputs/$id/url" || true)"
    if [ "$code" != "200" ]; then
      bad "取 URL 失败 (code=$code)"
      echo "      body: $(head -c 200 "$BODY" 2>/dev/null)"
      continue
    fi
    url="$(jpath url)"
    if [ -z "$url" ]; then
      bad "返回 200 但无 url 字段"
      continue
    fi
    ok "  presigned URL 已签发"
    # 用 Range 只取首字节，避免下载整段视频
    rcode="$(curl -sS -o "$TMP/rbody" -D "$HEADERS" -w "%{http_code}" \
      -H "Range: bytes=0-1023" "$url" || true)"
    rct="$(content_type)"
    if [ "$rcode" = "200" ] || [ "$rcode" = "206" ]; then
      ok "  R2 取片成功 (code=$rcode, content-type=$rct)"
    else
      bad "R2 取片失败 (code=$rcode, content-type=$rct)"
      echo "      url: $url"
    fi
  done
fi
echo ""

# ── 汇总 ───────────────────────────────────────
echo "=== 汇总: ✅ $PASS 通过  ❌ $FAIL 失败  ⚠️  $WARN 警告 ==="
echo ""
echo "下一步（人工）: 打开 $BASE_URL ，跑「一键成片」，完成后在 dashboard 底部「产物预览」区"
echo "确认 <video controls> 能播放、下载链接能下载。脚本只覆盖 API 层，UI 播放需肉眼确认。"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
