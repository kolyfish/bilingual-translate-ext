// 端對端測試：用 Playwright 內建 Chromium 載入擴充副本，跑真實的注入、翻譯、還原流程
// 注意: 品牌版 Google Chrome 137+ 已移除 --load-extension，只能用 Chromium 測
// 用法: PLAYWRIGHT_PATH=<playwright 套件路徑> node tests/e2e.js（沒設就 require('playwright')）
const path = require('path')
const fs = require('fs')
const os = require('os')
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')

const ROOT = path.resolve(__dirname, '..')

/**
 * 複製一份擴充到暫存目錄，只改 manifest 權限
 *
 * 決策: 自動化無法產生真的工具列點擊（activeTab 手勢）與權限對話框，
 *       所以測試副本預先給權限，其餘程式碼與正式版完全相同
 */
function buildCopy(name, mutateManifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bt-${name}-`))
  for (const f of fs.readdirSync(ROOT)) {
    if (!f.startsWith('._') && /\.(js|css|html|json)$/.test(f)) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f))
  }
  // manifest 引用了 icons/、background 載入 vendor/，少了會讓擴充載入失敗
  for (const sub of ['icons', 'vendor']) {
    fs.cpSync(path.join(ROOT, sub), path.join(dir, sub), {
      recursive: true,
      filter: (src) => !path.basename(src).startsWith('._')
    })
  }
  const manifestPath = path.join(dir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  mutateManifest(manifest)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return dir
}

// A：只能讀網址（tabs），用來測拒絕路徑
// B：另外給 <all_urls> + gtx，模擬「已點擊 + 已允許 Google」
const EXT_A = buildCopy('a', (m) => m.permissions.push('tabs'))
const EXT_B = buildCopy('b', (m) => {
  m.permissions.push('tabs')
  m.host_permissions = ['<all_urls>', 'https://translate.googleapis.com/*']
})

// 假的 Chrome 內建 Translator API，注入到內容腳本的 isolated world
// 決策: Playwright 的 Chromium 沒有可用的本機語言包，只能模擬；
//       但「下載需要使用者手勢」這條規則照真的 API 實作，確保提示條的點擊流程正確
fs.writeFileSync(
  path.join(EXT_B, 'fake-translator.js'),
  `globalThis.__fake = globalThis.__fake || { availability: 'downloadable', calls: 0 }
globalThis.Translator = {
  availability: async () => __fake.availability,
  create: async (opts) => {
    if (__fake.availability !== 'available') {
      if (!navigator.userActivation.isActive) throw new DOMException('需要使用者手勢', 'NotAllowedError')
      const monitor = new EventTarget()
      opts.monitor?.(monitor)
      for (const loaded of [0.25, 0.6, 1]) monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded }))
      __fake.availability = 'available'
    }
    return { translate: async (t) => { __fake.calls += 1; return '本機譯文：' + t } }
  }
}`
)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`)
}

const PAGES = {
  'article.test': `<!doctype html><html><body>
    <h1 id="h1">Understanding Modern Browser Extensions Today</h1>
    <p id="p1">Browser extensions can read and modify the pages you visit every day.</p>
    <ul><li id="li1">Least privilege means asking only for what you actually need.</li></ul>
    <table><tr><td id="td1">Each table cell keeps its structure after the translation is inserted.</td></tr></table>
    <p id="hidden1" style="visibility:hidden">This hidden paragraph should never be translated by the tool.</p>
    <p id="aria1" aria-hidden="true">This aria hidden paragraph should also be skipped entirely here.</p>
    <p id="cn">這是一段中文內容，不應該被送去翻譯，因為它本來就是中文。</p>
    <pre id="code1">const value = getSomethingFromTheServer(now) and more code here</pre>
    <div style="height:4000px"></div>
    <p id="far">This paragraph is far below the fold and loads lazily when scrolled into view.</p>
  </body></html>`,
  'login.test': `<!doctype html><html><body>
    <p>Please sign in to continue to your account dashboard and settings.</p>
    <input type="password">
  </body></html>`,
  'mybank.test': `<!doctype html><html><body><p>Your account balance and recent transactions are shown below.</p></body></html>`,
  'www.youtube.com': `<!doctype html><html><body>
    <div id="movie_player" style="position:relative;width:960px;height:540px;background:#000">
      <div class="ytp-caption-window-container"><div class="caption-window">
        <span class="captions-text"><span class="caption-visual-line"><span class="ytp-caption-segment">Hello everyone and welcome back to the channel</span></span></span>
      </div></div>
    </div>
  </body></html>`
}

async function launch(extDir) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-e2e-'))
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`]
  })
  // 只攔截測試網域，translate.googleapis.com 走真實網路
  await context.route(/^https:\/\/(article\.test|login\.test|mybank\.test|www\.youtube\.com)\//, (route) => {
    const host = new URL(route.request().url()).hostname
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGES[host] })
  })
  let [sw] = context.serviceWorkers()
  if (!sw) sw = await context.waitForEvent('serviceworker')
  return { context, sw }
}

async function openPage(context, url) {
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  await page.goto(url)
  await page.waitForLoadState('load')
  return page
}

// 決策: 自動化無法產生真的工具列點擊，直接在 service worker 呼叫 toggleTab（與點擊後走同一條路徑）
const toggle = (sw, url) =>
  sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({})
    const tab = tabs.find((t) => t.url === u)
    return toggleTab(tab)
  }, url)

const badge = (sw, url) =>
  sw.evaluate(async (u) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === u)
    return chrome.action.getBadgeText({ tabId: tab.id })
  }, url)

async function suiteA() {
  console.log('\n— 副本 A：未授權 Google、只能讀網址 —')
  const { context, sw } = await launch(EXT_A)
  try {
    const url = 'https://article.test/'
    const page = await openPage(context, url)
    await sw.evaluate(() => chrome.storage.sync.set({ engine: 'gtx' }))
    check('Google 模式未授權 → no-permission', (await toggle(sw, url)) === 'no-permission')
    check('徽章顯示 !', (await badge(sw, url)) === '!')
    check('未授權時不注入（頁面沒有譯文）', (await page.locator('.bt-zh').count()) === 0)

    const bankUrl = 'https://mybank.test/'
    await openPage(context, bankUrl)
    check('網域含 bank → denied', (await toggle(sw, bankUrl)) === 'denied')
    check('徽章顯示 ✕', (await badge(sw, bankUrl)) === '✕')
  } finally {
    await context.close()
  }
}

async function suiteB() {
  console.log('\n— 副本 B：模擬已點擊 + 已允許 Google —')
  const { context, sw } = await launch(EXT_B)
  // 決策: 換成假翻譯引擎。真 gtx 已經因為測試次數太多被 Google 限流，而且測試不該依賴外部服務
  await sw.evaluate(() => {
    self.__calls = []
    REMOTE_ENGINES.gtx.translate = async (t) => {
      self.__calls.push(t)
      return `測試譯文：${t}`
    }
    return chrome.storage.sync.set({ engine: 'gtx' })
  })
  const callCount = () => sw.evaluate(() => self.__calls.length)
  try {
    const url = 'https://article.test/'
    const page = await openPage(context, url)

    check('第一次觸發 → started', (await toggle(sw, url)) === 'started')
    check('徽章顯示 ON', (await badge(sw, url)) === 'ON')

    await page.waitForSelector('#p1 + .bt-zh')
    await page.waitForSelector('#li1 > .bt-zh')
    await page.waitForSelector('#td1 > .bt-zh')
    await page.waitForSelector('#h1 + .bt-zh')
    const p1zh = await page.locator('#p1 + .bt-zh').textContent()
    check('段落譯文插在英文下方', Boolean(p1zh) && /[一-鿿]/.test(p1zh), p1zh)
    check('列表譯文放在 li 內部', (await page.locator('#li1 > .bt-zh').count()) === 1)
    check('表格譯文放在 td 內部（不破壞 tr）', (await page.locator('tr > .bt-zh').count()) === 0)

    const style = (sel) =>
      page.locator(sel).evaluate((el) => {
        const cs = getComputedStyle(el)
        return { bg: cs.backgroundColor, fg: cs.color, size: parseFloat(cs.fontSize) }
      })
    const before = await style('#p1 + .bt-zh')
    check('預設底色為深紅 #8b1a1a', before.bg === 'rgb(139, 26, 26)', before.bg)
    check('深紅底配淺色字', before.fg === 'rgb(255, 245, 245)', before.fg)

    await sw.evaluate(() => chrome.storage.sync.set({ bgColor: '#f0e68c', fontScale: 150 }))
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#p1 + .bt-zh')).backgroundColor === 'rgb(240, 230, 140)')
    const after = await style('#p1 + .bt-zh')
    check('改底色後不用重新翻譯即時生效', true, after.bg)
    check('淺色底自動改成深色字', after.fg === 'rgb(26, 26, 26)', after.fg)
    check('字級 150% 大於 95%', after.size > before.size, `${before.size}px → ${after.size}px`)

    await sw.evaluate(() => chrome.storage.sync.set({ bgColor: 'red;} body{display:none', fontScale: 9999 }))
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#p1 + .bt-zh')).backgroundColor === 'rgb(139, 26, 26)')
    const bad = await style('#p1 + .bt-zh')
    check('非法顏色字串被擋下，回到預設深紅', true, bad.bg)
    check('字級超出範圍被夾到上限 160%', Math.abs(bad.size / before.size - 160 / 95) < 0.02, `${bad.size}px`)
    check('頁面 body 沒被注入的 CSS 影響', (await page.evaluate(() => getComputedStyle(document.body).display)) === 'block')
    await sw.evaluate(() => chrome.storage.sync.remove(['bgColor', 'fontScale']))

    check('visibility:hidden 段落不翻', (await page.locator('#hidden1 + .bt-zh').count()) === 0)
    check('aria-hidden 段落不翻', (await page.locator('#aria1 + .bt-zh').count()) === 0)
    check('中文段落不翻', (await page.locator('#cn + .bt-zh').count()) === 0)
    check('pre/code 不翻', (await page.locator('#code1 + .bt-zh').count()) === 0)
    check('視窗外段落尚未翻譯（懶載入）', (await page.locator('#far + .bt-zh').count()) === 0)

    await page.locator('#far').scrollIntoViewIfNeeded()
    await page.waitForSelector('#far + .bt-zh')
    check('捲動到段落後才翻譯', true)

    check('再觸發一次 → stopped', (await toggle(sw, url)) === 'stopped')
    check('還原後譯文全部移除', (await page.locator('.bt-zh').count()) === 0)
    check('還原後標記全部清除', (await page.locator('[data-bt-done]').count()) === 0)
    check('還原後徽章清空', (await badge(sw, url)) === '')
    check('還原後 <html> 上的外觀變數清除', (await page.evaluate(() => document.documentElement.getAttribute('style'))) in { null: 1, '': 1 })

    console.log('\n— 彈窗 —')
    const extId = new URL(sw.url()).host
    const popup = await openPage(context, `chrome-extension://${extId}/popup.html`)
    check('彈窗底色預設值為深紅', (await popup.locator('#bg-color').inputValue()) === '#8b1a1a')
    check('彈窗字級預設 95%', (await popup.locator('#font-scale-value').textContent()) === '95%')
    await popup.locator('#font-scale').fill('120')
    check('拖動字級時預覽數字更新', (await popup.locator('#font-scale-value').textContent()) === '120%')
    const pv = await popup.locator('#preview').evaluate((el) => getComputedStyle(el).backgroundColor)
    check('預覽框套用深紅底', pv === 'rgb(139, 26, 26)', pv)
    await popup.close()

    // 前一步捲到頁底了，#p1 不在視窗內不會被懶翻譯，先捲回頂端
    await page.evaluate(() => window.scrollTo(0, 0))
    await sw.evaluate(() => chrome.storage.sync.set({ position: 'above' }))
    check('改成上方後重新觸發 → started', (await toggle(sw, url)) === 'started')
    await page.waitForSelector('.bt-zh + #p1')
    check('位置設定為上方時，譯文在英文上方', true)
    await toggle(sw, url)
    await sw.evaluate(() => chrome.storage.sync.set({ position: 'below' }))

    const loginUrl = 'https://login.test/'
    const login = await openPage(context, loginUrl)
    check('有密碼欄位 → blocked', (await toggle(sw, loginUrl)) === 'blocked')
    check('blocked 頁面沒有譯文', (await login.locator('.bt-zh').count()) === 0)

    console.log('\n— YouTube 字幕 —')
    await sw.evaluate(() => chrome.storage.sync.set({ youtubeAuto: true }))
    const ytUrl = 'https://www.youtube.com/watch?v=test'
    const yt = await openPage(context, ytUrl)
    await yt.waitForFunction(() => /測試譯文/.test(document.querySelector('#movie_player > .bt-yt-box .bt-yt-zh')?.textContent || ''))
    check('自動模式顯示自己的雙語框，掛在播放器上', true, await yt.locator('.bt-yt-zh').textContent())
    check('英文鏡像原生字幕', (await yt.locator('.bt-yt-en').textContent()) === 'Hello everyone and welcome back to the channel')
    const nativeOpacity = await yt.locator('.ytp-caption-window-container').evaluate((el) => getComputedStyle(el).opacity)
    check('原生字幕被隱藏（但還在 DOM 可讀）', nativeOpacity === '0', `opacity=${nativeOpacity}`)

    // 模擬自動字幕：換一句後逐字長出來，每 120ms 多一個字，最後換到第二行
    const zhRect = () => yt.locator('.bt-yt-zh').evaluate((el) => el.getBoundingClientRect().bottom)
    const enHeight = () => yt.locator('.bt-yt-en').evaluate((el) => el.getBoundingClientRect().height)
    const zhBottomBefore = await zhRect()
    const enHeightBefore = await enHeight()
    const callsBefore = await callCount()
    await yt.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const seg = document.querySelector('.ytp-caption-segment')
      const words = ['so', 'today', 'we', 'are', 'going', 'to', 'talk', 'about']
      seg.textContent = 'and'
      for (const w of words) {
        await sleep(120)
        seg.textContent += ` ${w}`
      }
      await sleep(120)
      const line2 = document.createElement('span')
      line2.className = 'caption-visual-line'
      line2.innerHTML = '<span class="ytp-caption-segment">browser security and privacy</span>'
      document.querySelector('.captions-text').append(line2)
    })
    const growthCalls = (await callCount()) - callsBefore
    check('逐字增加 9 次，翻譯請求被合併到 3 次以內', growthCalls <= 3, `實際 ${growthCalls} 次`)

    await yt.waitForFunction(() => /privacy/.test(document.querySelector('.bt-yt-zh')?.textContent || ''))
    check('停頓後翻譯完整的兩行', true, await yt.locator('.bt-yt-zh').textContent())
    const zhBottomAfter = await zhRect()
    const enHeightAfter = await enHeight()
    check('英文長成兩行（框往上長）', enHeightAfter > enHeightBefore, `${enHeightBefore}px → ${enHeightAfter}px`)
    check('中文位置固定，沒被英文推走', Math.abs(zhBottomAfter - zhBottomBefore) < 1, `bottom ${zhBottomBefore} → ${zhBottomAfter}`)

    await yt.evaluate(() => document.querySelector('.captions-text').replaceChildren())
    await yt.waitForFunction(() => document.querySelector('.bt-yt-box')?.hidden === true)
    check('字幕消失時雙語框隱藏', true)

    await sw.evaluate(() => chrome.storage.sync.set({ youtubeAuto: false }))
    await yt.waitForFunction(() => !document.querySelector('.bt-yt-box'))
    const nativeRestored = await yt.locator('#movie_player').evaluate((el) => !el.classList.contains('bt-yt-hide-native'))
    check('關閉後移除雙語框並恢復原生字幕', nativeRestored)

    console.log('\n— 本機引擎（Translator API）—')
    await sw.evaluate(() => chrome.storage.sync.set({ engine: 'local' }))

    // 沒裝假 API 時，看 Playwright 的 Chromium 是否自帶 Translator
    const plainUrl = 'https://article.test/?plain'
    await openPage(context, plainUrl)
    const plainStatus = await toggle(sw, plainUrl)
    check('沒有假 API 時不會出錯', plainStatus !== 'error', `Chromium 回報 ${plainStatus}`)

    const localUrl = 'https://article.test/?local'
    const lp = await openPage(context, localUrl)
    const injectFake = (u) =>
      sw.evaluate(async (target) => {
        const tab = (await chrome.tabs.query({})).find((t) => t.url === target)
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['fake-translator.js'] })
      }, u)
    await injectFake(localUrl)
    const remoteBefore = await callCount()

    check('語言包未下載 → needs-download', (await toggle(sw, localUrl)) === 'needs-download')
    check('徽章顯示 ↓', (await badge(sw, localUrl)) === '↓')
    await lp.waitForSelector('.bt-banner')
    check('頁面右下角出現下載提示條', true)
    check('下載前沒有任何譯文', (await lp.locator('.bt-zh').count()) === 0)

    await lp.getByRole('button', { name: '下載並翻譯' }).click()
    await lp.waitForSelector('#p1 + .bt-zh')
    const localZh = await lp.locator('#p1 + .bt-zh').textContent()
    check('點擊下載後用本機引擎翻譯', localZh.startsWith('本機譯文：'), localZh)
    check('下載完成後提示條消失', (await lp.locator('.bt-banner').count()) === 0)
    check('下載完成後徽章變 ON', (await badge(sw, localUrl)) === 'ON')
    check('本機模式完全沒有呼叫線上引擎', (await callCount()) === remoteBefore, `線上呼叫 ${(await callCount()) - remoteBefore} 次`)

    const forced = await sw.evaluate(async (target) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url === target)
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'translate', text: 'hello world test' }, resolve))
      })
      return result
    }, localUrl)
    check('本機模式下硬送線上請求 → background 拒絕 engine-local', forced?.error === 'engine-local', JSON.stringify(forced))

    check('再觸發 → stopped', (await toggle(sw, localUrl)) === 'stopped')
    check('還原後譯文移除', (await lp.locator('.bt-zh').count()) === 0)
    check('語言包已下載 → 直接 started，不再出現提示條', (await toggle(sw, localUrl)) === 'started')
    check('第二次沒有提示條', (await lp.locator('.bt-banner').count()) === 0)
    await toggle(sw, localUrl)

    const cancelUrl = 'https://article.test/?cancel'
    const cp = await openPage(context, cancelUrl)
    await injectFake(cancelUrl)
    check('另一頁未下載 → needs-download', (await toggle(sw, cancelUrl)) === 'needs-download')
    await cp.getByRole('button', { name: '取消' }).click()
    await cp.waitForFunction(() => !document.querySelector('.bt-banner'))
    check('按取消後提示條消失、沒有譯文', (await cp.locator('.bt-zh').count()) === 0)
    await cp.waitForFunction(() => true)
    check('按取消後徽章清空', (await badge(sw, cancelUrl)) === '')

    console.log('\n— Claude 引擎 —')
    // 決策: 換掉 SDK client，不打真的 API；但請求參數、合併、金鑰讀取都走正式程式碼
    await sw.evaluate(() => {
      self.__claudeReqs = []
      claude.clientKey = null
      claude.createClient = (apiKey) => ({
        beta: {
          messages: {
            create: async (params) => {
              self.__claudeReqs.push({ params, apiKey })
              const { segments } = JSON.parse(params.messages[0].content)
              return {
                stop_reason: 'end_turn',
                usage: { input_tokens: 800, output_tokens: 400 },
                content: [{ type: 'text', text: JSON.stringify({ translations: segments.map((s) => ({ id: s.id, text: `Claude譯：${s.text}` })) }) }]
              }
            }
          }
        },
        models: { retrieve: async () => ({ id: 'claude-opus-5-5' }) }
      })
      return chrome.storage.sync.set({ engine: 'claude' })
    })
    const claudeCount = () => sw.evaluate(() => self.__claudeReqs.length)

    const cUrl = 'https://article.test/?claude'
    const cpage = await openPage(context, cUrl)
    check('Claude 模式沒有金鑰 → no-key', (await toggle(sw, cUrl)) === 'no-key')
    check('沒有金鑰時徽章顯示 !', (await badge(sw, cUrl)) === '!')

    await sw.evaluate(() => chrome.storage.session.set({ claudeApiKey: 'sk-ant-e2e-test-key-000000000000wxyz' }))
    const remoteBeforeClaude = await callCount()
    check('有金鑰 → started', (await toggle(sw, cUrl)) === 'started')
    await cpage.waitForSelector('#p1 + .bt-zh')
    await cpage.waitForSelector('#td1 > .bt-zh')
    const cZh = await cpage.locator('#p1 + .bt-zh').textContent()
    check('譯文來自 Claude', cZh.startsWith('Claude譯：'), cZh)
    const translatedCount = await cpage.locator('.bt-zh').count()
    const reqs = await claudeCount()
    check('多個段落合併成較少的請求', reqs < translatedCount, `${translatedCount} 段 → ${reqs} 次請求`)
    const firstReq = await sw.evaluate(() => self.__claudeReqs[0])
    check('請求用 Opus 5.5 + 拒答備援 + low effort', firstReq.params.model === 'claude-opus-5-5' && firstReq.params.fallbacks === 'default' && firstReq.params.output_config.effort === 'low')
    check('金鑰從 storage.session 讀取', firstReq.apiKey === 'sk-ant-e2e-test-key-000000000000wxyz')
    check('Claude 模式沒有呼叫 Google', (await callCount()) === remoteBeforeClaude)

    const contentRead = await sw.evaluate(async (target) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url === target)
      await chrome.storage.local.set({ claudeApiKey: 'sk-ant-should-not-leak-0000000000000' })
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          try {
            const got = await chrome.storage.local.get('claudeApiKey')
            return got.claudeApiKey ? 'leaked' : 'empty'
          } catch (err) {
            return 'blocked'
          }
        }
      })
      await chrome.storage.local.remove('claudeApiKey')
      return result
    }, cUrl)
    check('內容腳本讀不到 storage.local 裡的金鑰', contentRead === 'blocked', contentRead)

    const usage = await sw.evaluate(() => chrome.storage.local.get('claudeUsage'))
    check('有記錄當天用量', usage.claudeUsage?.requests === reqs, JSON.stringify(usage.claudeUsage))
    await toggle(sw, cUrl)

    const cp2 = await openPage(context, `chrome-extension://${new URL(sw.url()).host}/popup.html`)
    await cp2.waitForFunction(() => !document.getElementById('claude-key-saved').hidden)
    check('彈窗顯示 Claude 設定區', await cp2.locator('#claude-section').isVisible())
    const mask = await cp2.locator('#claude-key-mask').textContent()
    check('彈窗只顯示金鑰末 4 碼', mask === 'sk-ant-…wxyz', mask)
    check('彈窗頁面裡沒有完整金鑰', !(await cp2.content()).includes('sk-ant-e2e-test-key'))
    await cp2.getByRole('button', { name: '測試金鑰' }).click()
    await cp2.waitForFunction(() => /可以使用/.test(document.getElementById('claude-state').textContent))
    check('測試金鑰按鈕可用', true)
    check('彈窗顯示今天用量', /今天 \d+ 次請求/.test(await cp2.locator('#claude-usage').textContent()))
    await cp2.getByRole('button', { name: '移除金鑰' }).click()
    await cp2.waitForFunction(() => !document.getElementById('claude-key-empty').hidden)
    const left = await sw.evaluate(async () => ({
      ...(await chrome.storage.session.get('claudeApiKey')),
      ...(await chrome.storage.local.get('claudeApiKey'))
    }))
    check('移除金鑰後兩個儲存區都清空', !left.claudeApiKey)
    await cp2.close()
    await sw.evaluate(() => chrome.storage.sync.set({ engine: 'local' }))
  } finally {
    await context.close()
  }
}

;(async () => {
  try {
    await suiteA()
    await suiteB()
  } catch (err) {
    check(`測試中斷：${err.name}`, false, err.message.split('\n')[0])
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n合計 ${results.length} 項，失敗 ${failed} 項`)
  process.exit(failed > 0 ? 1 : 0)
})()
