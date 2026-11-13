// 內容腳本入口：提供 toggle 給 background 呼叫、依網站分流、統一啟停
// 決策: 一般網頁不再自動翻譯，只有 background 經使用者點擊注入後呼叫 BT.toggle()
// 決策: 設定改變時一律 stop 再 start，因為已插入的譯文位置需要重排
(() => {
  // 注意: 每次點擊都會重新注入，避免重複綁定監聽
  if (window.__btLoaded) return
  window.__btLoaded = true

  const BT = window.BT
  const { DONE_ATTR, state } = BT
  const SYNC_DEFAULTS = { position: 'below', youtubeAuto: false }
  const isYouTube = location.hostname === 'www.youtube.com'

  function start(settings) {
    if (state.enabled) return
    state.enabled = true
    state.position = settings.position
    state.session += 1
    const session = state.session

    if (isYouTube) {
      BT.youtube.start(session)
    } else {
      BT.page.start(session)
    }
  }

  function stop() {
    state.enabled = false
    // 讓所有尚未完成的非同步任務失效
    state.session += 1
    state.io?.disconnect()
    state.io = null
    state.mo?.disconnect()
    state.mo = null
    clearTimeout(state.timer)
    state.timer = null
    state.queue.length = 0
    state.yt?.remove()
    state.yt = null
    document.querySelectorAll('.bt-zh').forEach((n) => n.remove())
    document.querySelectorAll(`[${DONE_ATTR}]`).forEach((n) => n.removeAttribute(DONE_ATTR))
  }

  // 資安: 頁面有密碼欄位通常是登入頁或帳戶頁，整頁拒絕翻譯
  const hasPasswordField = () => document.querySelector('input[type="password"]') !== null

  /**
   * 切換本頁翻譯狀態
   *
   * Returns:
   *   Promise<string>: 'started' | 'stopped' | 'blocked'（不拋例外）
   */
  async function toggle() {
    if (state.enabled) {
      stop()
      return 'stopped'
    }
    if (hasPasswordField()) return 'blocked'
    start(await chrome.storage.sync.get(SYNC_DEFAULTS))
    return 'started'
  }

  BT.toggle = toggle

  if (isYouTube) {
    chrome.storage.sync.get(SYNC_DEFAULTS).then((settings) => {
      if (settings.youtubeAuto) start(settings)
    })
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return
    chrome.storage.sync.get(SYNC_DEFAULTS).then((settings) => {
      if (isYouTube && changes.youtubeAuto) {
        if (settings.youtubeAuto) {
          start(settings)
        } else {
          stop()
        }
        return
      }
      if (changes.position && state.enabled) {
        stop()
        start(settings)
      }
    })
  })
})()
