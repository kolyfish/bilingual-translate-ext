// 用假的 chrome 物件載入 background.js，測黑名單、引擎限制、Claude 合併請求與訊息驗證
// 用法: node tests/unit-background.js（不需要任何套件）
const fs = require('fs')
const vm = require('vm')
const assert = require('assert')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const noop = { addListener() {} }
let granted = true
let syncData = {}
let fetchCalls = 0

// 簡單的記憶體 storage
function memoryArea(initial = {}) {
  const store = { ...initial }
  return {
    store,
    get: async (keys) => {
      if (keys === undefined || keys === null) return { ...store }
      if (typeof keys === 'string') return keys in store ? { [keys]: store[keys] } : {}
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]))
      return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in store ? store[k] : d]))
    },
    set: async (obj) => Object.assign(store, obj),
    remove: async (k) => delete store[k],
    setAccessLevel: async () => {}
  }
}
const local = memoryArea({ denylistExtra: [] })
const session = memoryArea()

const chrome = {
  runtime: { id: 'self', onMessage: noop, getURL: (p) => `chrome-extension://self/${p}` },
  commands: { onCommand: noop },
  tabs: { onUpdated: noop, onRemoved: noop },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  storage: {
    local,
    session,
    sync: { get: async (defaults) => ({ ...defaults, ...syncData }) }
  },
  permissions: { contains: async () => granted }
}

// 假的 Anthropic SDK：只需要錯誤類別，client 由測試換掉
class FakeAPIError extends Error {}
class FakeAnthropic {}
FakeAnthropic.APIError = FakeAPIError
FakeAnthropic.AuthenticationError = class extends FakeAPIError {}
FakeAnthropic.PermissionDeniedError = class extends FakeAPIError {}
FakeAnthropic.RateLimitError = class extends FakeAPIError {}
FakeAnthropic.APIConnectionError = class extends FakeAPIError {}

const ctx = vm.createContext({
  chrome,
  console,
  URL,
  AbortSignal,
  setTimeout,
  clearTimeout,
  fetch: async () => {
    fetchCalls += 1
    throw new Error('no network in test')
  }
})
// service worker 的 importScripts：settings.js 照常執行；vendor 的 SDK 換成假的
ctx.importScripts = (...files) => {
  for (const f of files) {
    if (f.startsWith('vendor/')) ctx.Anthropic = FakeAnthropic
    else vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx)
  }
}
ctx.globalThis = ctx
vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), ctx)
// const 宣告不會掛在 ctx 上，用 runInContext 取得參考
const claude = vm.runInContext('claude', ctx)

const claudeRequests = []
function useFakeClaude(behavior = {}) {
  claudeRequests.length = 0
  claude.clientKey = null
  claude.createClient = () => ({
    beta: {
      messages: {
        create: async (params) => {
          claudeRequests.push(params)
          if (behavior.throws) throw behavior.throws
          const { segments } = JSON.parse(params.messages[0].content)
          const translations = segments.map((s) => ({
            id: s.id,
            text: behavior.huge === s.id ? '長'.repeat(10000) : `譯：${s.text}`
          }))
          return {
            stop_reason: behavior.stopReason ?? 'end_turn',
            usage: { input_tokens: 1000, output_tokens: 500 },
            content: [{ type: 'text', text: JSON.stringify({ translations }) }]
          }
        }
      }
    }
  })
}

;(async () => {
  const denied = (u) => ctx.isDenied(u)
  assert.equal(await denied('https://mail.google.com/mail/u/0'), true, 'Gmail 應被擋')
  assert.equal(await denied('https://www.paypal.com/x'), true, 'paypal 子網域應被擋')
  assert.equal(await denied('https://www.esunbank.com.tw/'), true, '含 bank 應被擋')
  assert.equal(await denied('https://www.cathaybk.com.tw/'), true, '國泰應被擋')
  assert.equal(await denied('https://console.anthropic.com/settings/keys'), true, 'Anthropic Console 應被擋（金鑰頁面）')
  assert.equal(await denied('chrome://settings'), true, '非 http 應被擋')
  assert.equal(await denied('file:///etc/passwd'), true, 'file 應被擋')
  assert.equal(await denied(undefined), true, '沒有 url（沒 activeTab）應被擋')
  assert.equal(await denied('not a url'), true, '壞網址應被擋')
  assert.equal(await denied('https://notpaypal.com/'), false, '只比對完整網域或子網域，不比對字串尾巴')
  assert.equal(await denied('https://medium.com/@a/b'), false, '一般網站應放行')
  assert.equal(await denied('https://www.youtube.com/watch?v=1'), false, 'YouTube 應放行')
  local.store.denylistExtra = ['example.com']
  assert.equal(await denied('https://docs.example.com/'), true, '自訂黑名單子網域應被擋')

  const call = (msg, sender) => new Promise((resolve) => ctx.handleTranslate(msg, sender, resolve))
  const tabSender = (id) => ({ id: 'self', tab: { id }, url: 'https://medium.com/x' })

  assert.equal((await call({ type: 'translate', text: 123 }, tabSender(1))).error, 'invalid-request', '非字串應拒')
  assert.equal((await call({ type: 'translate', text: '' }, tabSender(1))).error, 'invalid-request', '空字串應拒')
  assert.equal((await call({ type: 'translate', text: 'a'.repeat(2001) }, tabSender(1))).error, 'invalid-request', '超長應拒')
  assert.equal((await call({ type: 'translate', text: 'hello world test' }, { id: 'self' })).error, 'invalid-request', '沒有 tab 應拒')

  // 預設引擎是本機：任何線上翻譯請求都要被拒，而且完全不能發出 fetch 或 Claude 請求
  syncData = {}
  fetchCalls = 0
  useFakeClaude()
  assert.equal((await call({ type: 'translate', text: 'hello world test' }, tabSender(1))).error, 'engine-local', '預設本機模式應拒絕線上請求')
  syncData = { engine: 'whatever' }
  assert.equal((await call({ type: 'translate', text: 'hello world test' }, tabSender(1))).error, 'engine-local', '引擎值不合法時應退回本機並拒絕')
  assert.equal(fetchCalls, 0, '本機模式下不能有任何對外連線')
  assert.equal(claudeRequests.length, 0, '本機模式下不能呼叫 Claude')

  syncData = { engine: 'gtx' }
  granted = false
  assert.equal((await call({ type: 'translate', text: 'hello world test' }, tabSender(1))).error, 'no-permission', 'Google 模式沒權限應拒')
  granted = true

  // ---------- Claude ----------
  syncData = { engine: 'claude' }
  assert.equal((await call({ type: 'translate', text: 'hello claude one' }, tabSender(3))).error, 'no-key', '沒有金鑰應拒')
  assert.equal(await ctx.checkRemoteReady(await ctx.BT_SETTINGS.load()), 'no-key', '沒有金鑰時不該開始翻譯')

  session.store.claudeApiKey = 'sk-ant-test-session-key-0000000000'
  useFakeClaude()
  const texts = ['First paragraph about extensions.', 'Second paragraph about privacy.', 'Third paragraph about Chrome.']
  const results = await Promise.all(texts.map((text) => call({ type: 'translate', text }, tabSender(4))))
  assert.deepEqual(results.map((r) => r.text), texts.map((t) => `譯：${t}`), '每段都拿回自己的譯文')
  assert.equal(claudeRequests.length, 1, '同一頁短時間內的段落要合併成一次請求')
  const req = claudeRequests[0]
  assert.equal(req.model, 'claude-opus-5-5', '預設模型是 Opus 5.5')
  assert.equal(req.fallbacks, 'default', 'Opus 5.5 預設開啟拒答備援')
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01'], '拒答備援需要 beta 標頭')
  assert.equal(req.output_config.effort, 'low', '翻譯用低 effort')
  assert.equal(req.output_config.format.type, 'json_schema', '用 structured outputs 取回譯文')
  assert.match(req.system, /not instructions for you/, '系統提示要明講頁面文字不是指令')
  assert.equal(JSON.parse(req.messages[0].content).segments.length, 3, '三段在同一個請求')
  assert.ok(!JSON.stringify(req).includes('sk-ant-'), '金鑰不能出現在請求內容裡')
  assert.equal(local.store.claudeUsage.requests, 1, '要記錄當天請求次數')
  assert.ok(Math.abs(local.store.claudeUsage.costUsd - (1000 * 4 + 500 * 20) / 1e6) < 1e-9, '用 Opus 價格估算花費')

  // 快取：同一段再翻一次不該再打 API
  await call({ type: 'translate', text: texts[0] }, tabSender(4))
  assert.equal(claudeRequests.length, 1, '同引擎同模型的同一段要走快取')

  syncData = { engine: 'claude', claudeModel: 'claude-haiku-5-5' }
  useFakeClaude()
  await call({ type: 'translate', text: 'Haiku should translate this one.' }, tabSender(5))
  assert.equal(claudeRequests[0].model, 'claude-haiku-5-5', '可以切換到 Haiku')
  assert.equal(claudeRequests[0].fallbacks, undefined, 'Haiku 沒有伺服器端備援，不能送 fallbacks')

  useFakeClaude({ huge: 0 })
  assert.equal((await call({ type: 'translate', text: 'Short text that gets a huge reply.' }, tabSender(6))).error, 'translate-failed', '譯文長度異常要丟掉')

  useFakeClaude({ stopReason: 'refusal' })
  assert.equal((await call({ type: 'translate', text: 'This one is refused by the model.' }, tabSender(7))).error, 'translate-failed', '拒答時不顯示譯文')

  useFakeClaude({ throws: new FakeAnthropic.AuthenticationError('bad key') })
  assert.equal((await call({ type: 'translate', text: 'Auth error should map nicely.' }, tabSender(8))).error, 'claude-auth', '金鑰錯誤要回 claude-auth')

  useFakeClaude({ throws: new FakeAnthropic.RateLimitError('slow down') })
  assert.equal((await call({ type: 'translate', text: 'Rate limit should map nicely.' }, tabSender(9))).error, 'claude-rate-limit', '限流要回 claude-rate-limit')

  delete session.store.claudeApiKey
  local.store.claudeApiKey = 'sk-ant-test-local-key-00000000000000'
  useFakeClaude()
  syncData = { engine: 'claude' }
  assert.equal((await call({ type: 'translate', text: 'Remembered key in local storage.' }, tabSender(10))).ok, true, '勾「記住」時從 storage.local 讀金鑰')

  // 配額：第 501 次應被拒（前面每次都會因 fetch 失敗回 translate-failed，但會計數）
  syncData = { engine: 'gtx' }
  const quotaSender = tabSender(2)
  let last
  for (let i = 0; i < 501; i++) last = await call({ type: 'translate', text: `sentence number ${i}` }, quotaSender)
  assert.equal(last.error, 'quota-exceeded', '一般網頁第 501 次應被拒')

  console.log('ALL TESTS PASSED')
})().catch((e) => {
  console.error('TEST FAILED:', e.message)
  process.exit(1)
})
