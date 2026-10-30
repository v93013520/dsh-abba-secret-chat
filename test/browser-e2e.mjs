/**
 * browser-e2e.mjs — AB-BA 秘密对话 v0.2.0 的真实浏览器验收（无头 Edge + CDP）。
 *
 * 覆盖：
 *   [1] 聊天服务双人流程：pairKey 配对（填反等价）、文字双向、图片（粘贴→预览→发送）、
 *       我/你 标签、第三人拒绝、结束清空、重配对；
 *   [2] 线上无明文：抓 /api/enter 与 /api/send 请求体，断言不含密码明文/消息明文，
 *       payload 是 {k,v,iv,ct,mac} 对象；/crypto.js 与 /vendor/crypto-js.js 可加载；
 *   [3] 截屏按钮：失败/拒绝时给中文提示且无未捕获异常（真实屏幕捕获由用户手动验）；
 *   [4] DSH Web UI：boot 图含本插件、左侧栏入口、点击开右侧栏、iframe allow="display-capture"、
 *       面板 iframe 内真实配对+加密收发+标签；
 *   [5] 截图素材输出到 docs/screenshots/。
 *
 * 用法：
 *   node test/browser-e2e.mjs --dsh "http://127.0.0.1:3099/?token=..." --out docs/screenshots [--chat URL]
 * 退出码 0 = 全部通过。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

const INSTRUMENT = `(() => {
  window.__abbaWire = [];
  window.__abbaErrors = [];
  try {
    window.onerror = function (m) { try { window.__abbaErrors.push(String(m)); } catch (e) {} return false; };
    window.addEventListener('unhandledrejection', function (e) { try { window.__abbaErrors.push('unhandled:' + String(e.reason)); } catch (x) {} });
  } catch (e) {}
  const orig = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/api/') >= 0) window.__abbaWire.push({ url: url, body: (init && typeof init.body === 'string') ? init.body : '' });
    } catch (e) {}
    return orig.apply(this, arguments);
  };
})();`

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

  async addInitScript(source) {
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source })
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

// ---------- 断言 ----------
const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? '  OK  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const visible = (page, id) => page.eval(`(function(){
  var el=document.getElementById(${JSON.stringify(id)});
  return !!el && !el.classList.contains('hidden');
})()`)

async function fillAndStart(page, { a, b }, expect = 'any') {
  await page.eval(`(function(){
    var A=document.getElementById('pwd-a'), B=document.getElementById('pwd-b');
    A.value=${JSON.stringify(a)}; B.value=${JSON.stringify(b)};
    A.dispatchEvent(new Event('input',{bubbles:true}));
    B.dispatchEvent(new Event('input',{bubbles:true}));
    document.getElementById('btn-start').click();
    return true; })()`)
  if (expect === 'wait') {
    await waitFor(() => visible(page, 'screen-wait'), { timeout: 15000, label: 'waiting screen' })
  } else if (expect === 'chat') {
    await waitFor(() => visible(page, 'screen-chat'), { timeout: 20000, label: 'chat screen' })
  }
}

async function sendText(page, text) {
  await page.eval(`(function(){
    var t=document.getElementById('text'); t.value=${JSON.stringify(text)};
    document.getElementById('send-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    return true; })()`)
}

/** 在页面里造一张真实 PNG，用 paste 事件塞给页面（等同用户粘贴图片）。 */
async function pasteImage(page) {
  return page.eval(`(async function(){
    var c=document.createElement('canvas'); c.width=64; c.height=48;
    var g=c.getContext('2d');
    g.fillStyle='#4f7cff'; g.fillRect(0,0,64,48);
    g.fillStyle='#fff'; g.font='16px sans-serif'; g.fillText('AB',10,30);
    var blob=await new Promise(function(res){ c.toBlob(res,'image/png'); });
    var file=new File([blob],'abba-test.png',{type:'image/png'});
    var dt=new DataTransfer(); dt.items.add(file);
    document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
    return {name:file.name,size:file.size};
  })()`)
}

function getWire(page) {
  return page.eval('JSON.parse(JSON.stringify(window.__abbaWire || []))')
}
function getErrors(page) {
  return page.eval('JSON.parse(JSON.stringify(window.__abbaErrors || []))')
}

async function runChatScenario(chatUrl, outDir) {
  console.log('\n[1] 聊天服务 v2（加密双人流程）')
  const A = await createPage(edgePort)
  const B = await createPage(edgePort)
  const PW_A = '24681357'
  const PW_B = '97531'
  const MSG1 = '你好，B，这是一条只在内存里的加密消息'
  const MSG2 = '收到，B 回复一条'
  try {
    for (const p of [A, B]) {
      await p.page.init()
      await p.page.addInitScript(INSTRUMENT)
      await p.page.goto(chatUrl)
    }

    check('页面加载（开始页）', await visible(A.page, 'screen-start'))
    await A.page.screenshot(join(outDir, '02-start-page.png'))

    await fillAndStart(A.page, { a: PW_A, b: PW_B }, 'wait')
    check('A 双密码发起（只发 pairKey）后进入等待页', true)
    await A.page.screenshot(join(outDir, 'chat-02-waiting.png'))

    await fillAndStart(B.page, { a: PW_B, b: PW_A }, 'chat')
    await waitFor(() => visible(A.page, 'screen-chat'), { timeout: 20000, label: 'A chat screen' })
    check('B 填反 A/B 框也能配对成功（pairKey 等价）', true)

    await sendText(A.page, MSG1)
    await waitFor(() => B.page.eval(`document.getElementById('msgs').textContent.indexOf(${JSON.stringify(MSG1)}) >= 0`), { label: 'B receives text' })
    check('A → B 加密文字实时送达', true)
    const peerTagB = await B.page.eval(`(function(){
      var peerTag=(document.querySelector('.msg.peer .tag')||{}).textContent||'';
      return peerTag;
    })()`)
    check('B 视角「对方」标签=你', peerTagB === '你', peerTagB)

    await sendText(B.page, MSG2)
    await waitFor(() => A.page.eval(`document.getElementById('msgs').textContent.indexOf(${JSON.stringify(MSG2)}) >= 0`), { label: 'A receives reply' })
    const labelsB = await B.page.eval(`(function(){
      var selfTag=(document.querySelector('.msg.self .tag')||{}).textContent||'';
      var peerTag=(document.querySelector('.msg.peer .tag')||{}).textContent||'';
      return selfTag+'|'+peerTag;
    })()`)
    check('B 视角标签：自己=我，对方=你', labelsB === '我|你', labelsB)
    const labelsA = await A.page.eval(`(function(){
      var selfTag=(document.querySelector('.msg.self .tag')||{}).textContent||'';
      var peerTag=(document.querySelector('.msg.peer .tag')||{}).textContent||'';
      return selfTag+'|'+peerTag;
    })()`)
    check('A 视角标签：自己=我，对方=你', labelsA === '我|你', labelsA)
    await A.page.screenshot(join(outDir, 'chat-03-chat.png'))

    // 图片：粘贴 → 预览 → 发送
    await pasteImage(A.page)
    await waitFor(() => visible(A.page, 'preview'), { timeout: 10000, label: 'image preview' })
    check('粘贴图片出现预览', true)
    await A.page.eval(`document.getElementById('btn-preview-send').click(); true`)
    await waitFor(() => B.page.eval(`(function(){
      var img=document.querySelector('.msg.peer.pic-msg img') || document.querySelector('.msg.peer img');
      return !!img && /^data:image\\//.test(img.getAttribute('src')||'') && img.getAttribute('src').length > 100;
    })()`), { timeout: 15000, label: 'B receives image' })
    check('A → B 加密图片送达并解密显示', true)
    await B.page.screenshot(join(outDir, 'chat-04-dialog.png'))

    // 线上无明文 + payload 形状
    const wireA = await getWire(A.page)
    const enter = wireA.filter((w) => w.url.indexOf('/api/enter') >= 0)
    const sends = wireA.filter((w) => w.url.indexOf('/api/send') >= 0)
    const enterBody = enter.length ? enter[enter.length - 1].body : ''
    check('/api/enter 只带 pairKey、不含密码明文', enterBody.indexOf('"pairKey"') >= 0 && enterBody.indexOf(PW_A) < 0 && enterBody.indexOf(PW_B) < 0, enterBody.slice(0, 120))
    let payloadOk = false
    let plaintextLeak = false
    for (const s of sends) {
      if (s.body.indexOf(MSG1) >= 0 || s.body.indexOf(MSG2) >= 0) plaintextLeak = true
      try {
        const parsed = JSON.parse(s.body)
        const p = parsed.payload
        if (p && typeof p === 'object' && p.v === 1 && (p.k === 'text' || p.k === 'image') && typeof p.iv === 'string' && typeof p.ct === 'string' && typeof p.mac === 'string') payloadOk = true
      } catch (e) { /* ignore */ }
    }
    check('/api/send 的 payload 是 {k,v,iv,ct,mac} 对象', payloadOk)
    check('线上请求体不含消息明文', !plaintextLeak)
    const imageSend = sends.map((s) => { try { return JSON.parse(s.body).payload.k } catch (e) { return '' } }).filter(Boolean)
    check('图片以 k=image 的密文 payload 发送', imageSend.indexOf('image') >= 0, imageSend.join(','))

    // 静态资源可加载
    const cryptoResp = await fetch(new URL('crypto.js', chatUrl))
    const vendorResp = await fetch(new URL('vendor/crypto-js.js', chatUrl))
    const cryptoBody = await cryptoResp.text()
    const vendorBody = await vendorResp.text()
    check('/crypto.js 可加载且为 AbbaCrypto', cryptoResp.ok && cryptoBody.indexOf('AbbaCrypto') >= 0, `${cryptoResp.status}/${cryptoBody.length}B`)
    check('/vendor/crypto-js.js 可加载且为 CryptoJS', vendorResp.ok && vendorBody.indexOf('CryptoJS') >= 0, `${vendorResp.status}/${vendorBody.length}B`)

    // 第三人被拒
    const C = await createPage(edgePort)
    await C.page.init()
    await C.page.addInitScript(INSTRUMENT)
    await C.page.goto(chatUrl)
    await fillAndStart(C.page, { a: PW_A, b: PW_B })
    await waitFor(() => C.page.eval(`document.getElementById('start-err').textContent.length > 0`), { timeout: 20000, label: 'third person rejected' })
    const err = await C.page.eval(`document.getElementById('start-err').textContent`)
    check('第三人凭同一对密码进不来', /正在进行|已有两人|稍后/.test(err), err)
    await closeTarget(edgePort, C.target.id)
    await C.page.close()

    // 截屏按钮：把 getDisplayMedia 打桩成“用户拒绝”，验证页面给中文提示且无未捕获异常
    // （真实屏幕捕获无法在无头环境自动完成，由用户手动验一次。）
    await A.page.eval(`(function(){
      try {
        navigator.mediaDevices.getDisplayMedia = function(){
          return Promise.reject(Object.assign(new Error('Permission denied by test'), { name: 'NotAllowedError' }));
        };
      } catch (e) {}
      return true; })()`)
    const shotBtn = await A.page.eval(`!!document.getElementById('btn-shot')`)
    check('聊天页存在「截屏」按钮', shotBtn)
    await A.page.eval(`document.getElementById('btn-shot').click(); true`)
    const shotMsg = await waitFor(async () => {
      const t = await A.page.eval(`document.getElementById('msgs').textContent`)
      return /截屏/.test(t) ? t : ''
    }, { timeout: 15000, label: 'screenshot notice' }).catch(() => '')
    check('截屏按钮在无权限时给出中文提示', /截屏/.test(shotMsg), String(shotMsg).slice(-80))
    const errsA = await getErrors(A.page)
    check('页面无未捕获异常', Array.isArray(errsA) && errsA.length === 0, JSON.stringify(errsA).slice(0, 160))

    // 结束清空
    await A.page.eval(`document.getElementById('btn-leave').click(); true`)
    await waitFor(() => visible(A.page, 'screen-start'), { label: 'A back to start' })
    await waitFor(() => visible(B.page, 'screen-start'), { label: 'B back to start' })
    const cleared = await A.page.eval(`document.getElementById('msgs').children.length + (document.getElementById('preview').classList.contains('hidden') ? 1 : 0)`)
    const clearedB = await B.page.eval(`document.getElementById('msgs').children.length`)
    check('结束聊天后双方内容清空', cleared === 1 && clearedB === 0, `A=${cleared} B=${clearedB}`)
    await B.page.screenshot(join(outDir, 'chat-05-ended.png'))

    // 重配对：房间已销毁，同一对密码可再次配对
    await fillAndStart(A.page, { a: PW_A, b: PW_B }, 'wait')
    await fillAndStart(B.page, { a: PW_B, b: PW_A }, 'chat')
    check('结束后同一对密码可重新配对', true)
    await A.page.eval(`document.getElementById('btn-leave').click(); true`)
    await sleep(500)
  } finally {
    await closeTarget(edgePort, A.target.id).catch(() => {})
    await closeTarget(edgePort, B.target.id).catch(() => {})
    await A.page.close(); await B.page.close()
  }
}

// ---------- DSH 面板 ----------
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

async function frameEval(page, urlPart, expression) {
  const { frameTree } = await page.cdp.send('Page.getFrameTree')
  const frame = findFrame(frameTree, urlPart)
  if (!frame) throw new Error('chat iframe not found in frame tree')
  const { executionContextId } = await page.cdp.send('Page.createIsolatedWorld', {
    frameId: frame.id,
    worldName: 'abba-e2e',
  })
  const res = await page.cdp.send('Runtime.evaluate', {
    expression, contextId: executionContextId, awaitPromise: true, returnByValue: true,
  })
  if (res.exceptionDetails) throw new Error(`frame eval failed: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text || ''}`)
  return res.result?.value
}

async function runDshScenario(dshUrl, chatUrl, outDir) {
  console.log('\n[2] DSH Web UI 内的入口、右侧栏面板与面板内加密聊天')
  const { target, page } = await createPage(edgePort)
  try {
    await page.init({ width: 1440, height: 900 })
    await page.goto(dshUrl)
    await waitFor(async () => {
      const txt = await page.eval(`document.body ? document.body.innerText : ''`)
      return typeof txt === 'string' && txt.length > 0 && /DeepSeek|Harness|新|会话|New/i.test(txt)
    }, { timeout: 30000, label: 'DSH shell boot' })
    await sleep(1200)
    await dismissDshNotice(page)
    await page.screenshot(join(outDir, 'dsh-01-home.png'))

    const boot = await page.eval(`(function(){
      try { var b=window.__DSH_BOOT__; return b ? JSON.stringify(b.entries.map(function(e){return e.id})) : ''; } catch(e){ return 'ERR:'+e.message }
    })()`)
    check('boot 图包含本插件 client bundle', typeof boot === 'string' && boot.includes('dsh-abba-secret-chat'), String(boot).slice(0, 120))

    const entry = await page.eval(`(function(){
      var nodes=Array.prototype.slice.call(document.querySelectorAll('button,[role=button],a,div'));
      var hit=nodes.find(function(n){ return n.className && String(n.className).split(' ').some(function(c){return c.indexOf('abba-')===0}) });
      return hit ? (hit.className + ' | ' + (hit.textContent||'').slice(0,40)) : '';
    })()`)
    check('左侧栏底部入口按钮已渲染', Boolean(entry), entry || 'not found')

    await page.eval(`(function(){
      var nodes=Array.prototype.slice.call(document.querySelectorAll('button,[role=button],a,*'));
      for (var i=0;i<nodes.length;i++){ var n=nodes[i]; if(n.className && String(n.className).split(' ').some(function(c){return c.indexOf('abba-')===0})){ (n.closest('button,[role=button],a') || n).click(); return true; } }
      return false;
    })()`)
    await sleep(2200)
    const panel = await page.eval(`(function(){
      var frames=Array.prototype.slice.call(document.querySelectorAll('iframe'));
      var f=frames.find(function(x){ var s=x.getAttribute('src')||''; return /^https?:\\/\\/(127\\.0\\.0\\.1|localhost):\\d+\\//.test(s); });
      return JSON.stringify({ iframe: f ? f.getAttribute('src') : null, allow: f ? (f.getAttribute('allow')||'') : '' });
    })()`)
    const p = JSON.parse(panel)
    const frameKey = (() => { try { return new URL(p.iframe).host } catch (e) { return '127.0.0.1:8787' } })()
    check('点击入口后聊天面板出现', Boolean(p.iframe), panel)
    check('面板 iframe 带 display-capture 授权（截屏用）', String(p.allow).indexOf('display-capture') >= 0, p.allow)
    await page.screenshot(join(outDir, '03-panel-and-entry.png'))

    if (p.iframe) {
      const PW1 = '4321'
      const PW2 = '8765'
      await waitFor(async () => frameEval(page, frameKey, `document.getElementById('pwd-a') ? 'ready' : ''`), { timeout: 12000, label: 'chat iframe ready' })
      check('面板 iframe 已加载聊天页', true)

      await frameEval(page, frameKey, `(function(){
        document.getElementById('pwd-a').value='${PW1}';
        document.getElementById('pwd-b').value='${PW2}';
        document.getElementById('btn-start').click();
        return true; })()`)
      await waitFor(async () => frameEval(page, frameKey, `!document.getElementById('screen-wait').classList.contains('hidden')`), { timeout: 15000, label: 'panel waiting' })
      check('面板内双密码发起成功（pairKey）', true)

      const peer = await createPage(edgePort, chatUrl)
      await peer.page.init({ width: 1000, height: 860 })
      await peer.page.goto(chatUrl)
      await fillAndStart(peer.page, { a: PW2, b: PW1 }, 'chat')
      await waitFor(async () => frameEval(page, frameKey, `!document.getElementById('screen-chat').classList.contains('hidden')`), { timeout: 20000, label: 'panel chat' })
      check('对端加入后面板内配对成功', true)

      const PANEL_MSG = '面板里收到的加密消息'
      await peer.page.eval(`(function(){
        var t=document.getElementById('text'); t.value=${JSON.stringify(PANEL_MSG)};
        document.getElementById('send-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
        return true; })()`)
      await waitFor(async () => frameEval(page, frameKey, `document.getElementById('msgs').textContent.indexOf(${JSON.stringify(PANEL_MSG)}) >= 0`), { timeout: 15000, label: 'panel receives' })
      check('对端 → DSH 右侧栏面板内解密并显示消息', true)
      const panelTag = await frameEval(page, frameKey, `(function(){
        var t=document.querySelector('.msg.peer .tag')||document.querySelector('.msg.self .tag');
        return t?t.textContent:'';
      })()`)
      check('面板内消息带「你/我」标签', panelTag === '你' || panelTag === '我', String(panelTag))
      await page.screenshot(join(outDir, '01-sidebar-chat.png'))

      await frameEval(page, frameKey, `(function(){ window.confirm=function(){return true}; document.getElementById('btn-leave').click(); return true; })()`)
      await waitFor(async () => frameEval(page, frameKey, `!document.getElementById('screen-start').classList.contains('hidden')`), { timeout: 12000, label: 'panel back to start' })
      const peerCleared = await waitFor(async () => (await peer.page.eval(`document.getElementById('msgs').children.length`)) === 0, { timeout: 10000, label: 'peer cleared' }).then(() => true).catch(() => false)
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
  await runDshScenario(dshUrl, chat, outDir)
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

