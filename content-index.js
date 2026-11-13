// 內容腳本入口：讀取設定、依網站分流、統一啟停
// 決策: 設定改變時一律 stop 再 start，而不是原地修改，因為已插入的譯文位置需要重排
(() => {
  // 注意: 擴充套件重新載入或被重複注入時，避免綁定兩次監聽
  if (window.__btLoaded) return
  window.__btLoaded = true

  const BT = window.BT
  const { DONE_ATTR, state } = BT
  const DEFAULTS = { enabled: false, position: 'below' }

  function start(settings) {
    if (state.enabled) return
    state.enabled = true
    state.position = settings.position
    state.session += 1
    const session = state.session

    if (location.hostname.endsWith('youtube.com')) {
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

  chrome.storage.sync.get(DEFAULTS).then((settings) => {
    if (settings.enabled) start(settings)
  })

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || (!changes.enabled && !changes.position)) return
    chrome.storage.sync.get(DEFAULTS).then((settings) => {
      if (state.enabled) stop()
      if (settings.enabled) start(settings)
    })
  })
})()
