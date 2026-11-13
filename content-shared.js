// 內容腳本共用層：工具函式與狀態
// 決策: 用全域命名空間 window.BT，因為 content script 不支援 ES module import
// 注意: 載入順序由 manifest.json 的 js 陣列保證：shared → page / youtube → index
(() => {
  if (window.BT) return

  const MIN_CHARS = 15
  const CONCURRENCY = 4
  const THROTTLE_MS = 500

  // 所有模式共用的可變狀態，stop() 會統一清理這裡的資源
  const state = {
    enabled: false,
    session: 0, // 每次 start/stop 遞增；舊的非同步任務比對不上就丟棄
    position: 'below', // 網頁譯文位置：'below' | 'above'
    io: null,
    mo: null,
    timer: null,
    queue: [],
    active: 0,
    yt: null // YouTube 譯文 overlay 節點
  }

  const normalize = (s) => s.replace(/\s+/g, ' ').trim()

  // 決策: 用 textContent 判斷而非 innerText，innerText 會強制重排，整頁掃描會卡
  function looksEnglish(text) {
    if (text.length < MIN_CHARS) return false
    const letters = (text.match(/[A-Za-z]/g) || []).length
    const nonSpace = text.replace(/\s/g, '').length
    return letters / nonSpace > 0.6 && text.split(' ').length >= 3
  }

  // 決策: 併發上限 4，避免頁面一次送出上百個請求被限流
  function pump() {
    while (state.active < CONCURRENCY && state.queue.length > 0) {
      const job = state.queue.shift()
      state.active += 1
      job().finally(() => {
        state.active -= 1
        pump()
      })
    }
  }

  function enqueue(job) {
    state.queue.push(job)
    pump()
  }

  // 決策: 失敗回傳 null 而非拋錯，由呼叫端決定是否復原狀態
  function translate(text) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'translate', text }, (res) => {
        if (chrome.runtime.lastError) {
          console.error('[bilingual] 無法連線背景服務', chrome.runtime.lastError.message)
          resolve(null)
          return
        }
        resolve(res && res.ok ? res.text : null)
      })
    })
  }

  // 節流：固定視窗內最多執行一次。debounce 在 YouTube 持續變動時會永遠不執行
  function schedule(fn, ms) {
    if (state.timer) return
    state.timer = setTimeout(() => {
      state.timer = null
      fn()
    }, ms)
  }

  window.BT = {
    DONE_ATTR: 'data-bt-done',
    THROTTLE_MS,
    state,
    normalize,
    looksEnglish,
    enqueue,
    translate,
    schedule
  }
})()
