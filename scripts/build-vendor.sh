#!/usr/bin/env bash
# 重新產生 vendor/anthropic-sdk.js
#
# 決策: SDK 打包成單一 IIFE 檔並 commit 進 repo，擴充執行時不從網路載入任何程式碼
# 決策: 版本固定、停用安裝腳本（--ignore-scripts），降低供應鏈風險
# 注意: 升級版本前先確認該版本已發佈至少兩週；升級後要更新 README 的版本與 SHA-256
set -euo pipefail

SDK_VERSION="1.3.0"
ESBUILD_VERSION="0.28.2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
npm init -y >/dev/null
npm install --ignore-scripts --no-audit --no-fund --save-exact \
  "@anthropic-ai/sdk@${SDK_VERSION}" "esbuild@${ESBUILD_VERSION}" >/dev/null

cat > entry.js << 'ENTRY'
// 把 SDK 掛到 service worker 的全域，讓 background.js 以 importScripts 載入（classic worker 不能用 import）
import Anthropic from '@anthropic-ai/sdk'
globalThis.Anthropic = Anthropic
ENTRY

./node_modules/.bin/esbuild entry.js --bundle --format=iife --platform=browser \
  --target=chrome120 --legal-comments=inline --outfile="$ROOT/vendor/anthropic-sdk.js"

shasum -a 256 "$ROOT/vendor/anthropic-sdk.js"
