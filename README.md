# 雙語對照翻譯（Chrome 擴充套件）· 開發說明書

個人自用的 Chrome 擴充套件，類似「沉浸式翻譯」：

- **網頁雙語對照**：英文段落的上方或下方插入中文譯文，底色和字級可以調整
- **YouTube 即時雙語字幕**：讀取英文 CC，在播放器上畫出「英文＋中文」雙語字幕框

| 項目 | 內容 |
|------|------|
| 版本 | 0.4.0 |
| 平台 | Google Chrome 138+（桌面版），開發環境為 Mac mini M4 + Chrome 157 |
| 技術 | Manifest V3、原生 JavaScript、零第三方執行期依賴 |
| 翻譯引擎 | Google gtx（非官方端點，需手動授權）；本機 Translator API 規劃中 |
| 資安設計 | 見 [`SECURITY.md`](SECURITY.md) |
| 設計決策與變更紀錄 | 見 [`DEV_JOURNAL.md`](DEV_JOURNAL.md) |

---

## 1. 安裝

1. 打開 `chrome://extensions`，開啟右上角的「開發人員模式」
2. 點「載入未封裝項目」，選擇這個專案資料夾
3. 點工具列上的擴充圖示 →「Google 翻譯」區塊 →「允許使用」→ Chrome 跳出對話框時按允許

> 改過程式碼之後，要在 `chrome://extensions` 按擴充卡片上的 ↻ 重新載入，再重新整理網頁。

## 2. 使用

### 網頁
- 按工具列圖示 →「翻譯此頁 / 還原」，或按快捷鍵 **`Alt+A`**（Mac 是 `Option+A`）
- 再按一次會還原
- 快捷鍵可以在 `chrome://extensions/shortcuts` 修改

### YouTube
- 在彈窗勾選「YouTube 自動雙語字幕」
- 影片要先開啟**英文 CC**（手動字幕或自動字幕都可以）
- 也可以在 YouTube 頁面按 `Alt+A` 只切換這一頁

### 工具列徽章
| 徽章 | 意思 |
|------|------|
| `ON`（綠） | 這一頁正在翻譯 |
| `✕`（紅） | 被拒絕：敏感網站、黑名單，或頁面上有密碼欄位 |
| `!`（紅） | 還沒允許 Google 翻譯，或這一頁無法執行（例如 Chrome 線上應用程式商店） |

### 彈窗設定
| 設定 | 預設 | 範圍 / 選項 | 存放位置 |
|------|------|-------------|----------|
| 底色 | 深紅 `#8b1a1a` | 任意 `#rrggbb` | `storage.sync` |
| 字級 | 95% | 70%–160% | `storage.sync` |
| 網頁譯文位置 | 英文下方 | 下方 / 上方 | `storage.sync` |
| YouTube 自動雙語字幕 | 關 | 開 / 關 | `storage.sync` |
| 自訂黑名單 | 空 | 一行一個網域 | `storage.local`（不同步） |

- 文字顏色不用設定，程式會依底色自動挑對比較高的黑色或白色
- 改底色或字級時，頁面上已經出現的譯文會**即時套用**，不需要重新翻譯

---

## 3. 架構

### 3.1 目錄
```
bilingual-translate-ext/
├── manifest.json        # MV3 宣告：權限、YouTube 靜態注入、快捷鍵
├── background.js        # service worker：按需注入、黑名單、訊息驗證、翻譯代理、快取
├── settings.js          # 設定的唯一來源：預設值、驗證、自動文字色（彈窗與內容腳本共用）
├── content-shared.js    # 內容腳本共用層：window.BT、狀態、翻譯佇列、節流
├── content-page.js      # 網頁模式：找文字塊、懶翻譯、插入譯文
├── content-youtube.js   # YouTube 模式：讀 CC、畫雙語字幕框
├── content-index.js     # 入口：toggle()、啟停、套用外觀、監聽設定
├── style.css            # 譯文樣式（全部走 CSS 變數）
├── popup.html / .js     # 工具列彈窗
├── tests/
│   ├── unit-background.js   # 黑名單與訊息驗證單元測試（不需任何套件）
│   └── e2e.js               # Playwright + Chromium 端對端測試
├── README.md            # 本檔
├── SECURITY.md          # 威脅模型與資安規劃
└── DEV_JOURNAL.md       # 設計決策與變更紀錄
```

### 3.2 模組職責
| 模組 | 負責 | 不負責 |
|------|------|--------|
| `background` | 決定能不能注入（黑名單、權限）、驗證訊息、呼叫翻譯引擎、快取、徽章 | 不碰頁面 DOM |
| `settings` | 預設值、`sanitize()` 驗證、`textColorFor()`、`applyTo()` 套 CSS 變數 | 不讀寫頁面內容 |
| `content-shared` | 狀態、翻譯佇列（併發 4）、節流、`translate()` 訊息封裝 | 不知道網頁或 YouTube 的結構 |
| `content-page` | 找最內層文字塊、IntersectionObserver、插入網頁譯文 | 不處理 YouTube |
| `content-youtube` | 讀字幕行、合併逐字更新、維護雙語框 | 不處理一般網頁 |
| `content-index` | `toggle()`、start/stop、密碼欄位檢查、監聽設定變更 | 不含 DOM 掃描邏輯 |
| `popup` | 觸發翻譯、授權 Google、外觀與黑名單設定 | 不碰頁面 DOM |

### 3.3 內容腳本載入順序（重要）
內容腳本不能用 `import`，模組之間靠全域命名空間（`window.BT`、`window.BT_SETTINGS`）和**載入順序**串起來：

```
settings.js → content-shared.js → content-page.js 或 content-youtube.js → content-index.js
```

這個順序寫在兩個地方，**改的時候兩邊都要改**：
- `manifest.json` 的 `content_scripts[0].js`（YouTube 靜態注入）
- `background.js` 的 `SCRIPT_FILES`（一般網頁按需注入）

每個檔案開頭都有「已載入就 return」的防護，因為每按一次 `Alt+A` 都會重新注入。

### 3.4 資料流

```
【一般網頁】
點工具列 / Alt+A
  → background.toggleTab()
      ├─ isDenied(url)？         → 徽章 ✕，結束（完全不注入）
      ├─ 沒有 Google 權限？       → 徽章 !，結束
      └─ scripting.executeScript 注入 → BT.toggle()
            ├─ 有密碼欄位？       → 'blocked'
            └─ start()
                 → Settings.applyTo(<html>)  套外觀 CSS 變數
                 → 掃描最內層文字塊 → IntersectionObserver（視窗附近才翻）
                 → 佇列 → sendMessage('translate')
                      → background：驗證 sender/型別/長度/配額 → 快取 → gtx
                 → textContent 插入 .bt-zh

【YouTube】
manifest 靜態注入（只限 www.youtube.com）
  → youtubeAuto 開啟時 start()
  → MutationObserver（150ms 節流）讀 .caption-visual-line
  → 英文：直接鏡像到 .bt-yt-en（無延遲）
  → 中文：換句立刻翻；逐字增加時等停頓 0.7 秒，最多等 2.5 秒
  → 結果只接受「最新一次請求」→ .bt-yt-zh

【設定變更】
popup → storage.sync → content-index onChanged
  ├─ 底色 / 字級 → 只重套 CSS 變數（即時）
  ├─ 位置       → stop + start（譯文位置要重排）
  └─ youtubeAuto → YouTube 頁面啟停
```

### 3.5 YouTube 雙語框為什麼要自己畫
原本把中文塞進 YouTube 自己的字幕框，但自動字幕是**逐字**長出來的。每多一個字整個框就重排一次，中文剛出現就被下一行英文推上去，而且每個半句都送一次翻譯，很快就被 Google 限流。

現在的做法：
1. 原生字幕設成 `opacity: 0`（還留在 DOM 裡，可以讀英文）
2. 在 `#movie_player` 裡畫自己的框，以 `bottom` 定位、往上長。中文是最後一個元素，**固定貼在底部**，英文變兩行時只會往上長
3. 控制列自動隱藏時（`.ytp-autohide`），框會跟著往下移，跟原生字幕一致
4. 字級跟著播放器寬度縮放（`--bt-yt-base`），一般、劇院、全螢幕模式都適用

---

## 4. 開發流程

### 4.1 改程式碼
1. 修改檔案
2. 在 `chrome://extensions` 重新載入擴充
3. 重新整理要測的網頁（舊頁面上的內容腳本已經失效）
4. 跑測試（見 4.3）
5. 更新 `DEV_JOURNAL.md` 的變更紀錄，有架構變動也要更新本檔
6. 有功能變動就調整 `manifest.json` 的 `version`

### 4.2 規範
- 註解一律繁體中文，只寫「為什麼」：決策、踩過的坑、業務規則
- 插入頁面的內容**只能用 `textContent`，禁止 `innerHTML`**。commit 前檢查：
  ```bash
  grep -n innerHTML *.js
  ```
- 不准 `try/catch` 吞錯誤，至少要 `console.error`；log **不准印原文**
- 從 `storage` 讀出的設定一律先過 `Settings.sanitize()`
- 新增設定：在 `settings.js` 的 `DEFAULTS` 和 `sanitize()` 各加一筆，其他地方不寫預設值
- Commit 訊息格式見全域規則（`type(scope): subject`）

### 4.3 測試

**單元測試**（黑名單、訊息驗證、配額；不需安裝任何套件）
```bash
node tests/unit-background.js
```

**端對端測試**（46 項；需要 Playwright 和它附的 Chromium）
```bash
PLAYWRIGHT_PATH=/path/to/node_modules/playwright node tests/e2e.js
```

e2e 的做法：
- 每次執行都把擴充複製到暫存目錄，**只改 manifest 權限**，其他程式碼跟正式版一樣。原因是自動化點不到工具列，也按不到權限對話框
- 測試頁面用 `context.route` 攔截假網域（`article.test`、`login.test`、`mybank.test`、`www.youtube.com`）
- 翻譯引擎換成假的（回傳「測試譯文：…」），不依賴外部服務，也不會被 Google 限流
- 品牌版 Google Chrome 137 之後不支援 `--load-extension`，所以只能用 Chromium 測

**自動化測不到，要手動確認的**
- 真正的工具列點擊、`Alt+A`、Google 權限對話框
- 真實 YouTube 的 DOM 結構（e2e 用的是仿造頁面）
- 在品牌版 Google Chrome 上的表現

---

## 5. 疑難排解

| 症狀 | 可能原因 | 處理 |
|------|----------|------|
| 徽章 `!`，沒有翻譯 | 還沒允許 Google 翻譯 | 彈窗 →「允許使用」 |
| 有 `ON` 但譯文不出現 | **Google 限流**：請求被 302 轉到 `google.com/sorry` | 等幾個小時；長期解法是 Phase 2 本機翻譯 |
| 某個網站一直 `✕` | 在內建黑名單、網域含 `bank`，或頁面有密碼欄位 | 這是刻意的設計，見 `SECURITY.md` |
| YouTube 沒有雙語框 | 沒開英文 CC，或沒勾「自動雙語字幕」 | 開 CC，勾選設定 |
| YouTube 中文延遲 | 自動字幕逐字長出來時，會等停頓才翻 | 正常行為；可以調 `content-youtube.js` 的 `STABLE_MS`、`MAX_WAIT_MS` |
| 改了程式沒反應 | 沒重新載入擴充或網頁 | 見 4.1 |

檢查是否被限流（回 `200` 正常，回 `302` 代表被限流）：
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-TW&dt=t' --data-urlencode 'q=hello'
```

---

## 6. 路線圖
| 階段 | 內容 | 狀態 |
|------|------|------|
| Phase 1 | 權限最小化、黑名單、訊息驗證、log 清理 | ✅ v0.3.0 |
| — | 底色、字級可調；YouTube 雙語框重做 | ✅ v0.4.0 |
| Phase 2 | Chrome 內建 Translator API（本機離線，文字不出機器），gtx 降為備援 | 規劃中 |
| Phase 3 | 擴充搬到內建 APFS 磁碟、譯文改用 Shadow DOM（選做） | 規劃中 |
