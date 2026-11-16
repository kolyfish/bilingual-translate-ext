#!/usr/bin/env bash
# 打包成兩種檔案，輸出到 dist/
#
#   bilingual-translate-v<版本>.zip         給朋友的安裝包：extension/ + Mac/Windows 安裝程式 + 安裝說明
#   bilingual-translate-store-v<版本>.zip   上架 Chrome 線上應用程式商店用：只有執行需要的檔案，manifest 在 zip 根目錄
#
# 決策: 兩種包都只放執行需要的檔案（跟 deploy-local.sh 同一套排除規則），測試、文件、腳本、git 資料都不帶
# 注意: 原始碼在 exFAT 上權限位元不正確，打包前統一改成檔案 644、資料夾 755、安裝程式 755
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(grep -m1 '"version"' "$ROOT/manifest.json" | sed -E 's/.*"([0-9.]+)".*/\1/')"
DIST="$ROOT/dist"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

RUNTIME_FILTERS=(
  --exclude '.git' --exclude '.gitignore' --exclude '._*' --exclude '.DS_Store'
  --exclude 'tests' --exclude 'docs' --exclude 'scripts' --exclude 'packaging' --exclude 'dist'
  --exclude '*.md'
)

normalize_perms() {
  find "$1" -type d -exec chmod 755 {} +
  find "$1" -type f -exec chmod 644 {} +
}

# Windows 的批次檔與記事本要 CRLF 換行
to_crlf() {
  perl -pe 's/\r?\n/\r\n/' "$1" > "$2"
}

mkdir -p "$DIST"

# ---------- 商店上架用 ----------
STORE="$STAGE/store"
rsync -a "${RUNTIME_FILTERS[@]}" "$ROOT/" "$STORE/"
normalize_perms "$STORE"
STORE_ZIP="$DIST/bilingual-translate-store-v${VERSION}.zip"
rm -f "$STORE_ZIP"
(cd "$STORE" && zip -qrX "$STORE_ZIP" .)

# ---------- 給朋友的安裝包 ----------
PKG="$STAGE/friend/bilingual-translate"
mkdir -p "$PKG"
rsync -a "${RUNTIME_FILTERS[@]}" "$ROOT/" "$PKG/extension/"
cp "$ROOT/packaging/install-mac.command" "$PKG/Install-Mac.command"
to_crlf "$ROOT/packaging/install-windows.bat" "$PKG/Install-Windows.bat"
to_crlf "$ROOT/packaging/INSTALL.txt" "$PKG/INSTALL.txt"
normalize_perms "$PKG"
chmod 755 "$PKG/Install-Mac.command"
FRIEND_ZIP="$DIST/bilingual-translate-v${VERSION}.zip"
rm -f "$FRIEND_ZIP"
(cd "$STAGE/friend" && zip -qrX "$FRIEND_ZIP" bilingual-translate)

# exFAT 會在 dist/ 產生 ._ 影子檔，清掉避免誤傳
find "$DIST" -name '._*' -delete

echo "版本 v${VERSION}"
for f in "$FRIEND_ZIP" "$STORE_ZIP"; do
  printf '%s  %s  %s\n' "$(du -h "$f" | cut -f1)" "$(shasum -a 256 "$f" | cut -c1-16)" "$f"
done
