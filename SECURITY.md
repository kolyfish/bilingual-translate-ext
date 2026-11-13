# 資安重新規劃（個人自用 / Mac mini M4）

> 狀態：**規劃中，尚未實作**。標 `[待驗證]` 的項目需要在本機 Chrome 實測後才能定案。

## 0. 前提

| 項目 | 實際值 |
|------|--------|
| 使用者 | 只有自己，不上架 Chrome Web Store |
| 機器 | Mac mini M4，FileVault 已開啟 |
| 瀏覽器 | Google Chrome 157（開發者模式載入未封裝擴充） |
| 原始碼位置 | `/Volumes/SSD 1T/IT/`，USB 外接、**exFAT**（無檔案權限、無加密） |

## 1. 威脅模型

**要保護的東西（依重要性）**
1. 瀏覽內容隱私：網銀、Email、公司內部系統、醫療、私訊
2. 已登入的帳號狀態（cookie、session）
3. 擴充套件本身的完整性（程式碼沒被偷改）

**威脅來源**
- **A. 擴充自己把資料送出去**：個人自用時，這是最大的風險
- **B. 惡意網頁利用擴充**：灌文字、偵測擴充、誘導翻譯隱藏內容
- **C. 本機被改 code**：外接碟上的檔案被其他程式或其他人修改
- **D. 供應鏈**：第三方套件被植入惡意程式

## 2. 現況風險盤點

| # | 風險 | 現況 | 嚴重度 |
|---|------|------|--------|
| R1 | `<all_urls>` 全站注入，開啟後自動翻譯 | 網銀、Gmail 頁面上的文字會**全部送到 Google gtx** | 🔴 高 |
| R2 | gtx 非官方端點 | 頁面原文出站，使用條款灰色，可能被封 IP | 🔴 高 |
| R3 | background `onMessage` 沒做驗證 | 沒檢查 sender、型別、長度 | 🟠 中 |
| R4 | 惡意網頁塞大量隱藏英文 | 可耗用翻譯配額，可能導致 IP 被封 | 🟠 中 |
| R5 | 原始碼放在 exFAT 外接碟 | 沒有權限控管、沒有加密，被改後 Chrome 重新載入就會執行 | 🟠 中 |
| R6 | DOM 標記（`data-bt-done`、`.bt-zh`） | 網頁可偵測到擴充存在（指紋） | 🟢 低 |
| R7 | `storage.sync` 會同步到 Google 帳號 | 目前只有開關與位置，沒有機密 | 🟢 低（未來放 API key 就變高） |
| ✅ | 譯文插入用 `textContent` | 沒有 XSS 風險 | — |
| ✅ | 零第三方依賴 | 供應鏈風險極低 | — |

## 3. 新架構決策

### D1. 翻譯引擎：預設改用 Chrome 內建 Translator API（本機離線）→ 解 R1、R2
- Chrome 138 起內建，你的 157 可以用。模型跑在本機，**文字不離開 Mac**。
- 繁中語言代碼：`zh-Hant`。
- 限制 1：第一次下載語言包時，`Translator.create()` 需要**頁面上的使用者手勢**（點擊）。
  - 對策：在頁面注入一顆「啟用翻譯」按鈕，第一次點它觸發下載 `[待驗證]`
  - 待確認：語言包是不是整個瀏覽器共用，下載一次後所有網站都能用 `[待驗證]`
- 限制 2：官方文件只保證 top-level window 可用，沒有明講 content script。社群有人在 content script 用過，但屬零星案例 `[待驗證]`
- 限制 3：翻譯是**依序執行**，本機模式佇列併發要改成 1。
- gtx 降為**選用備援**：放進 `optional_host_permissions`，預設不給權限；你手動開啟時才在執行期向 Chrome 申請。

### D2. 權限最小化 → 解 R1
| 現在 | 改成 |
|------|------|
| `content_scripts` 套用 `<all_urls>` | 移除 |
| 開啟後所有網站自動翻譯 | 按工具列圖示或快捷鍵（例如 `Alt+A`）才翻譯**目前分頁** |
| `host_permissions: translate.googleapis.com` | 移到 `optional_host_permissions` |
| — | 新增 `activeTab` + `scripting`：只有點擊時才拿到該分頁的權限 |
| YouTube 跟著 `<all_urls>` | 靜態注入，只限 `https://www.youtube.com/*` |

效果：沒有點擊的網站，擴充**完全沒有讀取權限**。在 `chrome://extensions` 會顯示為「在你點擊擴充功能時」。

取捨：失去「全站自動翻」的便利。補救方式是做**自動翻譯白名單**，每個網站個別授權（例如 `medium.com`、`github.com`）。

### D3. 敏感網站硬性黑名單 → 防誤觸
- 即使手動觸發也拒絕翻譯：網銀、支付、Email、密碼管理器、醫療、政府服務。
- 預設清單可自行編輯，例如：`mail.google.com`、`accounts.google.com`、`*.paypal.com`、各家網銀網域。
- 頁面上有 `input[type=password]` 時，整頁拒絕翻譯（啟發式判斷）。

### D4. 訊息通道驗證 → 解 R3、R4（只對 gtx 備援模式有意義）
- 檢查 `sender.id === chrome.runtime.id`，並且 `sender.tab` 存在。
- `type` 只接受白名單值；`text` 必須是字串，長度上限 2000 字元。
- 每個分頁設請求數上限（例如 500 段），避免惡意頁面灌爆。
- 掃描時跳過隱藏元素（`display:none`、`aria-hidden`、`visibility:hidden`），不讓頁面用隱藏文字誘導翻譯。

### D5. DOM 安全 → 處理 R6
- 永遠只用 `textContent`，**禁止 `innerHTML`**。每次 commit 前用 `grep innerHTML` 檢查。
- 選用：譯文改放進 closed Shadow DOM，網頁 CSS 不會污染譯文，網頁腳本也比較難讀到譯文。個人自用的效益中等。

### D6. 擴充本體完整性 → 解 R5
- **建議**：Chrome 載入的那份放到**內建磁碟**（APFS + FileVault），例如 `~/Developer/bilingual-translate-ext`。
- 外接 SSD 保留 git repo 當備份或另一份工作區；同步前看 `git diff`。
- 每次在 `chrome://extensions` 按重新載入之前，先跑 `git status`，確認沒有預期外的變更。

### D7. 資料留存
- 翻譯快取只放在記憶體（service worker 結束就消失），不寫進 storage。
- 錯誤 log 只印錯誤類型，**不印原文**。
- 未來如果接 Claude / DeepL API key：只放 `storage.local`（不放 sync），只在 background 使用，絕不傳進 content script。

### D8. 供應鏈
- 維持零依賴。
- 如果日後改用 TypeScript / WXT：提交 lockfile、固定版本、跑 `npm audit`，並停用 `postinstall` 腳本（`npm config set ignore-scripts true`）。

## 4. 新資料流

```
【一般網頁】
點工具列 / Alt+A
  → activeTab 授權目前分頁
  → scripting.executeScript 注入 content script
  → 檢查黑名單 / 密碼欄位 → 命中就拒絕
  → Translator API（本機，zh-Hant）
  → textContent 插入暗黃底譯文

【YouTube】
靜態 content script（只限 youtube.com）
  → 讀 CC 英文 → Translator API（本機）→ overlay

【gtx 備援，預設關閉】
content → background（驗證 sender / type / 長度 / 次數）
       → 確認已取得 optional 權限 → fetch gtx
```

## 5. 分階段實作

| 階段 | 內容 | 風險 |
|------|------|------|
| Phase 1 | D2 權限最小化、D3 黑名單、D4 訊息驗證、D7 log 清理 | 低，規格明確 |
| Phase 2 | D1 本機翻譯 + 首次下載語言包流程 | 中，需要在你的 M4 上實測 `[待驗證]` |
| Phase 3 | D6 搬到內建磁碟、D5 Shadow DOM（選做） | 低 |

## 6. 需要你決定的事

1. **取消全站自動翻**，改成點擊或快捷鍵才翻，再加白名單自動翻？（建議：是）
2. 本機翻譯的品質可能不如 Google `[推測]`，可以接受嗎？gtx 備援要保留嗎？
3. Chrome 載入的那份要搬到內建磁碟嗎？

## 7. 驗證方式

- `chrome://extensions` → 詳細資料：網站存取權應顯示「在你點擊擴充功能時」。
- 本機模式：DevTools → Network，翻譯時不應該有任何對外請求。
- 打開網銀或 Gmail，按 `Alt+A`：應該被拒絕並顯示提示。
- 製作一個含隱藏英文段落的測試頁：隱藏段落不應被翻譯。

## 參考來源
- [Translation with built-in AI — Chrome for Developers](https://developer.chrome.com/docs/ai/translator-api)
- [Translator guide — Chrome modern web guidance](https://developer.chrome.com/docs/modern-web-guidance/guides/built-in-ai/translator)
- [Translator and Language Detector APIs — MDN](https://developer.mozilla.org/docs/Web/API/Translator_and_Language_Detector_APIs)
- [chrome-ai-dev-preview-discuss（社群：content script 使用 Translator 的案例）](https://groups.google.com/a/chromium.org/g/chrome-ai-dev-preview-discuss/c/Y6iLxLUCEPc)
