#!/usr/bin/env bash
# ============================================
# DeepSeek V4-Pro Max Thinking 模式配置模板
# 用法: 每次 Claude Code 更新后运行此脚本
#   bash setup-deepseek-max-thinking.sh
# ============================================
set -euo pipefail

SETTINGS_FILE="$HOME/.claude/settings.json"

echo "=== DeepSeek V4-Pro Max Thinking 配置 ==="
echo ""

# ── 1. 检查 settings.json ──────────────────────
echo "[1/2] 检查 settings.json ..."

REQUIRED_KEYS=(
  '"model": "opus"'
  '"alwaysThinkingEnabled": true'
  '"effortLevel": "xhigh"'
)

for key in "${REQUIRED_KEYS[@]}"; do
  if grep -q "$key" "$SETTINGS_FILE" 2>/dev/null; then
    echo "  ✅ $key"
  else
    echo "  ❌ 缺失: $key"
    MISSING=true
  fi
done

if [ "${MISSING:-false}" = true ]; then
  echo ""
  echo "  ⚠️  请手动确保 $SETTINGS_FILE 包含以下内容:"
  echo '  {'
  echo '    "model": "opus",'
  echo '    "alwaysThinkingEnabled": true,'
  echo '    "effortLevel": "xhigh"'
  echo '  }'
fi

# ── 2. 检查 PowerShell Profile ────────────────
echo ""
echo "[2/2] 检查 PowerShell Profile ..."

PROFILE_PATH="$HOME/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1"

REQUIRED_ENV=(
  'ANTHROPIC_BASE_URL'
  'ANTHROPIC_AUTH_TOKEN'
  'ANTHROPIC_DEFAULT_OPUS_MODEL'
  'ANTHROPIC_DEFAULT_SONNET_MODEL'
  'ANTHROPIC_DEFAULT_HAIKU_MODEL'
  'CLAUDE_CODE_SUBAGENT_MODEL'
  'CLAUDE_CODE_EFFORT_LEVEL'
)

FORBIDDEN_ENV=(
  'ANTHROPIC_MODEL'
)

for var in "${REQUIRED_ENV[@]}"; do
  if grep -q "\$env:$var" "$PROFILE_PATH" 2>/dev/null; then
    echo "  ✅ $var"
  else
    echo "  ❌ 缺失: $var"
  fi
done

for var in "${FORBIDDEN_ENV[@]}"; do
  if grep -q "^\$env:$var" "$PROFILE_PATH" 2>/dev/null; then
    echo "  🔴 必须注释掉: $var (会导致 thinking 参数不发送)"
  else
    echo "  ✅ $var 已注释或不存在"
  fi
done

echo ""
echo "=== 配置检查完成 ==="
echo ""
echo "重启 Claude Code 生效。"
echo "验证: claude --debug api -p 'hello' 2>&1 | Select-String thinking"
