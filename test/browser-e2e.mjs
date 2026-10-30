/**
 * browser-e2e.mjs — 用无头 Edge + CDP 对移植后的插件做真实浏览器验收（本机开发工具，不随插件发布）。
 *
 * 能力：
 *   1) 在独立的无头 Edge 里把聊天服务本身跑一遍双人流程（配对 → 双向收发 → 结束清空）；
 *   2) 打开 DSH Web UI（隔离档实例），确认侧栏入口出现，点击后聊天面板出现，
 *      并进一步在面板的 iframe 里完成真实配对与收发；
 *   3) 全程截图，作为市场收录的截图素材。
 *
 * 用法：
 *   node test/browser-e2e.mjs --dsh "http://127.0.0.1:3099/?token=..." --out "docs/screenshots"
 *
 * 说明：0.2.1 的 Web UI 要求 URL 带 `?token=`（浏览器令牌栅栏），token 在
 * `dsh --profile <p> --port <port>` 的启动输出里。`--chat` 可省略，会自动从 `/abba/info` 取 localUrl。
 *
 * 退出码 0 = 全部通过；1 = 有断言失败（打印细节）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1]
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, { timeout = 15000, interval = 150, label = 'condition' } = {}) {
  const started = Date.now()
  let lastErr
  while (Date.now() - started < timeout) {
    try {
      const v = await fn()
      if (v) return v
    } catch (err) {
      lastErr = err
    }
    await sleep(interval)
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? ` (last error: ${lastErr.message})` : ''}`)
}

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.nextId = 1
    this.pending = new Map()
    this.events = new Map()
    this.closed = false
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((res, rej) => {
      this.ws.onopen = res
      this.ws.onerror = (e) => rej(new Error('ws error ' + (e?.message || '')))
    })
    this.ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else p.resolve(msg.result)
        return
      }
      const hs = this.events.get(msg.method)
      if (hs) for (const h of hs) h(msg.params)
    }
    return this
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, handler) {
    if (!this.events.has(method)) this.events.set(method, new Set())
    this.events.get(method).add(handler)
    return () => this.events.get(method)?.delete(handler)
  }

  close() {
    this.closed = true
    try { this.ws.close() } catch {}
  }
}

class Page {
  constructor(cdp, label) {
    this.cdp = cdp
    this.label = label
  }

  async init({ width = 1440, height = 900 } = {}) {
    await this.cdp.send('Page.enable')
    await this.cdp.send('Runtime.enable')
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    })
    this.cdp.on('Page.javascriptDialogOpening', async () => {
      await this.cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
    })
    return this
  }

  async goto(url) {
    await this.cdp.send('Page.navigate', { url })
    await waitFor(async () => {
      const r = await this.eval('document.readyState')
      return r === 'complete' || r === 'interactive'
    }, { label: `load ${url}` })
  }

  async eval(expression) {
    const res = await this.cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    })
    if (res.exceptionDetails) {
      throw new Error(`eval failed (${this.label}): ${res.exceptionDetails.text || ''} ${res.exceptionDetails.exception?.description || ''}`)
    }
    return res.result?.value
  }

  async screenshot(path) {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path, Buffer.from(data, 'base64'))
    return path
  }

  async close() {
    this.cdp.close()
  }
}

async function createPage(debugPort, url = 'about:blank') {
  const res = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  if (!res.ok) throw new Error(`cannot create target: ${res.status} ${await res.text()}`)
  const target = await res.json()
  const cdp = await new CDP(target.webSocketDebuggerUrl).connect()
  return { target, page: new Page(cdp, url) }
}

async function closeTarget(debugPort, targetId) {
  await fetch(`http://127.0.0.1:${debugPort}/json/close/${targetId}`).catch(() => {})
}

async function launchEdge(debugPort, profileDir) {
  const exe = EDGE_CANDIDATES.find((p) => existsSync(p))
  if (!exe) throw new Error('Microsoft Edge not found')
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ]
  const child = spawn(exe, args, { stdio: 'ignore', windowsHide: true })
  await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
      return r.ok
    } catch { return false }
  }, { timeout: 20000, label: 'edge devtools' })
  return child
}

// ---------- 断言与结果 ----------
const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? '  OK  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function fillAndStart(page, { a, b }) {
  return page.eval(`(function(){
    var A=document.getElementById('pwd-a'), B=document.getElementById('pwd-b');
    if(!A||!B) return 'missing-inputs';
    A.value=${JSON.stringify(a)}; B.value=${JSON.stringify(b)};
    A.dispatchEvent(new Event('input',{bubbles:true}));
    B.dispatchEvent(new Event('input',{bubbles:true}));
    var btn=document.getElementById('btn-start');
    if(!btn) return 'missing-button';
    btn.click();
    return 'clicked';
  })()`)
}

const visible = (page, id) => page.eval(`(function(){
  var el=document.getElementById(${JSON.stringify(id)});
  return !!el && !el.classList.contains('hidden');
})()`)

async function runChatScenario(chatUrl, outDir) {
  console.log('\n[1] 聊天服务双人流程（无头浏览器）')
  const A = await createPage(edgePort)
  const B = await createPage(edgePort)
  try {
    await A.page.init(); await B.page.init()
    await A.page.goto(chatUrl); await B.page.goto(chatUrl)

    check('A 打开开始页', await visible(A.page, 'screen-start'))
    await A.page.screenshot(join(outDir, '02-start-page.png'))

    await fillAndStart(A.page, { a: '2468', b: '1357' })
    await waitFor(() => visible(A.page, 'screen-wait'), { label: 'A waiting screen' })
    check('A 双密码发起后进入等待页', true)
    await A.page.screenshot(join(outDir, 'chat-02-waiting.png'))

    // B 故意把 A/B 框填反，仍应配对成功
    await fillAndStart(B.page, { a: '1357', b: '2468' })
    await waitFor(() => visible(B.page, 'screen-chat'), { label: 'B chat screen' })
    await waitFor(() => visible(A.page, 'screen-chat'), { label: 'A chat screen' })
    check('B 填反 A/B 框也能配对成功', true)
    await sleep(400)
    await A.page.screenshot(join(outDir, 'chat-03-chat.png'))

    await A.page.eval(`(function(){
      var t=document.getElementById('text'); t.value='你好，B，这是一条只在内存里的消息';
      document.getElementById('send-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      return true; })()`)
    await waitFor(() => B.page.eval(`document.getElementById('msgs').textContent.includes('只在内存里')`), { label: 'B receives message' })
    check('A → B 消息实时送达', true)

    await B.page.eval(`(function(){
      var t=document.getElementById('text'); t.value='收到，B 回复一条';
      t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      return true; })()`)
    await waitFor(() => A.page.eval(`document.getElementById('msgs').textContent.includes('B 回复一条')`), { label: 'A receives reply' })
    check('B → A 回车发送成功', true)
    await B.page.screenshot(join(outDir, 'chat-04-dialog.png'))

    // 第三人被拒
    const C = await createPage(edgePort)
    await C.page.init()
    await C.page.goto(chatUrl)
    await fillAndStart(C.page, { a: '2468', b: '1357' })
    await waitFor(() => C.page.eval(`document.getElementById('start-err').textContent.length > 0`), { label: 'third person rejected' })
    const err = await C.page.eval(`document.getElementById('start-err').textContent`)
    check('第三人凭同一密码进不来', /正在进行|已有两人|稍后/.test(err), err)
    await closeTarget(edgePort, C.target.id)
    await C.page.close()

    // 结束并验证双方清空
    await A.page.eval(`window.confirm = () => true; document.getElementById('btn-leave').click(); true`)
    await waitFor(() => visible(A.page, 'screen-start'), { label: 'A back to start' })
    await waitFor(() => visible(B.page, 'screen-start'), { label: 'B back to start' })
    const clearedA = await A.page.eval(`document.getElementById('msgs').children.length`)
    const clearedB = await B.page.eval(`document.getElementById('msgs').children.length`)
    check('结束聊天后双方内容清空', clearedA === 0 && clearedB === 0, `A=${clearedA} B=${clearedB}`)
    await B.page.screenshot(join(outDir, 'chat-05-ended.png'))
  } finally {
    await closeTarget(edgePort, A.target.id).catch(() => {})
    await closeTarget(edgePort, B.target.id).catch(() => {})
    await A.page.close(); await B.page.close()
  }
}

// ---------- DSH 面板内真实聊天（iframe 跨源 → 用 CDP 在子 frame 的隔离世界里操作） ----------
async function dismissDshNotice(page) {
  const r = await page.eval(`(function(){
    var bs=Array.prototype.slice.call(document.querySelectorAll('button,[role=button]'));
    for (var i=0;i<bs.length;i++){
      var txt=(bs[i].textContent||'').trim();
      if (/^(继续|Continue|我知道了|Got it)$/.test(txt)) { bs[i].click(); return txt; }
    }
    return '';
  })()`)
  if (r) await sleep(500)
  return r
}

function findFrame(node, urlPart) {
  if (node.frame && typeof node.frame.url === 'string' && node.frame.url.includes(urlPart)) return node.frame
  for (const child of node.childFrames || []) {
    const hit = findFrame(child, urlPart)
    if (hit) return hit
  }
  return null
}

async function frameContext(page, urlPart) {
  const { frameTree } = await page.cdp.send('Page.getFrameTree')
  const frame = findFrame(frameTree, urlPart)
  if (!frame) throw new Error('chat iframe not found in frame tree')
  const { executionContextId } = await page.cdp.send('Page.createIsolatedWorld', {
    frameId: frame.id,
    worldName: 'abba-e2e',
  })
  return executionContextId
}

async function frameEval(page, urlPart, expression) {
  const contextId = await frameContext(page, urlPart)
  const res = await page.cdp.send('Runtime.evaluate', {
    expression,
    contextId,
    awaitPromise: true,
    returnByValue: true,
  })
  if (res.exceptionDetails) {
    throw new Error(`frame eval failed: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text || ''}`)
  }
  return res.result?.value
}

async function runDshChatInPanel(dshUrl, chatUrl, outDir) {
  console.log('\n[2] DSH Web UI 内的入口、右侧栏面板与面板内真实聊天')
  const { target, page } = await createPage(edgePort)
  try {
    await page.init({ width: 1440, height: 900 })
    await page.goto(dshUrl)
    await waitFor(async () => {
      const txt = await page.eval(`document.body ? document.body.innerText : ''`)
      return typeof txt === 'string' && txt.length > 0 && /DeepSeek|Harness|新|会话|New/i.test(txt)
    }, { timeout: 30000, label: 'DSH shell boot' })
    await sleep(1200)
    const dismissed = await dismissDshNotice(page)
    if (dismissed) console.log(`  · 已关闭首启提示（${dismissed}）`)
    await page.screenshot(join(outDir, 'dsh-01-home.png'))

    const boot = await page.eval(`(function(){
      try { var b=window.__DSH_BOOT__; return b ? JSON.stringify(b.entries.map(function(e){return e.id})) : ''; } catch(e){ return 'ERR:'+e.message }
    })()`)
    check('boot 图包含本插件 client bundle', typeof boot === 'string' && boot.includes('dsh-abba-secret-chat'), String(boot).slice(0, 120))

    const entryFound = await page.eval(`(function(){
      var nodes=Array.prototype.slice.call(document.querySelectorAll('button,[role=button],a,div'));
      var hit=nodes.find(function(n){ return n.className && String(n.className).split(' ').some(function(c){return c.indexOf('abba-')===0}) });
      return hit ? (hit.className + ' | ' + (hit.textContent||'').slice(0,40)) : '';
    })()`)
    check('左侧栏底部入口按钮已渲染', Boolean(entryFound), entryFound || 'not found')

    await page.eval(`(function(){
      var nodes=Array.prototype.slice.call(document.querySelectorAll('button,[role=button],a,*'));
      for (var i=0;i<nodes.length;i++){ var n=nodes[i]; if(n.className && String(n.className).split(' ').some(function(c){return c.indexOf('abba-')===0})){ (n.closest('button,[role=button],a') || n).click(); return true; } }
      return false;
    })()`)
    await sleep(2000)
    const panel = await page.eval(`(function(){
      var f=document.querySelector('iframe[src*=":8787"], iframe[src*="127.0.0.1"]');
      var overlay=document.querySelector('.abba-overlay');
      return JSON.stringify({ iframe: f ? f.getAttribute('src') : null, overlay: !!overlay });
    })()`)
    const p = JSON.parse(panel)
    check('点击入口后聊天面板出现（右侧栏 tab 或浮层）', Boolean(p.iframe) || p.overlay, panel)
    await page.screenshot(join(outDir, '03-panel-and-entry.png'))

    if (p.iframe) {
      await waitFor(async () => frameEval(page, ':8787', `document.getElementById('pwd-a') ? 'ready' : ''`), {
        timeout: 10000, label: 'chat iframe ready',
      })
      check('面板 iframe 已加载聊天页', true)

      // 面板里当 A：填双密码 → 等待
      await frameEval(page, ':8787', `(function(){
        document.getElementById('pwd-a').value='4321';
        document.getElementById('pwd-b').value='8765';
        document.getElementById('btn-start').click();
        return true; })()`)
      await waitFor(async () => frameEval(page, ':8787', `!document.getElementById('screen-wait').classList.contains('hidden')`), {
        timeout: 8000, label: 'panel waiting screen',
      })
      check('面板内双密码发起成功，进入等待页', true)

      // 对端 B：独立页面（模拟同一 Wi-Fi 的对方），故意填反
      const peer = await createPage(edgePort, chatUrl)
      await peer.page.init({ width: 1000, height: 860 })
      await peer.page.goto(chatUrl)
      await fillAndStart(peer.page, { a: '8765', b: '4321' })
      await waitFor(async () => frameEval(page, ':8787', `!document.getElementById('screen-chat').classList.contains('hidden')`), {
        timeout: 10000, label: 'panel chat screen',
      })
      check('对端加入后面板内配对成功', true)

      await peer.page.eval(`(function(){
        var t=document.getElementById('text'); t.value='面板里收到的消息：只在内存里转发';
        document.getElementById('send-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
        return true; })()`)
      await waitFor(async () => frameEval(page, ':8787', `document.getElementById('msgs').textContent.includes('面板里收到')`), {
        timeout: 8000, label: 'panel receives message',
      })
      check('对端 → DSH 右侧栏面板内实时收到消息', true)
      await sleep(300)
      await page.screenshot(join(outDir, '01-sidebar-chat.png'))

      // 结束聊天（面板内 A 主动结束），验证双方清空
      await frameEval(page, ':8787', `(function(){ window.confirm=function(){return true}; document.getElementById('btn-leave').click(); return true; })()`)
      await waitFor(async () => frameEval(page, ':8787', `!document.getElementById('screen-start').classList.contains('hidden')`), {
        timeout: 8000, label: 'panel back to start',
      })
      const peerCleared = await waitFor(async () => (await peer.page.eval(`document.getElementById('msgs').children.length`)) === 0, {
        timeout: 8000, label: 'peer cleared',
      }).then(() => true).catch(() => false)
      check('面板内结束聊天后双方内容清空', peerCleared)
      await peer.page.close()
      await closeTarget(edgePort, peer.target.id).catch(() => {})
    }
  } finally {
    await closeTarget(edgePort, target.id).catch(() => {})
    await page.close()
  }
}

// ---------- main ----------
const args = parseArgs(process.argv)
const dshUrl = args.dsh || 'http://127.0.0.1:3099/'
const chatArg = args.chat
const outDir = resolve(args.out || join(process.cwd(), 'docs', 'screenshots'))
mkdirSync(outDir, { recursive: true })

const edgePort = 9000 + Math.floor(Math.random() * 900)
const profileDir = join(tmpdir(), `abba-e2e-edge-${Date.now()}`)
mkdirSync(profileDir, { recursive: true })

let edge
try {
  console.log(`headless Edge on :${edgePort}, dsh=${dshUrl} chat=${chatArg || '(auto)'}`)
  edge = await launchEdge(edgePort, profileDir)

  let chat = chatArg
  if (!chat) {
    const info = await waitFor(async () => {
      try {
        const r = await fetch(new URL('abba/info', dshUrl))
        return r.ok ? await r.json() : null
      } catch { return null }
    }, { timeout: 15000, label: '/abba/info' })
    chat = info.localUrl || 'http://127.0.0.1:8787/'
  }
  if (!/\/$/.test(chat)) chat += '/'

  await runChatScenario(chat, outDir)
  await runDshChatInPanel(dshUrl, chat, outDir)
} catch (err) {
  console.error('\nFATAL:', err.message)
  checks.push({ name: 'fatal', ok: false, detail: err.message })
} finally {
  try { edge?.kill() } catch {}
  await sleep(300)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n===== ${checks.length - failed.length}/${checks.length} checks passed =====`)
if (failed.length) {
  for (const f of failed) console.log(`FAIL: ${f.name} — ${f.detail}`)
  process.exit(1)
}
console.log('ALL BROWSER CHECKS PASSED')
