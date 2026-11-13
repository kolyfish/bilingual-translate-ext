// 彈窗：觸發翻譯、選擇引擎、管理 Google / Claude 權限與金鑰、外觀設定與黑名單
const Settings = window.BT_SETTINGS
const GTX_PERMISSION = { origins: ['https://translate.googleapis.com/*'] }
const CLAUDE_PERMISSION = { origins: ['https://api.anthropic.com/*'] }
// 只做基本格式檢查，擋掉貼錯東西；真正有效與否用「測試金鑰」確認
const CLAUDE_KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,}$/
const LANG_PAIR = { sourceLanguage: 'en', targetLanguage: 'zh-Hant' }
// 只接受合法網域字元，避免存入奇怪的字串
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

const STATUS_TEXT = {
  started: '正在翻譯這一頁。再按一次可以還原。',
  stopped: '已還原成原文。',
  blocked: '這一頁有密碼欄位，為了安全不翻譯。',
  denied: '這個網站在不翻譯清單上，或是 Chrome 不允許擴充在這裡執行。',
  'no-permission': '要先在下方允許連線，才能用線上翻譯。',
  'no-key': '要先在下方貼上 Claude API 金鑰。',
  'needs-download': '第一次使用：請按網頁右下角的「下載並翻譯」。',
  'local-unavailable': '這個 Chrome 不支援本機英翻繁中，可以改用 Google。',
  error: '這一頁無法翻譯。'
}

const LOCAL_STATE_TEXT = {
  available: '語言包已下載，可以離線翻譯，文字不會離開電腦。',
  downloadable: '還沒下載語言包，在英文網頁按 ⌥A 開始。',
  downloading: '語言包下載中。',
  unavailable: '這個 Chrome 不支援英翻繁中。',
  // 注意: 彈窗不一定有 Translator API，偵測不到不代表網頁上不能用
  unsupported: '文字在電腦上翻譯，不會送出去。'
}

const ENGINE_LABEL = { local: '本機', claude: 'Claude', gtx: 'Google' }

const CLAUDE_TEST_TEXT = {
  ok: ['金鑰可以使用。', 'ok'],
  'no-key': ['還沒有金鑰。', 'bad'],
  'no-permission': ['還沒允許連到 Anthropic。', 'bad'],
  'claude-auth': ['金鑰無效或已被撤銷。', 'bad'],
  'claude-rate-limit': ['請求太頻繁，稍後再試。', 'bad'],
  'claude-network': ['連不到 Anthropic，檢查網路後再試。', 'bad'],
  error: ['測試失敗，打開擴充的服務工作者主控台看錯誤。', 'bad']
}

const $ = (id) => document.getElementById(id)

async function refreshLocal() {
  const availability = 'Translator' in globalThis ? await Translator.availability(LANG_PAIR) : 'unsupported'
  $('local-state').textContent = LOCAL_STATE_TEXT[availability] ?? availability
}

function showEngine(engine) {
  for (const radio of document.querySelectorAll('input[name="engine"]')) radio.checked = radio.value === engine
  $('gtx-section').hidden = engine !== 'gtx'
  $('claude-section').hidden = engine !== 'claude'
  $('local-state').hidden = engine !== 'local'
  $('engine-chip').dataset.engine = engine
  $('engine-chip').textContent = ENGINE_LABEL[engine]
}

function checkRadio(name, value) {
  for (const radio of document.querySelectorAll(`input[name="${name}"]`)) radio.checked = radio.value === value
}

for (const radio of document.querySelectorAll('input[name="engine"]')) {
  radio.addEventListener('change', () => {
    const engine = Settings.sanitize({ engine: radio.value }).engine
    chrome.storage.sync.set({ engine })
    showEngine(engine)
  })
}

/* ---------- Claude ---------- */

function setClaudeState(text, tone) {
  $('claude-state').textContent = text
  $('claude-state').className = `note ${tone ?? ''}`
}

// 決策: 存好之後只顯示前綴與末 4 碼，金鑰不會再完整出現在畫面上
async function refreshClaude() {
  const { claudeApiKey: sessionKey } = await chrome.storage.session.get('claudeApiKey')
  const { claudeApiKey: localKey, claudeUsage } = await chrome.storage.local.get(['claudeApiKey', 'claudeUsage'])
  const key = sessionKey || localKey
  $('claude-key-empty').hidden = Boolean(key)
  $('claude-key-saved').hidden = !key
  if (key) {
    $('claude-key-mask').textContent = `sk-ant-…${key.slice(-4)}`
    $('claude-key-where').textContent = localKey ? '已記住' : '重開 Chrome 後要重新貼'
  }
  const today = new Date().toLocaleDateString('sv-SE')
  const usage = claudeUsage?.date === today ? claudeUsage : { requests: 0, costUsd: 0 }
  $('claude-usage').textContent = `今天 ${usage.requests} 次請求，約 US$${usage.costUsd.toFixed(3)}`
}

for (const radio of document.querySelectorAll('input[name="claude-model"]')) {
  radio.addEventListener('change', () => {
    chrome.storage.sync.set({ claudeModel: Settings.sanitize({ claudeModel: radio.value }).claudeModel })
  })
}

$('claude-save').addEventListener('click', () => {
  const key = $('claude-key').value.trim()
  if (!CLAUDE_KEY_RE.test(key)) {
    setClaudeState('這看起來不是 Anthropic API 金鑰，應該以 sk-ant- 開頭。', 'bad')
    return
  }
  const remember = $('claude-remember').checked
  // 注意: permissions.request 必須在點擊處理函式內直接呼叫，前面不能先 await
  chrome.permissions
    .request(CLAUDE_PERMISSION)
    .then(async (granted) => {
      if (!granted) {
        setClaudeState('沒有允許連到 Anthropic，金鑰沒有儲存。', 'bad')
        return
      }
      // 只存在一個地方，避免移除時漏掉另一份
      if (remember) {
        await chrome.storage.local.set({ claudeApiKey: key })
        await chrome.storage.session.remove('claudeApiKey')
      } else {
        await chrome.storage.session.set({ claudeApiKey: key })
        await chrome.storage.local.remove('claudeApiKey')
      }
      $('claude-key').value = ''
      setClaudeState('金鑰已儲存。', 'ok')
      await refreshClaude()
    })
    .catch((err) => {
      console.error('[bilingual] 儲存金鑰失敗', err.name, err.message)
      setClaudeState('儲存失敗。', 'bad')
    })
})

$('claude-remove').addEventListener('click', async () => {
  await chrome.storage.session.remove('claudeApiKey')
  await chrome.storage.local.remove('claudeApiKey')
  setClaudeState('金鑰已從這台電腦移除。若懷疑外洩，也請到 Anthropic Console 撤銷。')
  await refreshClaude()
})

$('claude-test').addEventListener('click', async () => {
  setClaudeState('測試中…')
  const res = await chrome.runtime.sendMessage({ type: 'claude-test' })
  const [text, tone] = CLAUDE_TEST_TEXT[res?.status] ?? CLAUDE_TEST_TEXT.error
  setClaudeState(text, tone)
})

async function refreshGtx() {
  const granted = await chrome.permissions.contains(GTX_PERMISSION)
  $('gtx-state').textContent = granted ? '已允許連到 Google。' : '還沒允許連到 Google，現在無法用 Google 翻譯。'
  $('gtx-grant').hidden = granted
  $('gtx-revoke').hidden = !granted
}

// 預覽只反映畫面上的值，存檔在 change 事件
function renderAppearance() {
  const draft = Settings.sanitize({ bgColor: $('bg-color').value, fontScale: $('font-scale').value })
  Settings.applyTo($('preview'), draft)
  $('font-scale-value').textContent = `${draft.fontScale}%`
  // 標出目前選中的色票；不在預設色票裡的顏色，標在「自訂」上
  let matched = false
  for (const swatch of document.querySelectorAll('.swatch[data-color]')) {
    const on = swatch.dataset.color === draft.bgColor
    swatch.setAttribute('aria-pressed', String(on))
    matched ||= on
  }
  document.querySelector('.swatch.custom').dataset.active = String(!matched)
}

const saveColor = (hex) => chrome.storage.sync.set({ bgColor: Settings.sanitize({ bgColor: hex }).bgColor })

for (const swatch of document.querySelectorAll('.swatch[data-color]')) {
  swatch.addEventListener('click', () => {
    $('bg-color').value = swatch.dataset.color
    renderAppearance()
    saveColor(swatch.dataset.color)
  })
}

function fillAppearance(settings) {
  $('bg-color').value = settings.bgColor
  $('font-scale').value = settings.fontScale
  renderAppearance()
}

$('toggle-page').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const res = await chrome.runtime.sendMessage({ type: 'toggle-tab', tabId: tab.id })
  $('status').textContent = STATUS_TEXT[res?.status] ?? STATUS_TEXT.error
})

// 注意: permissions.request 必須在使用者手勢內「直接」呼叫，前面不能先 await 其他東西
$('gtx-grant').addEventListener('click', () => {
  chrome.permissions.request(GTX_PERMISSION).then(refreshGtx)
})

$('gtx-revoke').addEventListener('click', () => {
  chrome.permissions.remove(GTX_PERMISSION).then(refreshGtx)
})

// 決策: 拖動時（input）只更新預覽，放開時（change）才寫入
// 原因: storage.sync 每分鐘最多寫 120 次，拖動滑桿或色盤會連續觸發，很快就超過
$('bg-color').addEventListener('input', renderAppearance)
$('font-scale').addEventListener('input', renderAppearance)
$('bg-color').addEventListener('change', () => saveColor($('bg-color').value))
$('font-scale').addEventListener('change', () => {
  chrome.storage.sync.set({ fontScale: Settings.sanitize({ fontScale: $('font-scale').value }).fontScale })
})

$('reset-appearance').addEventListener('click', () => {
  const { bgColor, fontScale } = Settings.DEFAULTS
  chrome.storage.sync.set({ bgColor, fontScale })
  fillAppearance(Settings.DEFAULTS)
})

for (const radio of document.querySelectorAll('input[name="position"]')) {
  radio.addEventListener('change', () => {
    chrome.storage.sync.set({ position: Settings.sanitize({ position: radio.value }).position })
  })
}

$('youtube-auto').addEventListener('change', () => {
  chrome.storage.sync.set({ youtubeAuto: $('youtube-auto').checked })
})

// 決策: 黑名單存 storage.local 不存 sync，瀏覽習慣不需要同步到 Google 帳號
$('save-denylist').addEventListener('click', async () => {
  const lines = $('denylist').value.split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const valid = [...new Set(lines.filter((s) => HOSTNAME_RE.test(s)))]
  const invalid = lines.filter((s) => !HOSTNAME_RE.test(s))
  await chrome.storage.local.set({ denylistExtra: valid })
  $('denylist').value = valid.join('\n')
  $('denylist-status').textContent = invalid.length > 0 ? `已儲存。這些不是網域，已略過：${invalid.join(', ')}` : '已儲存。'
})

$('font-scale').min = Settings.FONT_SCALE_MIN
$('font-scale').max = Settings.FONT_SCALE_MAX

Settings.load().then((settings) => {
  showEngine(settings.engine)
  checkRadio('claude-model', settings.claudeModel)
  checkRadio('position', settings.position)
  $('youtube-auto').checked = settings.youtubeAuto
  fillAppearance(settings)
})

chrome.storage.local.get({ denylistExtra: [] }).then(({ denylistExtra }) => {
  $('denylist').value = denylistExtra.join('\n')
})

refreshGtx()
refreshClaude().catch((err) => console.error('[bilingual] 無法讀取 Claude 設定', err.name, err.message))
refreshLocal().catch((err) => {
  console.error('[bilingual] 無法查詢本機語言包狀態', err.name, err.message)
  $('local-state').textContent = LOCAL_STATE_TEXT.unsupported
})
