// 彈窗：觸發翻譯、管理 Google 翻譯權限、外觀設定與黑名單
const Settings = window.BT_SETTINGS
const GTX_PERMISSION = { origins: ['https://translate.googleapis.com/*'] }
// 只接受合法網域字元，避免存入奇怪的字串
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

const STATUS_TEXT = {
  started: '已開始翻譯此頁',
  stopped: '已還原',
  blocked: '此頁有密碼欄位，已拒絕翻譯',
  denied: '敏感網站或不支援的頁面，已拒絕翻譯',
  'no-permission': '請先在下方允許使用 Google 翻譯',
  error: '無法在此頁執行'
}

const $ = (id) => document.getElementById(id)

async function refreshGtx() {
  const granted = await chrome.permissions.contains(GTX_PERMISSION)
  $('gtx-state').textContent = granted ? '狀態：已允許' : '狀態：未允許（翻譯功能無法使用）'
  $('gtx-grant').hidden = granted
  $('gtx-revoke').hidden = !granted
}

// 預覽只反映畫面上的值，存檔在 change 事件
function renderAppearance() {
  const draft = Settings.sanitize({ bgColor: $('bg-color').value, fontScale: $('font-scale').value })
  Settings.applyTo($('preview'), draft)
  $('font-scale-value').textContent = `${draft.fontScale}%`
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
$('bg-color').addEventListener('change', () => {
  chrome.storage.sync.set({ bgColor: Settings.sanitize({ bgColor: $('bg-color').value }).bgColor })
})
$('font-scale').addEventListener('change', () => {
  chrome.storage.sync.set({ fontScale: Settings.sanitize({ fontScale: $('font-scale').value }).fontScale })
})

$('reset-appearance').addEventListener('click', () => {
  const { bgColor, fontScale } = Settings.DEFAULTS
  chrome.storage.sync.set({ bgColor, fontScale })
  fillAppearance(Settings.DEFAULTS)
})

$('position').addEventListener('change', () => {
  chrome.storage.sync.set({ position: $('position').value })
})

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
  $('denylist-status').textContent = invalid.length > 0 ? `已儲存，忽略無效項：${invalid.join(', ')}` : '已儲存'
})

$('font-scale').min = Settings.FONT_SCALE_MIN
$('font-scale').max = Settings.FONT_SCALE_MAX

Settings.load().then((settings) => {
  $('position').value = settings.position
  $('youtube-auto').checked = settings.youtubeAuto
  fillAppearance(settings)
})

chrome.storage.local.get({ denylistExtra: [] }).then(({ denylistExtra }) => {
  $('denylist').value = denylistExtra.join('\n')
})

refreshGtx()
