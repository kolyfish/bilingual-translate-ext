#!/bin/bash
# 雙語對照翻譯：Mac 安裝程式
#
# 決策: Chrome 不允許從商店以外一鍵安裝（.crx 會被封鎖、--load-extension 在 Chrome 137 移除），
#       所以這支腳本做到「能自動的都自動」：放好檔案、打開擴充頁面、把路徑放進剪貼簿，
#       最後「載入未封裝項目」那一下要使用者自己點
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Extensions/bilingual-translate-ext"

echo "== 雙語對照翻譯 安裝程式 =="

if [[ ! -f "$HERE/extension/manifest.json" ]]; then
  echo "找不到 extension 資料夾。請先把整個 zip 解壓縮，再執行這個安裝程式。"
  read -r -p "按 Enter 關閉…"
  exit 1
fi

mkdir -p "$HOME/Extensions"
# 重新安裝（更新）時先移除舊版；舊版可能是唯讀，先打開寫入權限
if [[ -d "$DEST" ]]; then
  chmod -R u+w "$DEST"
  rm -rf "$DEST"
fi
cp -R "$HERE/extension" "$DEST"
# 設成唯讀，避免被其他程式誤改（Chrome 只需要讀）
find "$DEST" -type f -exec chmod 444 {} +
find "$DEST" -type d -exec chmod 555 {} +

printf '%s' "$DEST" | pbcopy
echo "已安裝到：$DEST"
echo "這個路徑已經複製到剪貼簿。"
echo

if [[ -d "/Applications/Google Chrome.app" ]]; then
  open -a "Google Chrome" "chrome://extensions" || echo "請自己打開 Chrome，在網址列輸入 chrome://extensions"
else
  echo "找不到 Google Chrome，請先安裝 Chrome。"
fi

cat << 'STEPS'
接下來在 Chrome 的「擴充功能」頁面：
  1. 打開右上角的「開發人員模式」
  2. 點左上角「載入未封裝項目」
  3. 在選資料夾的視窗按 ⌘ + Shift + G，再按 ⌘ + V 貼上路徑，按 Enter
  4. 按「選取」
完成後，工具列會出現紅色「譯」字圖示（沒看到的話，點拼圖圖示把它釘選出來）。

以後要更新：用新版的安裝包再跑一次這個程式，然後在擴充功能頁面按 ↻。
STEPS
echo
read -r -p "按 Enter 關閉這個視窗…"
