// 內容腳本共用層：工具函式、狀態、翻譯引擎
// 決策: 用全域命名空間 window.BT，因為 content script 不支援 ES module import
// 注意: 載入順序由 manifest.json 與 background.js 的 SCRIPT_FILES 保證：settings → shared → page / youtube → index
(() => {
  if (window.BT) return

  const MIN_CHARS = 15
  // 注意: 必須與 background.js 的 MAX_TEXT_CHARS 一致，超過的段落不送出
  const MAX_TEXT_CHARS = 2000
  // 決策: Google 併發 4 避免被限流；本機引擎本來就依序處理，併發 1 避免佇列堆在模型裡
  // 決策: Claude 由 background 把同一頁的段落合併成一次請求，併發要夠大，一批才裝得滿
  const CONCURRENCY = { gtx: 4, local: 1, claude: 16 }
  const THROTTLE_MS = 500
  const LANG_PAIR = { sourceLanguage: 'en', targetLanguage: 'zh-Hant' }
  // 同一種錯誤只提示一次，避免每段都洗 console
  const warned = new Set()

  // 所有模式共用的可變狀態，stop() 會統一清理這裡的資源
  const state = {
    enabled: false,
    session: 0, // 每次 start/stop 遞增；舊的非同步任務比對不上就丟棄
    engine: 'local',
    position: 'below', // 網頁譯文位置：'below' | 'above'
    io: null,
    mo: null,
    timer: null,
    queue: [],
    active: 0
  }

  const normalize = (s) => s.replace(/\s+/g, ' ').trim()

  const warnOnce = (reason) => {
    if (warned.has(reason)) return
    warned.add(reason)
    console.warn('[bilingual] 翻譯被拒或失敗：', reason)
  }

  // 決策: 用 textContent 判斷而非 innerText，innerText 會強制重排，整頁掃描會卡
  function looksEnglish(text) {
    if (text.length < MIN_CHARS) return false
    const letters = (text.match(/[A-Za-z]/g) || []).length
    const nonSpace = text.replace(/\s/g, '').length
    return letters / nonSpace > 0.6 && text.split(' ').length >= 3
  }

  function pump() {
    const limit = CONCURRENCY[state.engine]
    while (state.active < limit && state.queue.length > 0) {
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

  /* ---------- 本機引擎：Chrome 內建 Translator API ---------- */

  // 整頁共用一個 translator；建立失敗就清掉，下次重試
  let localTranslator = null

  /**
   * 查詢本機語言包狀態
   *
   * Returns:
   *   Promise<string>: 'unsupported'（瀏覽器沒有這個 API）| 'unavailable' | 'downloadable' | 'downloading' | 'available'
   */
  async function localAvailability() {
    if (!('Translator' in globalThis)) return 'unsupported'
    return Translator.availability(LANG_PAIR)
  }

  /**
   * 下載語言包並建立 translator
   *
   * 注意: 語言包還沒下載時，Translator.create() 必須在使用者點擊後呼叫（transient user activation）
   *       所以只能從頁面上的按鈕觸發，從工具列或快捷鍵觸發都不算頁面上的手勢
   */
  function downloadLocal(onProgress) {
    localTranslator = Translator.create({
      ...LANG_PAIR,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => onProgress(e.loaded))
      }
    })
    localTranslator.catch(() => {
      localTranslator = null
    })
    return localTranslator
  }

  async function translateLocal(text) {
    try {
      if (!localTranslator) localTranslator = Translator.create(LANG_PAIR)
      const translator = await localTranslator
      return await translator.translate(text)
    } catch (err) {
      localTranslator = null
      warnOnce(`local:${err.name}`)
      return null
    }
  }

  /* ---------- 線上引擎：交給 background ---------- */

  function translateRemote(text) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'translate', text }, (res) => {
        if (chrome.runtime.lastError) {
          console.error('[bilingual] 無法連線背景服務', chrome.runtime.lastError.message)
          resolve(null)
          return
        }
        if (res && res.ok) {
          resolve(res.text)
          return
        }
        warnOnce(res ? res.error : 'no-response')
        resolve(null)
      })
    })
  }

  // 決策: 失敗回傳 null 而非拋錯，由呼叫端決定是否復原狀態
  const translate = (text) => (state.engine === 'local' ? translateLocal(text) : translateRemote(text))

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
    MAX_TEXT_CHARS,
    THROTTLE_MS,
    state,
    normalize,
    looksEnglish,
    enqueue,
    translate,
    schedule,
    localAvailability,
    downloadLocal
  }
})()
