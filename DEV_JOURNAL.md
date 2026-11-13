# 開發者設計精華日誌

## 專案概覽
- 目的：個人自用的 Chrome 擴充套件，做「網頁雙語對照」與「YouTube 即時雙語字幕」
- 核心功能：
  1. 網頁：點擊或 `Alt+A` 才翻譯，英文上方或下方插入中文，底色與字級可調（預設深紅、95%）
  2. YouTube：讀英文 CC，畫自己的雙語框，中文固定貼底
- 技術棧：Chrome Extension Manifest V3、原生 JavaScript（無建置工具、零執行期依賴）；翻譯預設用 Chrome 內建 Translator API（本機），可選 Google gtx
- 完整使用與開發說明見 `README.md`，資安設計見 `SECURITY.md`

## 架構設計

### 目錄結構
```
├── manifest.json        # 權限、YouTube 靜態注入、快捷鍵
├── background.js        # 按需注入、黑名單、訊息驗證、翻譯代理、快取、徽章
├── settings.js          # 設定唯一來源：預設值、sanitize、自動文字色
├── content-shared.js    # window.BT：狀態、佇列、節流、translate()
├── content-page.js      # 網頁模式
├── content-youtube.js   # YouTube 模式
├── content-index.js     # 入口：toggle、啟停、外觀、設定監聽
├── style.css            # CSS 變數驅動的樣式
├── popup.html / .js     # 工具列彈窗
└── tests/               # 單元測試 + Playwright e2e
```

### 模組職責
| 模組 | 職責 | 不做的事 |
|------|------|----------|
| `background` | 能不能注入、本機模式擋線上請求、驗證訊息、gtx、快取、徽章 | 不碰頁面 DOM；不跑本機翻譯 |
| `settings` | 預設值、驗證、文字色、套 CSS 變數 | 不讀寫頁面內容 |
| `content-shared` | 狀態、佇列、節流、本機 Translator、依引擎分流 | 不知道頁面結構 |
| `content-page` | 文字塊掃描、懶翻譯、插入 | 不處理 YouTube |
| `content-youtube` | 讀字幕行、合併逐字更新、雙語框 | 不處理一般網頁 |
| `content-index` | toggle、啟停、密碼欄位檢查、設定監聽 | 不含掃描邏輯 |
| `popup` | 觸發、授權、設定 | 不碰頁面 DOM |

### 資料流向（簡版，完整版見 README §3.4）
```
點擊 / Alt+A → background（黑名單 → 權限 → 注入）→ BT.toggle()
  → content-page / content-youtube → 佇列 → sendMessage('translate')
  → background（驗證 → 快取 → gtx）→ textContent 插入
popup → storage.sync → onChanged → 外觀即時套用 / 位置重建 / YouTube 啟停
```

## 關鍵設計決策

### 架構
- **MV3 + 無框架**：功能範圍小，WXT/React 會增加建置成本與供應鏈風險，KISS。
- **拆成多個內容腳本**：網頁與 YouTube 可以各自修改，互不牽連。
- **用 `window.BT` / `window.BT_SETTINGS`，不用 ES module**：content script 不支援 `import`，只能靠載入順序。順序寫在 `manifest.json` 和 `background.js` 的 `SCRIPT_FILES` 兩個地方，要一起改。
- **`settings.js` 是設定的唯一來源**：原本預設值在 popup 與 content-index 各寫一份，加了外觀設定後抽出來（DRY）。
- **翻譯放 background**：避開頁面 CORS，集中快取、驗證與換引擎。
- **引擎登錄表 `PROVIDERS`**：每個引擎只需實作 `translate(text)`。目前只有一個引擎，所以不做引擎選單（YAGNI）。

### 資安（詳見 SECURITY.md）
- **activeTab 按需注入**：沒點擊的網站完全讀不到。代價是失去全站自動翻譯。
- **黑名單在注入前檢查**：被拒的網站連內容腳本都不會載入。
- **gtx 是 optional 權限**：預設不送任何資料出去。
- **CSS 變數只接受 `#rrggbb`**：storage 可能被其他裝置寫入，避免把任意字串注入頁面樣式（e2e 有測 `red;} body{display:none`）。

### 網頁模式
- **只翻「最內層文字塊」**：`isLeafBlock()` 避免 `li > p` 父子重複翻譯。
- **IntersectionObserver 懶翻譯**：只翻視窗附近 300px 的段落。
- **可見性在 intersect 時才檢查**：`checkVisibility()` 要算樣式，整頁掃描時做太貴。
- **表格與列表把譯文塞進元素內部**：直接 `afterend` 會破壞 `tr` / `ul` 結構。
- **外觀變數掛在 `<html>`**：改底色或字級時所有譯文即時生效，不用重新翻譯。
- **文字色依底色自動挑**：用 WCAG 對比度選黑或白，選淺色底也看得清楚。

### YouTube 模式
- **讀 CC 的 DOM，不抓 timedtext**：不用解析字幕檔，自動跟播放器同步。代價是依賴 YouTube 的 DOM 結構。
- **隱藏原生字幕，自己畫雙語框**：中文塞在原生字幕框裡時，自動字幕逐字更新會整框重排，中文被下一行英文推走。改成以 bottom 定位、往上長的自訂框後，中文固定貼底。
- **逐字增加時合併請求**：「新文字以舊文字開頭」代表逐字長出來，等停頓 0.7 秒再翻，最多等 2.5 秒；換句時立刻翻。e2e 實測 9 次逐字更新只送 1 次。
- **只接受最新一次請求的結果**：避免舊句子的譯文晚回來蓋掉新的。
- **英文直接鏡像、不經翻譯**：英文沒有延遲，只有中文會稍微落後。

### 踩坑紀錄
- **被 Google 限流**：測試和 YouTube 逐字翻譯讓請求暴增，gtx 回 302 轉到 `google.com/sorry`。處理方式：e2e 改用假引擎、YouTube 合併請求；長期解法是 Phase 2 本機翻譯。
- **`permissions.request` 要在點擊處理函式裡直接呼叫**：前面先 `await` 其他東西會失去使用者手勢。
- **`storage.sync` 每分鐘最多寫 120 次**：滑桿和色盤拖動時只更新預覽（`input` 事件），放開才寫入（`change` 事件）。
- **節流要用 throttle，不能用 debounce**：YouTube 頁面一直在變動，debounce 會永遠不執行。
- **品牌版 Chrome 137+ 不能用 `--load-extension`**：自動化測試只能用 Chromium。
- **exFAT 外接碟會產生 `._*` 檔**：已加進 `.gitignore`。
- **e2e 捲到頁底後，頂端段落不會被懶翻譯**：測試要先捲回頂端。

## 如果重新設計

**軟體架構師視角**：
- 翻譯引擎改成批次 `translate(texts[]) → string[]`，減少請求數。
- YouTube 字幕來源抽成 Adapter，未來可以換成 timedtext 或「分頁音訊 + Whisper」，渲染層不用改。
- 長期維護就改用 WXT + TypeScript，用型別保護載入順序與 `window.BT` 的介面。

**目前技術債**：
- 載入順序寫在兩個地方（manifest 與 `SCRIPT_FILES`），容易漏改。
- YouTube 依賴 `.caption-visual-line` 等 DOM 選擇器，YouTube 改版就會壞。
- e2e 需要手動指定 `PLAYWRIGHT_PATH`，沒有用 `package.json` 管理（刻意維持零依賴）。
- 沒有 icon 檔。
- 每頁配額存在 service worker 記憶體裡，worker 被回收就歸零，是軟性上限。

## 變更紀錄
- 2026-11-13：建立 MV3 骨架；實作網頁雙語對照（暗黃底）、YouTube 即時雙語字幕、彈窗開關。
- 2026-11-13：架構調整。`content.js` 拆成 shared / page / youtube / index；設定改用 `storage.sync`，新增譯文上下位置；翻譯加 8 秒逾時與引擎登錄表。
- 2026-11-13：專案搬到 `/Volumes/SSD 1T/IT/`，建立 git repo。
- 2026-11-13：新增 `SECURITY.md` 資安重新規劃。
- 2026-11-13：完成資安 Phase 1（v0.3.0）。拿掉 `<all_urls>`，改用 activeTab 按需注入；gtx 改為 optional 權限；加入黑名單、密碼欄位拒絕、訊息驗證、每頁配額、隱藏文字過濾；log 不印原文；拿掉全站自動翻譯。
- 2026-11-13：v0.4.0。
  - 底色、字級可調，預設改成深紅 `#8b1a1a`、95%；文字色依底色自動挑；改設定即時生效。新增 `settings.js` 統一預設值與驗證。
  - YouTube 改成自己畫雙語框，中文固定貼底，修正中文被下一行英文推走的問題；逐字更新合併成一次請求。
  - 測試搬進 `tests/`（單元 + 46 項 e2e，翻譯引擎用假的）；新增開發說明書 `README.md`。
- 2026-11-13：repo 改為公開。公開前掃過整個歷史，沒有密鑰、私人信箱或本機帳號名稱。
- 2026-11-13：v0.5.0，資安 Phase 2 本機翻譯。
  - 新增引擎設定，預設本機（Chrome 內建 Translator API，`en → zh-Hant`），Google 改為選用。
  - 本機翻譯在內容腳本執行，不經 background；併發改成 1，因為 API 本來就依序處理。
  - 第一次使用要在頁面上點「下載並翻譯」，因為 `Translator.create()` 需要該頁面的使用者手勢，工具列和快捷鍵都不算。
  - background 在本機模式拒絕所有線上請求（`engine-local`）。不做本機失敗自動改用 Google，避免資料在使用者不知情時送出去。
  - `settings.js` 改用 `globalThis`，background 也用 `importScripts` 共用同一份預設值與驗證。
  - 新增徽章 `↓`（需下載），內容腳本可以回報狀態更新徽章；CSS 插入改成按分頁記錄，避免重複堆疊。
  - e2e 增加到 63 項，本機引擎用照真實規則寫的假 API（下載必須有使用者手勢）。
  - 踩坑：Chromium 的內容腳本有 `Translator`，也會回報 `downloadable`，但無頭模式的真實下載一直不會完成，拿掉 `--disable-component-update` 也一樣，只能在品牌版 Chrome 上驗證。
- 2026-11-13：v0.6.0，介面重新設計。
  - 視覺取材自中文閱讀：冷灰紙、藍黑墨、朱砂印。朱砂只用在印章與主要按鈕。刻意避開米色紙配陶土色、黑底螢光色這類常見樣板。
  - 只用系統字型：宋體當標題，蘋方當內文。不載入外部字型，因為這個擴充主打資料不出電腦。
  - 彈窗：印章標頭、引擎狀態徽章、分段按鈕取代單選和下拉、5 個預設色票加自訂、真正的英中對照預覽、YouTube 開關、黑名單收合、支援深色模式。樣式拆到 `popup.css`。
  - 下載提示條：印章、宋體標題、進度條，深色模式；動畫只有出現時一次，並且尊重「減少動態效果」設定。
  - 網頁譯文固定用蘋方，不繼承頁面字型，因為英文網站的字型沒有中文字形，會退回很醜的預設字。
  - 新增朱砂印工具列圖示（用 Chromium 渲染宋體「譯」）。
  - 踩坑：`all: unset` 的重設規則 `.bt-banner-actions button` 權重 (0,1,1) 比 `.bt-banner-go` 高，把按鈕底色洗掉了，改成 `.bt-banner .bt-banner-go`。
  - 踩坑：`.note { display: block }` 會蓋掉 `hidden` 屬性，彈窗加上 `[hidden] { display: none !important }`。
  - 彈窗收合時約 600px，剛好在 Chrome 彈窗的高度上限附近；之後再加設定要注意會出現捲軸。
- 2026-11-13：v0.7.0，Claude 引擎。
  - 使用者用自己的 Anthropic API 金鑰；Opus 5.5（預設）或 Haiku 5.5，由使用者選。不能用 Claude 訂閱的登入 token。
  - 用官方 SDK，不手刻 HTTP。SDK 用 esbuild 打包成 IIFE 放在 `vendor/`，讓 classic service worker 用 `importScripts` 載入；固定 1.3.0（發佈超過兩週）、`--ignore-scripts`、記錄 SHA-256。取捨：放棄「零依賴」，換來官方的錯誤類別、重試與請求格式。
  - 同一頁 150ms 內的段落合併成一次請求（最多 16 段或 8,000 字），用 structured outputs 取回 `{id, text}` 陣列。內容腳本的 Claude 併發開到 16，一批才裝得滿。
  - `effort: low`；Opus 開 `fallbacks: "default"`（拒答時由伺服器改用備援模型），Haiku 5.5 沒有伺服器端備援，所以不帶。
  - 金鑰：預設 `storage.session`（只在記憶體），勾「記住」才放 `storage.local`；`storage.local` 用 `setAccessLevel('TRUSTED_CONTEXTS')` 鎖住，內容腳本讀不到（e2e 實測回 blocked）。彈窗只顯示末 4 碼。
  - 提示注入：系統提示講明頁面文字不是指令；譯文比原文長 4 倍以上就丟掉；`console.anthropic.com` 加進黑名單。
  - 每次請求記下當天次數與估算花費，顯示在彈窗；「測試金鑰」用 `models.retrieve`，不花錢。
  - 快取鍵加上引擎與模型，切換後不會拿到別的引擎的結果。
  - 踩坑：SDK 1.x 的 `apiKeyAuth` 把金鑰放在 `Authorization: Bearer`，不是舊版的 `x-api-key`。用真的 SDK 加攔截 `fetch` 確認過，這是官方設計。
  - 測試：單元測試加 Claude 情境；e2e 79 項（假 SDK client），另外用真的 SDK 加假 `fetch` 驗證請求格式。真的 API 呼叫還沒用真金鑰跑過。
