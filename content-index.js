// 內容腳本入口：提供 toggle 給 background 呼叫、依網站分流、統一啟停
// 決策: 一般網頁不再自動翻譯，只有 background 經使用者點擊注入後呼叫 BT.toggle()
// 決策: 位置或引擎改變時一律 stop 再 start；底色、字級只重套 CSS 變數
(() => {
  // 注意: 每次點擊都會重新注入，避免重複綁定監聽
  if (window.__btLoaded) return
  window.__btLoaded = true

  const BT = window.BT
  const Settings = window.BT_SETTINGS
  const { DONE_ATTR, state } = BT
  const isYouTube = location.hostname === 'www.youtube.com'
  // 決策: 外觀變數掛在 <html> 上，改顏色或字級時所有譯文即時生效，不用重建
  const root = document.documentElement

  function start(settings) {
    if (state.enabled) return
    state.enabled = true
    state.engine = settings.engine
    state.position = settings.position
    Settings.applyTo(root, settings)
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
    if (isYouTube) BT.youtube.stop()
    removeBanner()
    document.querySelectorAll('.bt-zh').forEach((n) => n.remove())
    document.querySelectorAll(`[${DONE_ATTR}]`).forEach((n) => n.removeAttribute(DONE_ATTR))
    Settings.clearFrom(root)
  }

  // 讓 background 更新工具列徽章（例如在頁面上按完下載之後）
  const reportStatus = (status) => chrome.runtime.sendMessage({ type: 'report-status', status })

  /* ---------- 本機模型下載提示條 ---------- */

  const removeBanner = () => document.querySelector('.bt-banner')?.remove()

  /**
   * 在頁面右下角顯示「下載本機翻譯模型」提示條
   *
   * 決策: 下載只能由頁面上的點擊觸發，因為 Translator.create() 需要該頁面的使用者手勢，
   *       工具列與快捷鍵都不算。語言包下載一次後整個瀏覽器共用 [待驗證]
   * 注意: 一律用 createElement + textContent 建 DOM，不拼 HTML 字串
   */
  function showDownloadBanner(settings) {
    if (document.querySelector('.bt-banner')) return
    const banner = document.createElement('div')
    banner.className = 'bt-banner'
    const message = document.createElement('div')
    message.textContent = '第一次使用本機翻譯，需要下載英翻繁中語言包（只需一次，之後離線可用）'
    const status = document.createElement('div')
    status.className = 'bt-banner-status'
    const actions = document.createElement('div')
    const download = document.createElement('button')
    download.textContent = '下載並翻譯'
    const cancel = document.createElement('button')
    cancel.textContent = '取消'
    actions.append(download, cancel)
    banner.append(message, status, actions)
    document.body.appendChild(banner)

    cancel.addEventListener('click', () => {
      removeBanner()
      reportStatus('stopped')
    })

    download.addEventListener('click', () => {
      download.disabled = true
      status.textContent = '下載中 0%'
      // 注意: 這裡必須同步呼叫，不能先 await 其他東西，否則可能失去使用者手勢
      BT.downloadLocal((loaded) => {
        status.textContent = `下載中 ${Math.round(loaded * 100)}%`
      })
        .then(() => {
          removeBanner()
          start(settings)
          reportStatus('started')
        })
        .catch((err) => {
          console.error('[bilingual] 本機模型下載失敗', err.name, err.message)
          status.textContent = `下載失敗（${err.name}），可在彈窗改用 Google 翻譯`
          download.disabled = false
        })
    })
  }

  /* ---------- 啟動前檢查 ---------- */

  /**
   * 依引擎決定能不能直接開始
   *
   * Returns:
   *   Promise<string|null>: null = 可以開始；否則是要回報的狀態
   *   'local-unavailable'：瀏覽器不支援或這組語言不支援
   *   'needs-download'：已在頁面顯示下載提示條
   */
  async function checkEngine(settings) {
    if (settings.engine !== 'local') return null
    const availability = await BT.localAvailability()
    if (availability === 'available') return null
    if (availability === 'downloadable' || availability === 'downloading') {
      showDownloadBanner(settings)
      return 'needs-download'
    }
    return 'local-unavailable'
  }

  async function tryStart(settings) {
    const blocker = await checkEngine(settings)
    if (blocker) return blocker
    start(settings)
    return 'started'
  }

  // 資安: 頁面有密碼欄位通常是登入頁或帳戶頁，整頁拒絕翻譯
  const hasPasswordField = () => document.querySelector('input[type="password"]') !== null

  /**
   * 切換本頁翻譯狀態
   *
   * Returns:
   *   Promise<string>: 'started' | 'stopped' | 'blocked' | 'needs-download' | 'local-unavailable'（不拋例外）
   */
  async function toggle() {
    if (state.enabled) {
      stop()
      return 'stopped'
    }
    // 提示條還在時再按一次，視為取消
    if (document.querySelector('.bt-banner')) {
      removeBanner()
      return 'stopped'
    }
    if (hasPasswordField()) return 'blocked'
    return tryStart(await Settings.load())
  }

  BT.toggle = toggle

  if (isYouTube) {
    Settings.load().then((settings) => {
      if (settings.youtubeAuto) tryStart(settings).then(reportStatus)
    })
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return
    Settings.load().then((settings) => {
      if (state.enabled && (changes.bgColor || changes.fontScale)) {
        Settings.applyTo(root, settings)
      }
      if (isYouTube && changes.youtubeAuto) {
        if (settings.youtubeAuto) {
          tryStart(settings).then(reportStatus)
        } else {
          stop()
          reportStatus('stopped')
        }
        return
      }
      if ((changes.position || changes.engine) && state.enabled) {
        stop()
        tryStart(settings).then(reportStatus)
      }
    })
  })
})()
