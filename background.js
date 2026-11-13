// 背景服務：翻譯代理 + 按需注入
// 資安原則（詳見 SECURITY.md）：
//   1. 只在使用者點擊或按快捷鍵時，才透過 activeTab 取得該分頁權限
//   2. 敏感網站、非 http(s) 頁面一律拒絕
//   3. 翻譯請求要驗證來源、型別、長度與每頁次數
//   4. log 只記錄錯誤類型，絕不記錄原文

const GTX_PERMISSION = { origins: ['https://translate.googleapis.com/*'] }
const FETCH_TIMEOUT_MS = 8000
const CACHE_LIMIT = 3000
// 注意: 必須與 content-shared.js 的 MAX_TEXT_CHARS 一致（兩邊執行環境不同，無法共用常數）
const MAX_TEXT_CHARS = 2000
// 決策: 一般網頁上限壓低以防惡意頁面灌爆；YouTube 長片字幕句數多，另設較高上限
const MAX_REQUESTS_PER_PAGE = 500
const MAX_REQUESTS_YOUTUBE = 5000
const YOUTUBE_HOST = 'www.youtube.com'

// 即使使用者手動觸發也拒絕翻譯的網域（含子網域）
// 使用者可在彈窗新增，存在 storage.local 的 denylistExtra
const DEFAULT_DENYLIST = [
  'mail.google.com',
  'accounts.google.com',
  'myaccount.google.com',
  'pay.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'login.microsoftonline.com',
  'appleid.apple.com',
  'icloud.com',
  'paypal.com',
  'stripe.com',
  '1password.com',
  'bitwarden.com',
  'lastpass.com',
  'web.whatsapp.com',
  'messenger.com',
  'web.telegram.org',
  'cathaybk.com.tw',
  'fubon.com',
  'post.gov.tw'
]
// 決策: 網域含 bank 一律視為網銀；寧可誤擋（例如 bankrate.com），也不要漏擋
const BANK_HOST_RE = /bank/i

const SCRIPT_FILES = {
  page: ['content-shared.js', 'content-page.js', 'content-index.js'],
  youtube: ['content-shared.js', 'content-youtube.js', 'content-index.js']
}

const BADGES = {
  started: { text: 'ON', color: '#2e7d32' },
  stopped: { text: '', color: '#000000' },
  blocked: { text: '✕', color: '#c62828' },
  denied: { text: '✕', color: '#c62828' },
  'no-permission': { text: '!', color: '#c62828' },
  error: { text: '!', color: '#c62828' }
}

// 快取只放記憶體，service worker 被回收就消失，不落地
const cache = new Map()
// 注意: service worker 閒置被回收時計數會歸零，所以這是軟性上限，不是硬保證
const requestCount = new Map()

/* ---------- 翻譯引擎 ---------- */

async function translateGtx(text) {
  const res = await fetch(
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-TW&dt=t',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      // 決策: 用 POST body 傳文字，避免長句超過 URL 長度限制
      body: new URLSearchParams({ q: text }),
      // 決策: 一定要有逾時，否則卡住的請求會一直佔用併發額度
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    }
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  // 回傳格式為分段陣列 [[譯文, 原文, ...], ...]，需要串起來
  return data[0].map((seg) => seg[0]).join('')
}

// 引擎登錄表：Phase 2 會在這裡加入本機 Translator API
const PROVIDERS = {
  gtx: { translate: translateGtx, permission: GTX_PERMISSION }
}
const ACTIVE_PROVIDER = PROVIDERS.gtx

const hasProviderPermission = () => chrome.permissions.contains(ACTIVE_PROVIDER.permission)

/* ---------- 網站黑名單 ---------- */

async function isDenied(rawUrl) {
  if (!rawUrl) return true
  let url
  try {
    url = new URL(rawUrl)
  } catch (err) {
    console.warn('[bilingual] 網址無法解析，拒絕翻譯', err.name)
    return true
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return true

  const host = url.hostname.toLowerCase()
  if (BANK_HOST_RE.test(host)) return true

  const { denylistExtra } = await chrome.storage.local.get({ denylistExtra: [] })
  return [...DEFAULT_DENYLIST, ...denylistExtra].some((d) => host === d || host.endsWith(`.${d}`))
}

/* ---------- 分頁啟停 ---------- */

function setBadge(tabId, status) {
  const badge = BADGES[status] || BADGES.error
  chrome.action.setBadgeText({ tabId, text: badge.text })
  chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color })
}

/**
 * 對分頁切換翻譯狀態，並回傳結果
 *
 * 決策: 黑名單與權限在注入「之前」檢查，被拒的頁面完全不會載入內容腳本
 * 注意: 呼叫端必須來自使用者手勢（工具列、快捷鍵），activeTab 才會給 tab.url
 * Returns:
 *   string: started | stopped | blocked | denied | no-permission | error（不拋例外）
 */
async function toggleTab(tab) {
  let status
  try {
    if (await isDenied(tab.url)) {
      status = 'denied'
    } else if (!(await hasProviderPermission())) {
      status = 'no-permission'
    } else {
      const isYouTube = new URL(tab.url).hostname === YOUTUBE_HOST
      const target = { tabId: tab.id }
      await chrome.scripting.executeScript({ target, files: isYouTube ? SCRIPT_FILES.youtube : SCRIPT_FILES.page })
      const [{ result }] = await chrome.scripting.executeScript({ target, func: () => window.BT.toggle() })
      status = result
      // YouTube 已由 manifest 靜態注入 CSS；一般網頁跟著啟停插入/移除，避免重複堆疊
      if (!isYouTube && status === 'started') await chrome.scripting.insertCSS({ target, files: ['style.css'] })
      if (!isYouTube && status === 'stopped') await chrome.scripting.removeCSS({ target, files: ['style.css'] })
    }
  } catch (err) {
    // 例如 Chrome Web Store 頁面禁止注入
    console.error('[bilingual] 無法在此分頁執行', err.name, err.message)
    status = 'error'
  }
  setBadge(tab.id, status)
  return status
}

/* ---------- 訊息處理 ---------- */

function handleTranslate(msg, sender, sendResponse) {
  const tabId = sender.tab?.id
  const text = msg.text
  if (tabId === undefined || typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_CHARS) {
    sendResponse({ ok: false, error: 'invalid-request' })
    return false
  }

  if (cache.has(text)) {
    sendResponse({ ok: true, text: cache.get(text) })
    return false
  }

  const isYouTube = sender.url?.startsWith(`https://${YOUTUBE_HOST}/`)
  const limit = isYouTube ? MAX_REQUESTS_YOUTUBE : MAX_REQUESTS_PER_PAGE
  const count = (requestCount.get(tabId) || 0) + 1
  if (count > limit) {
    sendResponse({ ok: false, error: 'quota-exceeded' })
    return false
  }
  requestCount.set(tabId, count)

  hasProviderPermission()
    .then((granted) => {
      if (!granted) throw new Error('no-permission')
      return ACTIVE_PROVIDER.translate(text)
    })
    .then((zh) => {
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
      cache.set(text, zh)
      sendResponse({ ok: true, text: zh })
    })
    .catch((err) => {
      // 注意: 只記錄錯誤類型與訊息，不記錄 text，避免原文留在 log
      console.error('[bilingual] 翻譯失敗', err.name, err.message)
      sendResponse({ ok: false, error: err.message === 'no-permission' ? 'no-permission' : 'translate-failed' })
    })
  // 決策: return true 讓 sendResponse 可以非同步回傳
  return true
}

function handleToggleFromPopup(msg, sender, sendResponse) {
  if (sender.url !== chrome.runtime.getURL('popup.html') || !Number.isInteger(msg.tabId)) {
    sendResponse({ status: 'error' })
    return false
  }
  chrome.tabs
    .get(msg.tabId)
    .then(toggleTab)
    .then((status) => sendResponse({ status }))
    .catch((err) => {
      console.error('[bilingual] 找不到分頁', err.name, err.message)
      sendResponse({ status: 'error' })
    })
  return true
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 只接受本擴充自己的內容腳本與彈窗
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== 'object') return false
  if (msg.type === 'translate') return handleTranslate(msg, sender, sendResponse)
  if (msg.type === 'toggle-tab') return handleToggleFromPopup(msg, sender, sendResponse)
  return false
})

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-translate' && tab) toggleTab(tab)
})

// 換頁時重置每頁配額與徽章
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'loading') return
  requestCount.delete(tabId)
  chrome.action.setBadgeText({ tabId, text: '' })
})

chrome.tabs.onRemoved.addListener((tabId) => requestCount.delete(tabId))
