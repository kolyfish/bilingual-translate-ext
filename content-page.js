// 網頁雙語對照模式
// 決策: 只翻「最內層文字塊」，避免 li > p 這類父子元素重複翻譯
// 注意: 不在 youtube.com 啟用，由 content-index.js 分流
(() => {
  const BT = window.BT
  // 注意: 每次點擊都會重新注入，已載入就不重複定義
  if (BT.page) return
  const { DONE_ATTR, MAX_TEXT_CHARS, THROTTLE_MS, state, normalize, looksEnglish, enqueue, translate, schedule } = BT

  const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption, td, th'
  // 含這些子節點的元素不翻，由子節點自己翻
  const CONTAINER_SELECTOR = `${BLOCK_SELECTOR}, ul, ol, div, table`
  // 資安: 跳過隱藏元素，避免頁面用看不到的文字誘導翻譯或灌爆配額
  const SKIP_SELECTOR =
    'nav, pre, code, script, style, textarea, select, button, [contenteditable="true"], [hidden], [aria-hidden="true"], .bt-zh'
  const VISIBILITY_OPTIONS = { checkOpacity: true, checkVisibilityCSS: true }
  // 決策: 表格與列表項目一律把譯文放在元素內部，直接在 tr/ul 下插 div 會破壞結構
  const INSIDE_TAGS = new Set(['LI', 'TD', 'TH'])

  function isLeafBlock(el) {
    for (const child of el.querySelectorAll(CONTAINER_SELECTOR)) {
      // 自己插入的譯文不算結構子節點
      if (!child.closest('.bt-zh')) return false
    }
    return true
  }

  function collectBlocks(root) {
    return [...root.querySelectorAll(`${BLOCK_SELECTOR}, div`)].filter((el) => {
      if (el.hasAttribute(DONE_ATTR) || el.closest(SKIP_SELECTOR)) return false
      if (!isLeafBlock(el)) return false
      const text = normalize(el.textContent)
      return text.length <= MAX_TEXT_CHARS && looksEnglish(text)
    })
  }

  // 決策: above/below 只影響插入位置；INSIDE_TAGS 不論哪種都放在元素內部
  function renderBlock(el, zh) {
    const div = document.createElement('div')
    div.className = 'bt-zh'
    div.textContent = zh
    const above = state.position === 'above'
    if (INSIDE_TAGS.has(el.tagName)) {
      if (above) {
        el.insertBefore(div, el.firstChild)
      } else {
        el.appendChild(div)
      }
    } else {
      el.insertAdjacentElement(above ? 'beforebegin' : 'afterend', div)
    }
  }

  function scanPage(session) {
    if (session !== state.session || !state.io) return
    for (const el of collectBlocks(document.body)) {
      el.setAttribute(DONE_ATTR, '1')
      state.io.observe(el)
    }
  }

  function start(session) {
    // 決策: 只翻進入視窗附近（上下 300px）的段落，長頁面不會一次全部打 API
    state.io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const el = entry.target
          state.io.unobserve(el)
          // 決策: 可見性在進入視窗時才檢查，checkVisibility 會計算樣式，整頁掃描時做太貴
          // 注意: display:none 本來就不會觸發 intersect，這裡擋的是 visibility:hidden / opacity:0
          if (!el.checkVisibility(VISIBILITY_OPTIONS)) {
            el.removeAttribute(DONE_ATTR)
            continue
          }
          const text = normalize(el.textContent)
          enqueue(async () => {
            const zh = await translate(text)
            if (session !== state.session || !el.isConnected) return
            if (zh) {
              renderBlock(el, zh)
            } else {
              // 失敗時清掉標記，讓之後的掃描有機會重新觀察
              el.removeAttribute(DONE_ATTR)
            }
          })
        }
      },
      { rootMargin: '300px' }
    )

    scanPage(session)

    // 注意: SPA 或無限捲動會動態加入段落，需要持續掃描
    state.mo = new MutationObserver(() => schedule(() => scanPage(session), THROTTLE_MS))
    state.mo.observe(document.body, { childList: true, subtree: true })
  }

  BT.page = { start }
})()
