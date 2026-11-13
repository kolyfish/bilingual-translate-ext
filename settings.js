// 設定的唯一來源：預設值、驗證、文字顏色計算
// 決策: 彈窗、內容腳本、background 都載入這支檔案，避免預設值各寫一份
// 注意: 用 globalThis 而非 window，因為 background 是 service worker，沒有 window
// 注意: storage.sync 可能被其他裝置或舊版本寫入，讀出來一律先 sanitize
(() => {
  if (globalThis.BT_SETTINGS) return

  // 'local' = Chrome 內建 Translator API（文字不離開電腦）
  // 'claude' = 使用者自己的 Anthropic API 金鑰；'gtx' = Google 線上翻譯
  const ENGINES = ['local', 'claude', 'gtx']

  // 價格單位：美元 / 百萬 tokens，只用來在彈窗估算當日花費
  // 注意: 價格會變，以 Anthropic 官方價目為準；fallback 到其他模型時實際費率可能不同
  const CLAUDE_MODELS = {
    'claude-opus-5-5': { label: 'Opus 5.5', note: '品質最好', input: 4, output: 20 },
    'claude-haiku-5-5': { label: 'Haiku 5.5', note: '便宜、快', input: 0.1, output: 0.5 }
  }

  const DEFAULTS = {
    // 決策: 預設本機，線上引擎都要使用者主動切換並授權
    engine: 'local',
    claudeModel: 'claude-opus-5-5',
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
      // 資安: 只接受已知的引擎名稱，其他任何值都退回本機
      engine: ENGINES.includes(s.engine) ? s.engine : 'local',
      claudeModel: Object.hasOwn(CLAUDE_MODELS, s.claudeModel) ? s.claudeModel : DEFAULTS.claudeModel,
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

  globalThis.BT_SETTINGS = {
    DEFAULTS,
    ENGINES,
    CLAUDE_MODELS,
    FONT_SCALE_MIN,
    FONT_SCALE_MAX,
    sanitize,
    load,
    textColorFor,
    applyTo,
    clearFrom
  }
})()
