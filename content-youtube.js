// YouTube 即時雙語字幕模式
// 決策: 讀取播放器已渲染的英文字幕 DOM，不自行抓 timedtext
// 原因: 不需解析字幕檔，且與播放器時間軸自動同步
// 缺點: 依賴 YouTube DOM 結構（.caption-visual-line / .ytp-caption-segment），改版時需調整
//
// 決策: 隱藏原生字幕，改畫自己的雙語框（英文在上、中文固定貼底）
// 原因: 舊做法把中文塞進 YouTube 字幕框，自動字幕逐字更新時整框重排，中文會被下一行英文推走
//
// 決策: 自動字幕「逐字長出來」時不馬上翻，等停頓或換行才翻
// 原因: 每冒一個字就送一次翻譯，請求量暴增，實測會被 Google 限流（302 到 /sorry）
(() => {
  const BT = window.BT
  // 注意: manifest 靜態注入後，按 Alt+A 會再注入一次，已載入就不重複定義
  if (BT.youtube) return
  const { state, normalize, enqueue, translate, schedule } = BT

  const PLAYER_SELECTOR = '#movie_player'
  const LINE_SELECTOR = '.ytp-caption-window-container .caption-visual-line'
  const SEGMENT_SELECTOR = '.ytp-caption-window-container .ytp-caption-segment'
  const HIDE_NATIVE_CLASS = 'bt-yt-hide-native'
  // 英文要跟上語音，節流比網頁模式（500ms）短很多
  const SYNC_THROTTLE_MS = 150
  // 逐字增加時，停頓這麼久才翻
  const STABLE_MS = 700
  // 講者一直不停時，最多等這麼久就先翻一次，避免中文一直落後
  const MAX_WAIT_MS = 2500

  let box = null
  let enEl = null
  let zhEl = null
  let stableTimer = null

  function ensureBox(player) {
    if (!box) {
      box = document.createElement('div')
      box.className = 'bt-yt-box'
      enEl = document.createElement('div')
      enEl.className = 'bt-yt-en'
      zhEl = document.createElement('div')
      zhEl.className = 'bt-yt-zh'
      box.append(enEl, zhEl)
    }
    // YouTube 換影片時可能重建播放器，每次都確認掛載位置
    if (box.parentElement !== player) player.appendChild(box)
    player.classList.add(HIDE_NATIVE_CLASS)
    // 字級跟著播放器寬度縮放，一般、劇院、全螢幕模式都適用
    box.style.setProperty('--bt-yt-base', `${Math.max(14, Math.round(player.clientWidth * 0.026))}px`)
  }

  function readLines() {
    const lines = [...document.querySelectorAll(LINE_SELECTOR)]
      .map((l) => normalize(l.textContent))
      .filter(Boolean)
    if (lines.length > 0) return lines
    // 沒有 caption-visual-line 的舊版 DOM：整段當成一行
    const text = normalize([...document.querySelectorAll(SEGMENT_SELECTOR)].map((s) => s.textContent).join(' '))
    return text ? [text] : []
  }

  function stop() {
    clearTimeout(stableTimer)
    stableTimer = null
    box?.remove()
    box = null
    enEl = null
    zhEl = null
    document.querySelector(PLAYER_SELECTOR)?.classList.remove(HIDE_NATIVE_CLASS)
  }

  function start(session) {
    let lastSeen = ''
    let requestedText = ''
    let lastRequestAt = 0

    const request = (text) => {
      clearTimeout(stableTimer)
      stableTimer = null
      if (text === requestedText) return
      requestedText = text
      lastRequestAt = Date.now()
      enqueue(async () => {
        const zh = await translate(text)
        // 只接受最新一次請求的結果，避免舊句子的譯文蓋掉新的
        if (session !== state.session || text !== requestedText || !zh || !zhEl) return
        zhEl.textContent = zh
      })
    }

    const sync = () => {
      const player = document.querySelector(PLAYER_SELECTOR)
      const lines = readLines()

      if (!player || lines.length === 0) {
        if (box) box.hidden = true
        if (zhEl) zhEl.textContent = ''
        lastSeen = ''
        requestedText = ''
        return
      }

      ensureBox(player)
      box.hidden = false
      // 英文直接鏡像 YouTube 的行，不經翻譯，所以沒有延遲
      enEl.textContent = lines.join('\n')

      const text = lines.join(' ')
      if (text === lastSeen) return
      // 新文字以舊文字開頭 = 自動字幕逐字長出來；否則是換了一句（或捲掉一行）
      const growing = lastSeen !== '' && text.startsWith(lastSeen)
      lastSeen = text

      if (!growing || Date.now() - lastRequestAt >= MAX_WAIT_MS) {
        request(text)
        return
      }
      clearTimeout(stableTimer)
      stableTimer = setTimeout(() => request(lastSeen), STABLE_MS)
    }

    state.mo = new MutationObserver(() => schedule(sync, SYNC_THROTTLE_MS))
    state.mo.observe(document.body, { childList: true, subtree: true, characterData: true })
    sync()
  }

  BT.youtube = { start, stop }
})()
