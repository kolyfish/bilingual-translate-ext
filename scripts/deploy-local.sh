#!/usr/bin/env bash
# 把擴充部署到內建磁碟，讓 Chrome 從這裡載入
#
# 決策: 原始碼可以放外接碟，但外接碟是 exFAT（沒有檔案權限、沒有加密，任何程式都能改），
#       Chrome 實際執行的那份放到內建 APFS 磁碟（FileVault 加密），而且部署後設成唯讀
# 注意: 改完程式碼要重跑這支腳本，再到 chrome://extensions 按重新載入
#
# 用法:
#   scripts/deploy-local.sh            部署到 ~/Extensions/bilingual-translate-ext
#   scripts/deploy-local.sh --verify   檢查已部署的檔案是否跟原始碼一致（有沒有被改過）
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Extensions/bilingual-translate-ext"

# 只部署執行需要的檔案；測試、文件、腳本、git 資料都不放進 Chrome 會載入的資料夾
RSYNC_FILTERS=(
  --exclude '.git' --exclude '.gitignore' --exclude '._*' --exclude '.DS_Store'
  --exclude 'tests' --exclude 'docs' --exclude 'scripts' --exclude 'packaging' --exclude 'dist'
  --exclude '*.md'
)

if [[ "${1:-}" == "--verify" ]]; then
  if [[ ! -d "$DEST" ]]; then
    echo "還沒部署：$DEST 不存在"
    exit 1
  fi
  # 只比對內容（--checksum），不比權限與時間：部署時刻意把權限改成唯讀，跟原始碼本來就不同
  diff_out="$(rsync -r --dry-run --checksum --delete --itemize-changes "${RSYNC_FILTERS[@]}" "$SRC/" "$DEST/" | grep -v '^\.d' || true)"
  if [[ -z "$diff_out" ]]; then
    echo "一致：$DEST 跟原始碼相同"
  else
    echo "不一致，以下檔案不同（可能被改過，或原始碼更新後還沒重新部署）："
    echo "$diff_out"
    exit 1
  fi
  exit 0
fi

mkdir -p "$DEST"
# 上次部署設成唯讀了，先打開寫入權限才能更新
chmod -R u+w "$DEST"
rsync -a --delete --checksum "${RSYNC_FILTERS[@]}" "$SRC/" "$DEST/"

# exFAT 來源沒有正確的權限位元，統一改成唯讀：檔案 444、資料夾 555
find "$DEST" -type f -exec chmod 444 {} +
find "$DEST" -type d -exec chmod 555 {} +

version="$(grep -m1 '"version"' "$DEST/manifest.json" | sed -E 's/.*"([0-9.]+)".*/\1/')"
fingerprint="$(cd "$DEST" && find . -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -c1-16)"
echo "已部署 v${version} 到：$DEST"
echo "檔案指紋：${fingerprint}"
echo "Chrome 請從這個資料夾載入（chrome://extensions → 載入未封裝項目）"
