// 設定的唯一來源：預設值、驗證、文字顏色計算
// 決策: 彈窗與內容腳本都載入這支檔案，避免預設值在兩邊各寫一份
// 注意: storage.sync 可能被其他裝置或舊版本寫入，讀出來一律先 sanitize
(() => {
  if (window.BT_SETTINGS) return

  const DEFAULTS = {
    position: 'below',
    youtubeAuto: false,
    bgColor: '#8b1a1a', // 深紅
    fontScale: 95 // 百分比，相對於原文字級
  }
  const FONT_SCALE_MIN = 70
  const FONT_SCALE_MAX = 160
  // 資安: 只接受 #rrggbb，避免把任意字串寫進頁面的 CSS 變數
  const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i
  const LIGHT_TEXT = '#fff5f5'
  const DARK_TEXT = '#1a1a1a'

  function sanitize(raw) {
    const s = { ...DEFAULTS, ...raw }
    const scale = Number(s.fontScale)
    return {
      position: s.position === 'above' ? 'above' : 'below',
      youtubeAuto: s.youtubeAuto === true,
      bgColor: HEX_COLOR_RE.test(s.bgColor) ? s.bgColor.toLowerCase() : DEFAULTS.bgColor,
      fontScale: Number.isFinite(scale)
        ? Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(scale)))
        : DEFAULTS.fontScale
    }
  }

  const load = async () => sanitize(await chrome.storage.sync.get(DEFAULTS))

  // WCAG 相對亮度
  function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }

  // 決策: 文字色不給使用者選，依底色挑對比度較高的黑或白，選淺色底也看得清楚
  function textColorFor(hex) {
    const l = luminance(hex)
    const contrastWithLight = (luminance(LIGHT_TEXT) + 0.05) / (l + 0.05)
    const contrastWithDark = (l + 0.05) / (luminance(DARK_TEXT) + 0.05)
    return contrastWithLight >= contrastWithDark ? LIGHT_TEXT : DARK_TEXT
  }

  // 套用到某個元素的 CSS 變數（頁面用 documentElement，彈窗預覽用預覽框）
  function applyTo(el, settings) {
    el.style.setProperty('--bt-bg', settings.bgColor)
    el.style.setProperty('--bt-fg', textColorFor(settings.bgColor))
    el.style.setProperty('--bt-scale', String(settings.fontScale / 100))
  }

  function clearFrom(el) {
    for (const name of ['--bt-bg', '--bt-fg', '--bt-scale']) el.style.removeProperty(name)
  }

  window.BT_SETTINGS = {
    DEFAULTS,
    FONT_SCALE_MIN,
    FONT_SCALE_MAX,
    sanitize,
    load,
    textColorFor,
    applyTo,
    clearFrom
  }
})()
