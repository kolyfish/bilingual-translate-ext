// YouTube 即時雙語字幕模式
// 決策: 直接讀取播放器已渲染的英文字幕 DOM，不自行抓 timedtext
// 原因: 不需解析字幕檔，且與播放器時間軸自動同步
// 缺點: 依賴 YouTube DOM 結構（.ytp-caption-segment），改版時需調整
// 注意: 需使用者先開英文 CC；字幕滾動頻繁變動，靠節流與 lastText 比對控制成本
(() => {
  const BT = window.BT
  const { THROTTLE_MS, state, normalize, enqueue, translate, schedule } = BT

  const CAPTION_SEGMENT_SELECTOR = '.ytp-caption-window-container .ytp-caption-segment'

  function start(session) {
    let lastText = ''

    // 決策: overlay 掛在字幕文字區塊內，才能緊貼英文字幕下方
    const attachOverlay = (seg) => {
      if (!state.yt) {
        state.yt = document.createElement('div')
        state.yt.className = 'bt-yt-zh'
      }
      // YouTube 重繪字幕時會移除 overlay，所以每次同步都要確認掛載位置
      const host = seg.closest('.captions-text') || seg.parentElement
      if (state.yt.parentElement !== host) host.appendChild(state.yt)
    }

    const sync = () => {
      const segs = [...document.querySelectorAll(CAPTION_SEGMENT_SELECTOR)]
      const text = normalize(segs.map((s) => s.textContent).join(' '))

      if (!text) {
        lastText = ''
        state.yt?.remove()
        return
      }

      attachOverlay(segs[0])
      if (text === lastText) return

      lastText = text
      enqueue(async () => {
        const zh = await translate(text)
        // 字幕已換成新句子就丟掉這筆結果，避免閃回舊譯文
        if (session !== state.session || text !== lastText || !zh || !state.yt) return
        state.yt.textContent = zh
      })
    }

    state.mo = new MutationObserver(() => schedule(sync, THROTTLE_MS))
    state.mo.observe(document.body, { childList: true, subtree: true, characterData: true })
    sync()
  }

  BT.youtube = { start }
})()
