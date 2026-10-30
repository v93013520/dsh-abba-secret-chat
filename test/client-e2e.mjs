#!/usr/bin/env node
/**
 * test/client-e2e.mjs — 真实 DSH 实例上的浏览器半验收（HTTP 层，无需无头浏览器）。
 *
 * 断言：
 *  1) GET / 的 HTML 里 `window.__DSH_BOOT__` 是合法 boot 图，entries 含本包
 *     `dsh-abba-secret-chat`，且该行带 url/rev；
 *  2) 按 boot 行给出的 url（combo 或单文件）能取到 bundle，内容含包 id、tab kind
 *     `abba-chat`、`openTab`、三个槽位键；
 *  3) 旧式单文件路径 `/plugins/dsh-abba-secret-chat/client.js` 也返回 200
 *     （证明 bundle 没有 404，宿主按 mtime/size 发布）；
 *  4) 顺带报告 `/abba/info`（宿主半的契约路由）状态，缺失只告警不失败。
 *
 * 用法：
 *   node test/client-e2e.mjs                       # 默认 http://127.0.0.1:3099
 *   node test/client-e2e.mjs --base http://127.0.0.1:3097
 *   node test/client-e2e.mjs --wait 30000          # 等实例就绪（毫秒）
 *   node test/client-e2e.mjs --token <token>       # dsh web 是带令牌的：把启动输出里 ?token=... 的值传进来
 *   ABBA_E2E_BASE=... ABBA_E2E_TOKEN=... node test/client-e2e.mjs
 *
 * 注意：dsh web 的 `/` 受浏览器令牌栅栏保护（未认证 401，见 dsh-client-connection README），
 * 所以对已登录实例抓 boot 图时必须给 `?token=`；`/abba/info` 与静态资源不需要。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.resolve(HERE, '..', 'client', 'client.js')
const PLUGIN_ID = 'dsh-abba-secret-chat'
const REQUIRED_MARKERS = [
  PLUGIN_ID,
  "'abba-chat'", // tab kind
  'openTab',
  'sidebar.right.pane.tab',
  'sidebar.footer.action',
  'shell.overlay',
  'abba: overlay', // 只有本包 client.js 才有的注册标签
]

function parseArgs(argv) {
  const options = {
    base: process.env.ABBA_E2E_BASE || 'http://127.0.0.1:3099',
    token: process.env.ABBA_E2E_TOKEN || '',
    waitMs: 0,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--base' && index + 1 < argv.length) {
      options.base = argv[index + 1]
      index += 1
    } else if (arg.startsWith('--base=')) {
      options.base = arg.slice('--base='.length)
    } else if (arg === '--token' && index + 1 < argv.length) {
      options.token = argv[index + 1]
      index += 1
    } else if (arg.startsWith('--token=')) {
      options.token = arg.slice('--token='.length)
    } else if (arg === '--wait' && index + 1 < argv.length) {
      options.waitMs = Number(argv[index + 1]) || 0
      index += 1
    } else if (arg.startsWith('--wait=')) {
      options.waitMs = Number(arg.slice('--wait='.length)) || 0
    }
  }
  options.base = options.base.replace(/\/+$/, '')
  return options
}

const options = parseArgs(process.argv.slice(2))
/** 认证后带的 cookie（dsh web 用 /?token=... 交换）。 */
const authHeaders = {}

let passed = 0
const failures = []
const notes = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ✔ ' + name)
  } catch (error) {
    failures.push({ name, error })
    console.log('  ✘ ' + name)
    console.log('    ' + String((error && error.message) || error))
  }
}

function section(title) {
  console.log('\n' + title)
}

/** 等实例就绪：轮询 GET / 直到 200（或 401：服务已起但需要令牌）。 */
async function waitForServer(base, waitMs) {
  const deadline = Date.now() + waitMs
  let lastError = null
  for (;;) {
    try {
      const response = await fetch(base + '/', { cache: 'no-store', headers: authHeaders, redirect: 'manual' })
      if (response.ok || response.status === 401 || response.status === 303) return true
      lastError = new Error('HTTP ' + response.status)
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) throw new Error('实例未就绪: ' + base + ' (' + String(lastError && lastError.message) + ')')
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * 用启动输出里的 `?token=` 交换浏览器 cookie（/ → 303 + Set-Cookie）。
 * @returns {Promise<void>}
 */
async function bootstrapToken() {
  const response = await fetch(options.base + '/?token=' + encodeURIComponent(options.token), { cache: 'no-store', redirect: 'manual' })
  const setCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter((value) => typeof value === 'string' && value.length > 0)
  if (setCookies.length === 0) throw new Error('令牌交换没有拿到 cookie（HTTP ' + response.status + '）')
  authHeaders.cookie = setCookies
    .map((value) => String(value).split(';')[0].trim())
    .filter((value) => value.length > 0)
    .join('; ')
  notes.push('已用 ?token= 交换浏览器 cookie（HTTP ' + response.status + '）')
}

/**
 * 从 HTML 里抠出 `window.__DSH_BOOT__ = {...}` 的 JSON（值里的 `<` 已被宿主转义成 \u003c，仍是合法 JSON）。
 * @param {string} html - 首页 HTML。
 * @returns {object} boot 图。
 */
function extractBootGraph(html) {
  const anchor = html.indexOf('__DSH_BOOT__')
  if (anchor < 0) throw new Error('HTML 里没有 window.__DSH_BOOT__')
  const start = html.indexOf('{', anchor)
  if (start < 0) throw new Error('__DSH_BOOT__ 后没有对象字面量')
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < html.length; index += 1) {
    const char = html[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const json = html.slice(start, index + 1)
        try {
          return JSON.parse(json)
        } catch (error) {
          throw new Error('__DSH_BOOT__ JSON 解析失败: ' + String(error && error.message))
        }
      }
    }
  }
  throw new Error('__DSH_BOOT__ 对象没有闭合')
}

/** @param {string} url - boot 行里的 url（可能是 app 目录相对路径）。 @returns {string} 绝对 URL。 */
function resolveUrl(base, url) {
  if (/^https?:\/\//i.test(url)) return url
  if (url.startsWith('/')) return base + url
  return base + '/' + url
}

async function fetchText(url) {
  const response = await fetch(url, { cache: 'no-store', headers: authHeaders })
  const text = await response.text()
  return { status: response.status, ok: response.ok, text, contentType: response.headers.get('content-type') || '' }
}

async function main() {
  console.log('AB-BA 秘密对话 · 浏览器半真实实例验收')
  console.log('  base   : ' + options.base)
  console.log('  bundle : ' + CLIENT_PATH)
  const localSource = fs.readFileSync(CLIENT_PATH, 'utf8')

  if (options.waitMs > 0) {
    console.log('  等待实例就绪（最多 ' + options.waitMs + 'ms）…')
    await waitForServer(options.base, options.waitMs)
  }
  if (options.token !== '') {
    await bootstrapToken()
  } else {
    notes.push('未提供 --token：若 GET / 返回 401，把 dsh web 启动输出里的 ?token=... 传给 --token')
  }

  let html = ''
  let graph = null
  const bootRow = { row: null }

  section('1) 首页与 boot 图')
  await test('GET / 返回 200 且含 __DSH_BOOT__', async () => {
    const page = await fetchText(options.base + '/')
    if (page.status === 401) throw new Error('GET / → HTTP 401：需要令牌（--token <dsh web 打印的 ?token=...>）')
    if (!page.ok) throw new Error('GET / → HTTP ' + page.status)
    if (!page.text.includes('__DSH_BOOT__')) throw new Error('HTML 缺少 __DSH_BOOT__')
    html = page.text
  })
  await test('__DSH_BOOT__ 是合法 boot 图', () => {
    graph = extractBootGraph(html)
    if (!Array.isArray(graph.entries)) throw new Error('boot 图缺少 entries 数组')
    if (!Array.isArray(graph.batches)) throw new Error('boot 图缺少 batches 数组')
    if (typeof graph.rev !== 'string') throw new Error('boot 图缺少 rev')
  })
  await test('entries 含本包 ' + PLUGIN_ID, () => {
    if (graph === null) throw new Error('boot 图解析失败')
    bootRow.row = graph.entries.find((row) => row && row.id === PLUGIN_ID) || null
    if (bootRow.row === null) throw new Error('entries 里没有本包；实际 id: ' + graph.entries.map((row) => row && row.id).join(', '))
  })
  await test('该行带 url / rev，且被某个启动批次覆盖', () => {
    const row = bootRow.row
    if (typeof row.url !== 'string' || row.url.length === 0) throw new Error('行缺少 url')
    if (typeof row.rev !== 'string' || row.rev.length === 0) throw new Error('行缺少 rev')
    const batches = graph.batches.filter((batch) => Array.isArray(batch.entries) && batch.entries.includes(PLUGIN_ID))
    if (batches.length === 0) throw new Error('本包不在任何启动批次里')
    notes.push('boot 行 url = ' + row.url + ' (rev ' + row.rev + ', 批次: ' + batches.map((batch) => batch.phase).join('/') + ')')
  })

  section('2) bundle 可取且是本次构建')
  const bundleUrl = bootRow.row === null ? options.base + '/plugins/' + PLUGIN_ID + '/client.js' : resolveUrl(options.base, bootRow.row.url)
  await test('boot 行 url 返回 200', async () => {
    const bundle = await fetchText(bundleUrl)
    if (!bundle.ok) throw new Error('GET ' + bundleUrl + ' → HTTP ' + bundle.status)
    notes.push('bundle 响应 ' + bundle.text.length + ' 字节, content-type=' + bundle.contentType)
  })
  await test('bundle 内容含本包注册标记', async () => {
    const bundle = await fetchText(bundleUrl)
    for (const marker of REQUIRED_MARKERS) {
      if (!bundle.text.includes(marker)) throw new Error('bundle 缺少标记: ' + marker)
    }
  })
  await test('bundle 与本地 client/client.js 是同一份内容', async () => {
    const bundle = await fetchText(bundleUrl)
    // combo 响应会把多个 client.js 拼在一起，并追加 sourcemap 尾注；用一段独有正文判断。
    const fingerprint = localSource.slice(localSource.indexOf('const CSS_TEXT'), localSource.indexOf('const CSS_TEXT') + 160)
    if (!bundle.text.includes(fingerprint)) throw new Error('bundle 里找不到本地 client.js 的 CSS 指针，可能服务的是旧副本')
  })
  await test('boot 图没有把本包标成失败/缺失', () => {
    const row = bootRow.row
    if (row && row.immediately !== undefined && typeof row.immediately !== 'boolean') throw new Error('immediately 字段类型异常')
    const failuresOnPage = /Failed to load plugins/i.test(html)
    if (failuresOnPage) notes.push('首页 HTML 里出现 “Failed to load plugins” 字样（可能是引导页模板文案）')
  })
  // 0.2.1-rc.3 只保证 combo URL 可取；单文件 `/plugins/<pkg>/client.js` 返回 404 属正常行为。
  try {
    const direct = await fetchText(options.base + '/plugins/' + PLUGIN_ID + '/client.js')
    notes.push('单文件路径 /plugins/' + PLUGIN_ID + '/client.js → HTTP ' + direct.status + '（combo 才是 0.2.1 的正式通道）')
  } catch (error) {
    notes.push('单文件路径探测失败: ' + String((error && error.message) || error))
  }

  section('3) 宿主半契约路由（信息性，不计入失败）')
  try {
    const response = await fetch(options.base + '/abba/info', { cache: 'no-store' })
    if (!response.ok) {
      notes.push('/abba/info → HTTP ' + response.status + '（宿主半未装/未就绪时属预期）')
    } else {
      const payload = await response.json()
      if (typeof payload !== 'object' || payload === null) {
        notes.push('/abba/info 返回非 JSON 对象')
      } else {
        notes.push('/abba/info = ' + JSON.stringify(payload))
      }
    }
  } catch (error) {
    notes.push('/abba/info 请求失败: ' + String((error && error.message) || error))
  }

  console.log('\n观察记录:')
  for (const note of notes) console.log('  · ' + note)
  console.log('\n结果: ' + passed + ' 通过, ' + failures.length + ' 失败')
  if (failures.length > 0) {
    console.log('\n失败详情:')
    for (const failure of failures) console.log(' - ' + failure.name + ': ' + String((failure.error && failure.error.message) || failure.error))
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('\n✘ 验收异常终止: ' + String((error && error.message) || error))
  process.exit(1)
})
