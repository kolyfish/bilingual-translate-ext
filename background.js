// 翻譯代理：內容腳本的跨域請求受頁面 CORS 限制，統一交由 background 發送
// 決策: 引擎登錄表 PROVIDERS，每個引擎只需實作 translate(text) → Promise<string>
// 注意: 目前只啟用 gtx（非官方端點，可能限流或變動）

const FETCH_TIMEOUT_MS = 8000
const CACHE_LIMIT = 3000
// 同一句話不重複打 API（YouTube 滾動字幕會反覆出現相同片段）
const cache = new Map()

async function translateGtx(text) {
  const res = await fetch(
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-TW&dt=t',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      // 決策: 用 POST body 傳文字，避免長句超過 URL 長度限制
      body: new URLSearchParams({ q: text }),
      // 決策: 逾時必須有，否則 service worker 會一直掛著佔住併發額度
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    }
  )
  if (!res.ok) throw new Error(`翻譯 HTTP ${res.status}`)
  const data = await res.json()
  // 回傳格式為分段陣列 [[譯文, 原文, ...], ...]，需要串起來
  return data[0].map((seg) => seg[0]).join('')
}

// 引擎登錄表：要換成 Claude / DeepL 只需在這裡新增一筆並切換 ACTIVE_PROVIDER
const PROVIDERS = {
  gtx: { translate: translateGtx }
}
const ACTIVE_PROVIDER = PROVIDERS.gtx

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'translate') return false

  const text = msg.text
  if (cache.has(text)) {
    sendResponse({ ok: true, text: cache.get(text) })
    return false
  }

  ACTIVE_PROVIDER.translate(text)
    .then((zh) => {
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
      cache.set(text, zh)
      sendResponse({ ok: true, text: zh })
    })
    .catch((err) => {
      console.error('[bilingual] 翻譯失敗', err)
      sendResponse({ ok: false, error: String(err) })
    })
  // 決策: return true 讓 sendResponse 可以非同步回傳
  return true
})
