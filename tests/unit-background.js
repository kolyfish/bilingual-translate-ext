// 用假的 chrome 物件載入 background.js，測黑名單、引擎限制與訊息驗證邏輯
// 用法: node tests/unit-background.js（不需要任何套件）
const fs = require('fs')
const vm = require('vm')
const assert = require('assert')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const noop = { addListener() {} }
let extra = []
let granted = true
let syncData = {}
let fetchCalls = 0

const chrome = {
  runtime: { id: 'self', onMessage: noop, getURL: (p) => `chrome-extension://self/${p}` },
  commands: { onCommand: noop },
  tabs: { onUpdated: noop, onRemoved: noop },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  storage: {
    local: { get: async () => ({ denylistExtra: extra }) },
    sync: { get: async (defaults) => ({ ...defaults, ...syncData }) }
  },
  permissions: { contains: async () => granted }
}

const ctx = vm.createContext({
  chrome,
  console,
  URL,
  AbortSignal,
  fetch: async () => {
    fetchCalls += 1
    throw new Error('no network in test')
  }
})
// service worker 的 importScripts：在同一個 context 執行指定檔案
ctx.importScripts = (...files) => {
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx)
}
ctx.globalThis = ctx
vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), ctx)

;(async () => {
  const denied = (u) => ctx.isDenied(u)
  assert.equal(await denied('https://mail.google.com/mail/u/0'), true, 'Gmail 應被擋')
  assert.equal(await denied('https://www.paypal.com/x'), true, 'paypal 子網域應被擋')
  assert.equal(await denied('https://www.esunbank.com.tw/'), true, '含 bank 應被擋')
  assert.equal(await denied('https://www.cathaybk.com.tw/'), true, '國泰應被擋')
  assert.equal(await denied('chrome://settings'), true, '非 http 應被擋')
  assert.equal(await denied('file:///etc/passwd'), true, 'file 應被擋')
  assert.equal(await denied(undefined), true, '沒有 url（沒 activeTab）應被擋')
  assert.equal(await denied('not a url'), true, '壞網址應被擋')
  assert.equal(await denied('https://notpaypal.com/'), false, '只比對完整網域或子網域，不比對字串尾巴')
  assert.equal(await denied('https://medium.com/@a/b'), false, '一般網站應放行')
  assert.equal(await denied('https://www.youtube.com/watch?v=1'), false, 'YouTube 應放行')
  extra = ['example.com']
  assert.equal(await denied('https://docs.example.com/'), true, '自訂黑名單子網域應被擋')

  const call = (msg, sender) => new Promise((resolve) => ctx.handleTranslate(msg, sender, resolve))
  const tabSender = { id: 'self', tab: { id: 1 }, url: 'https://medium.com/x' }

  assert.equal((await call({ type: 'translate', text: 123 }, tabSender)).error, 'invalid-request', '非字串應拒')
  assert.equal((await call({ type: 'translate', text: '' }, tabSender)).error, 'invalid-request', '空字串應拒')
  assert.equal((await call({ type: 'translate', text: 'a'.repeat(2001) }, tabSender)).error, 'invalid-request', '超長應拒')
  assert.equal((await call({ type: 'translate', text: 'hello world test' }, { id: 'self' })).error, 'invalid-request', '沒有 tab 應拒')

  // 預設引擎是本機：任何線上翻譯請求都要被拒，而且完全不能發出 fetch
  syncData = {}
  fetchCalls = 0
  assert.equal((await call({ type: 'translate', text: 'hello world test' }, tabSender)).error, 'engine-local', '預設本機模式應拒絕線上請求')
  syncData = { engine: 'whatever' }
  assert.equal((await call({ type: 'translate', text: 'hello world test' }, tabSender)).error, 'engine-local', '引擎值不合法時應退回本機並拒絕')
  assert.equal(fetchCalls, 0, '本機模式下不能有任何對外連線')

  syncData = { engine: 'gtx' }
  granted = false
  assert.equal((await call({ type: 'translate', text: 'hello world test' }, tabSender)).error, 'no-permission', 'Google 模式沒權限應拒')
  granted = true

  // 配額：第 501 次應被拒（前面每次都會因 fetch 失敗回 translate-failed，但會計數）
  const quotaSender = { id: 'self', tab: { id: 2 }, url: 'https://medium.com/x' }
  let last
  for (let i = 0; i < 501; i++) last = await call({ type: 'translate', text: `sentence number ${i}` }, quotaSender)
  assert.equal(last.error, 'quota-exceeded', '一般網頁第 501 次應被拒')

  console.log('ALL TESTS PASSED')
})().catch((e) => {
  console.error('TEST FAILED:', e.message)
  process.exit(1)
})
