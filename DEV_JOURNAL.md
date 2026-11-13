# 開發者設計精華日誌

## 專案概覽
- 目的：Chrome 擴充套件，做「網頁雙語對照」與「YouTube 即時雙語字幕」
- 核心功能：
  1. 網頁：英文段落上方或下方插入中文譯文，暗黃底色
  2. YouTube：讀取英文 CC 字幕，在其下方顯示中文
- 技術棧：Chrome Extension Manifest V3、原生 JavaScript（無建置工具）、Google gtx 翻譯端點

## 架構設計

### 目錄結構
```
bilingual-translate-ext/
├── manifest.json        # MV3 宣告：權限、service worker、content script 載入順序
├── background.js        # 翻譯代理（service worker）：引擎登錄表、快取、逾時
├── content-shared.js    # 內容腳本共用層：window.BT 命名空間、狀態、佇列、翻譯呼叫
├── content-page.js      # 網頁模式：找文字塊、懶翻譯、插入譯文
├── content-youtube.js   # YouTube 模式：讀取 CC 英文、顯示譯文 overlay
├── content-index.js     # 入口：讀取設定、依網站分流、統一 start/stop
├── style.css            # 譯文樣式（.bt-zh 網頁、.bt-yt-zh YouTube）
├── popup.html/js        # 工具列彈窗：開關 + 譯文位置，寫入 storage.sync
└── DEV_JOURNAL.md       # 本檔
```

### 模組職責
| 模組 | 職責 | 不做的事 |
|------|------|----------|
| `popup` | 讀寫 `enabled`、`position` 設定 | 不碰頁面 DOM |
| `content-index` | 讀設定、分流網站、啟停、設定變更時重建 | 不包含 DOM 掃描邏輯 |
| `content-shared` | 狀態、佇列（併發 4）、節流、`translate()` 訊息封裝 | 不知道網頁或 YouTube 的結構 |
| `content-page` | 找最內層文字塊、IntersectionObserver、插入網頁譯文 | 不處理 YouTube |
| `content-youtube` | 讀 `.ytp-caption-segment`、維護 overlay | 不處理一般網頁 |
| `background` | 呼叫翻譯引擎、快取、逾時 | 不碰頁面 DOM |
| `style.css` | 視覺樣式 | 無邏輯 |

### 載入順序（重要）
`manifest.json` 的 `content_scripts.js` 陣列依序執行：
`content-shared` → `content-page` / `content-youtube` → `content-index`。
共用層必須先載入，因為各模組都從 `window.BT` 取依賴。

### 資料流向
```
popup ──(storage.sync: enabled, position)──▶ content-index
                                               │ start(settings) / stop()
                              ┌────────────────┴────────────────┐
                    網頁：content-page                YouTube：content-youtube
          IntersectionObserver → 佇列(併發4)      MutationObserver 讀 CC 英文 → 佇列
                              └────────────────┬────────────────┘
                         chrome.runtime.sendMessage({type:'translate'})
                                               ▼
                    background：PROVIDERS[ACTIVE_PROVIDER] + 快取 + 8 秒逾時
                                               │
                 renderBlock(position) / state.yt.textContent = 譯文
```

## 關鍵設計決策

- **為何用 MV3 + 無框架**：功能範圍小，WXT/React 會增加建置成本，目前 KISS。
- **為何拆成四個內容腳本**：原本單一檔案同時處理兩種模式，職責混雜。拆開後網頁與 YouTube 可各自修改，互不牽連。
- **為何用 `window.BT` 而非 ES module**：content script 不支援 `import`，只能靠載入順序與全域命名空間。
- **為何翻譯放 background**：內容腳本發跨域請求受頁面 CORS 限制，放 service worker 統一處理，並可集中快取與換引擎。
- **引擎登錄表 `PROVIDERS`**：每個引擎只需實作 `translate(text)`，切換引擎只改 `ACTIVE_PROVIDER`。目前不做引擎選單，因為只有一個引擎（YAGNI）。
- **只翻「最內層文字塊」**：`isLeafBlock()` 避免父子元素（如 `li > p`）重複翻譯。
- **IntersectionObserver 懶翻譯**：只翻視窗附近 300px 內的段落，長頁面不會一次打完所有請求。
- **翻譯併發上限 4**：避免被 gtx 限流。
- **翻譯逾時 8 秒**：沒有逾時的請求會佔住併發額度，整條佇列卡死。
- **Session 機制**：每次 start/stop 遞增 `state.session`，舊的非同步結果比對不上就丟棄。
- **設定變更一律 stop 再 start**：已插入的譯文位置要重排，原地改 `position` 會留下舊位置的譯文。
- **YouTube 直接讀 CC DOM**：不自己抓 timedtext，省去解析字幕檔與時間同步；代價是依賴 YouTube DOM 結構，改版需調整。
- **YouTube 譯文固定顯示在字幕下方**：overlay 掛在 `.captions-text` 內，跟著英文字幕走。`position` 設定目前不影響 YouTube。
- **節流 `schedule()`**：固定視窗內最多執行一次。debounce 在 YouTube 持續變動時會永遠不執行。
- **不在 youtube.com 做網頁對照**：否則會翻到 YouTube 介面文字。

### 踩坑預警（已知限制）
- gtx 為非官方端點，可能限流或失效。要換 Claude / DeepL，在 `PROVIDERS` 新增一筆即可。
- 表格與列表一律把譯文放在元素內部，若直接 `afterend` 會破壞 `tr`/`ul` 結構。
- `div` 也納入候選，但只限沒有區塊子節點的葉節點。
- 網頁譯文失敗時會清除標記，但不會自動重試（已離開視窗的段落不會再被 observe）。
- 翻譯失敗不重試：刻意不加重試迴圈，避免 API 被打爆。

## 如果重新設計

**軟體架構師視角**：
- 翻譯 Provider 改為支援批次 `translate(texts[]) → string[]`，減少請求數。需確認 gtx 批次分隔符號的可靠性。
- YouTube 字幕來源抽成 Adapter，未來可換成「抓 timedtext」或「分頁音訊 + Whisper 即時辨識」，不影響譯文渲染。
- 設定可再擴充（底色、目標語言），統一經 `chrome.storage.sync`，popup 與 options 頁共用。
- 若要長期維護，改用 WXT 框架 + TypeScript，有型別保護與 HMR。

**目前技術債**：
- 無自動化測試。目前只做 `node --check` 與 manifest JSON 檢查，尚未在真實瀏覽器驗證 YouTube DOM 行為。
- YouTube 模式不支援譯文上方。
- 無 icon 檔（Chrome 會用預設圖示）。
- 共用層用全域 `window.BT`，之後若要測試需改成可注入的依賴。

## 變更紀錄
- 2026-11-13：建立 MV3 骨架；實作網頁雙語對照（暗黃底）、YouTube 即時雙語字幕、彈窗開關；完成架構文件。
- 2026-11-13：架構調整。`content.js` 拆為 shared / page / youtube / index 四個模組；設定改用 `storage.sync` 並新增譯文上下位置；翻譯加入 8 秒逾時與引擎登錄表；設定變更時整體重建。
- 2026-11-13：專案搬到 `/Volumes/SSD 1T/IT/`，建立 git repo；`.gitignore` 排除 exFAT 產生的 `._*` 檔案。
- 2026-11-13：新增 `SECURITY.md` 資安重新規劃（尚未實作）。重點是預設改用 Chrome 內建本機翻譯，權限從 `<all_urls>` 縮成 activeTab，並加上敏感網站黑名單。原因：個人自用時，最大風險是擴充自己把網銀、Email 頁面的文字送給第三方。
