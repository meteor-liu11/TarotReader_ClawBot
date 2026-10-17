#!/usr/bin/env bash
# ════════════════════════════════════════════════════════
# 反复生成微信登录二维码，直到扫码成功。
#
# 为什么需要这个包装：插件内部的 MAX_QR_REFRESH_COUNT = 3，
# 二维码每次约 1 分钟过期，刷 3 次（约 4 分钟）之内没扫上就整个退出。
# 人在忙别的事很容易错过，所以这里在失败后自动重开。
#
# 用法：  bash demo/scripts/wechat-login.sh
# 多账号：CHANNEL=openclaw-weixin ACCOUNT=work bash demo/scripts/wechat-login.sh
# ════════════════════════════════════════════════════════
set -uo pipefail

CHANNEL="${CHANNEL:-openclaw-weixin}"
ACCOUNT="${ACCOUNT:-}"

args=(channels login --channel "$CHANNEL")
if [ -n "$ACCOUNT" ]; then
  args+=(--account "$ACCOUNT")
fi

attempt=0
while true; do
  attempt=$((attempt + 1))
  printf '\n\033[1m── 第 %d 次生成二维码（扫不上会自动重来，不用急）──\033[0m\n\n' "$attempt"

  if openclaw "${args[@]}"; then
    printf '\n\033[32m✅ 微信登录成功，凭证已保存。\033[0m\n'
    printf '下一步：openclaw channels status --probe\n\n'
    exit 0
  fi

  printf '\n\033[33m二维码过期了，3 秒后重新生成…（Ctrl+C 可退出）\033[0m\n'
  sleep 3
done
