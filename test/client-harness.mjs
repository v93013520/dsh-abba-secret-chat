#!/usr/bin/env node
/**
 * test/client-harness.mjs — AB-BA 秘密对话浏览器半的离线自测（无需宿主、无需网络）。
 *
 * 做的事：
 *  1) 在 Node 里桩 `window.__ModuleLoader__`，按真实浏览器协议物化 `client/client.js`；
 *  2) 用假 ctx（slots / sidebarRight / sidebarRightTabs 记录器）跑 `apply`，
 *     并像真宿主一样校验 list slot 必须带 id、keyed slot 必须带 key；
 *  3) 用真实的 react-dom/server（从本机已装依赖里解析，不引入新依赖）渲染
 *     tab body / 入口按钮 / 浮层，断言 DOM 结构与降级行为；
 *  4) 断言样式只注入一次、注册可清理、中英文案跟随 navigator.language。
 *
 * 运行： node test/client-harness.mjs
 * 依赖解析：默认从 D:\DeepSeek-Harness 的 pnpm store 找 react-dom@18；也可用
 *          ABBA_REACT_ROOT 指定一个含 react/ 与 react-dom/ 的目录，或 pnpm store 根目录。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.resolve(HERE, '..', 'client', 'client.js')
const PLUGIN_ID = 'dsh-abba-secret-chat'
const TAB_KIND = 'abba-chat'
const FALLBACK_URL = 'http://127.0.0.1:8787/'

//#region react / react-dom 解析（宿主提供的平台种子在 Node 里没有，用本机已装副本）
function resolveReactRoot() {
  const roots = [
    process.env.ABBA_REACT_ROOT,
    'D:/DeepSeek-Harness/node_modules/.pnpm',
    'D:/DeepSeek-Harness/node_modules',
    path.resolve(HERE, '..', 'node_modules'),
    path.resolve(process.cwd(), 'node_modules'),
  ].filter((root) => typeof root === 'string' && root.length > 0)
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const direct = path.join(root, 'react-dom', 'package.json')
    if (fs.existsSync(direct)) return direct
    let entries = []
    try {
      entries = fs.readdirSync(root)
    } catch (error) {
      continue
    }
    for (const name of entries) {
      if (!name.startsWith('react-dom@')) continue
      const candidate = path.join(root, name, 'node_modules', 'react-dom', 'package.json')
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

const reactDomPackageJson = resolveReactRoot()
if (reactDomPackageJson === null) {
  console.error('✘ 找不到 react-dom。请设置 ABBA_REACT_ROOT 指向含 react/ 与 react-dom/ 的目录。')
  process.exit(1)
}
const reactRequire = createRequire(pathToFileURL(reactDomPackageJson))
const React = reactRequire('react')
const ReactDOMServer = reactRequire('react-dom/server')
const h = React.createElement
//#endregion

//#region 测试运行器
let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ✔ ' + name)
  } catch (error) {
    failures.push({ name, error })
    console.log('  ✘ ' + name)
    console.log('    ' + String((error && error.stack) || error).split('\n').slice(0, 6).join('\n    '))
  }
}

function section(title) {
  console.log('\n' + title)
}
//#endregion

//#region 假 DOM（只覆盖本 bundle 用到的 API）
function createFakeDocument() {
  const styles = []
  const head = {
    children: [],
    appendChild(node) {
      head.children.push(node)
      if (node && node.tagName === 'style') styles.push(node)
      return node
    },
  }
  const body = {
    children: [],
    appendChild(node) {
      body.children.push(node)
      return node
    },
  }
  function querySelector(selector) {
    const match = /^style\[data-plugin="(.*)"\]$/.exec(String(selector))
    if (match === null) return null
    return styles.find((style) => style.attrs['data-plugin'] === match[1]) || null
  }
  function createElement(tagName) {
    const element = {
      tagName: String(tagName).toLowerCase(),
      attrs: {},
      style: {},
      children: [],
      textContent: '',
      value: '',
      setAttribute(name, value) {
        element.attrs[String(name)] = String(value)
      },
      getAttribute(name) {
        return element.attrs[String(name)] === undefined ? null : element.attrs[String(name)]
      },
      appendChild(child) {
        element.children.push(child)
        return child
      },
      remove() {
        const index = head.children.indexOf(element)
        if (index >= 0) head.children.splice(index, 1)
        if (element.tagName === 'style') {
          const styleIndex = styles.indexOf(element)
          if (styleIndex >= 0) styles.splice(styleIndex, 1)
        }
      },
      select() {},
    }
    return element
  }
  return {
    document: { head, body, querySelector, createElement, execCommand: () => false, addEventListener() {}, removeEventListener() {} },
    styles,
  }
}
//#endregion

//#region bundle 物化 + 假宿主
/**
 * 载入 bundle 并物化工厂。
 * bundle 里只把 window/document/navigator/fetch/setTimeout/clearTimeout 当全局，
 * 这里用 new Function 的参数注入，避免污染 Node 全局。
 * @param {object} env - 测试环境。
 * @returns {{ definition: object, exports: object }}
 */
function loadBundle(env) {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8')
  const evaluate = new Function('window', 'document', 'navigator', 'fetch', 'setTimeout', 'clearTimeout', source)
  evaluate(env.window, env.document, env.navigator, env.fetch, setTimeout, clearTimeout)
  const definition = env.window.__definition
  assert.ok(definition, 'bundle 必须调用 window.__ModuleLoader__.load')
  assert.equal(definition.id, PLUGIN_ID, 'bundle id 必须是包名')
  assert.equal(typeof definition.factory, 'function', 'bundle 必须提供 factory(require)')
  const exportsObj = definition.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error('client bundle 只能 require 平台种子，实际请求了: ' + specifier)
  })
  return { definition, exports: exportsObj }
}

/** @returns {object} 一个新的测试环境。 */
function createEnv(options = {}) {
  const { document, styles } = createFakeDocument()
  const windowOpenCalls = []
  const windowListeners = new Map()
  const fetchCalls = []
  const navigator = { language: options.language || 'zh-CN' }
  const fetchImpl =
    options.fetch ||
    (() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, running: true, port: 8787, localUrl: FALLBACK_URL, lanUrls: [], version: '0.1.0' }) }))
  const fetch = (input, init) => {
    fetchCalls.push({ input, init })
    try {
      return Promise.resolve(fetchImpl(input, init))
    } catch (error) {
      return Promise.reject(error)
    }
  }
  const window = {
    __definition: null,
    __ModuleLoader__: {
      load(definition) {
        window.__definition = definition
      },
    },
    open(...args) {
      windowOpenCalls.push(args)
      return { closed: false }
    },
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, [])
      windowListeners.get(type).push(listener)
    },
    removeEventListener(type, listener) {
      const list = windowListeners.get(type)
      if (!list) return
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
    },
    dispatchEvent(type, event) {
      for (const listener of (windowListeners.get(type) || []).slice()) listener(event)
    },
  }
  return { document, styles, window, navigator, fetch, fetchCalls, windowOpenCalls, windowListeners }
}

const SLOT_SPEC = {
  'sidebar.right.pane.tab': 'keyed',
  'sidebar.footer.action': 'list',
  'shell.overlay': 'list',
}

/**
 * 假 ctx：effect 立刻执行并收集 cleanup；slots 按真宿主的 kind 规则校验；
 * sidebarRight 可配置为正常 / 抛错（无会话）/ 完全缺失。
 * @param {object} options - { sidebarRight: 'ok'|'throwing'|'absent', sidebarRightTabs: boolean }
 * @returns {{ ctx: object, record: object }}
 */
function createFakeCtx(options = {}) {
  const sidebarRightMode = options.sidebarRight || 'ok'
  const record = { effects: [], tabTypes: [], slots: [], injected: [], openTabCalls: [], labels: [] }

  const sidebarRightTabs = {
    register(definition) {
      record.tabTypes.push(definition)
      let live = true
      return () => {
        if (!live) return
        live = false
        const index = record.tabTypes.indexOf(definition)
        if (index >= 0) record.tabTypes.splice(index, 1)
      }
    },
  }

  const slots = {
    inject(key, factory) {
      record.injected.push(key)
      assert.ok(Object.prototype.hasOwnProperty.call(SLOT_SPEC, key), `往未声明的槽位注册: ${key}`)
      const dispose = factory()
      let live = true
      return () => {
        if (!live) return
        live = false
        if (typeof dispose === 'function') dispose()
      }
    },
    register(registration, component) {
      const kind = SLOT_SPEC[registration.name]
      assert.ok(kind !== undefined, `槽位未声明: ${registration.name}`)
      if (kind === 'list') assert.equal(typeof registration.id, 'string', `list slot ${registration.name} 必须带 id`)
      if (kind === 'keyed') assert.equal(typeof registration.key, 'string', `keyed slot ${registration.name} 必须带 key`)
      const entry = {
        name: registration.name,
        kind,
        id: registration.id,
        key: registration.key,
        order: registration.order,
        component,
        options: registration,
      }
      record.slots.push(entry)
      let live = true
      return () => {
        if (!live) return
        live = false
        const index = record.slots.indexOf(entry)
        if (index >= 0) record.slots.splice(index, 1)
      }
    },
    entriesOfSlot(key) {
      return record.slots.filter((slot) => slot.name === key)
    },
  }

  const ctx = {
    effect(fn, label) {
      const dispose = fn()
      const entry = { label, dispose, done: false }
      record.effects.push(entry)
      record.labels.push(label)
      return () => {
        if (entry.done) return
        entry.done = true
        if (typeof dispose === 'function') dispose()
      }
    },
    slots,
    sidebarRightTabs,
  }
  if (options.sidebarRightTabs === false) delete ctx.sidebarRightTabs

  if (sidebarRightMode === 'throwing') {
    ctx.sidebarRight = {
      openTab(kind) {
        record.openTabCalls.push(kind)
        throw new Error('sidebarRight: no session surface is mounted')
      },
    }
  } else if (sidebarRightMode === 'ok') {
    ctx.sidebarRight = {
      openTab(kind) {
        record.openTabCalls.push(kind)
      },
    }
  }

  return { ctx, record }
}

/** 等微任务/定时器把 /abba/info 的 Promise 链跑完。 */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 25))
}

/** @returns {object|undefined} 某个槽位里本次注册的组件。 */
function registered(record, name) {
  const slot = record.slots.find((candidate) => candidate.name === name)
  return slot === undefined ? undefined : slot.component
}
//#endregion

async function main() {
  console.log('AB-BA 秘密对话 · 浏览器半自测')
  console.log('  bundle : ' + CLIENT_PATH)
  console.log('  react  : ' + React.version + ' (' + reactDomPackageJson + ')')

  //#region 1) bundle 协议
  section('1) bundle 协议与导出')
  {
    const env = createEnv()
    const { definition, exports } = loadBundle(env)
    const entry = { definition, exports }
    await test('id 为包名 dsh-abba-secret-chat', () => {
      assert.equal(entry.definition.id, PLUGIN_ID)
    })
    await test('exports.name / inject / apply', () => {
      assert.equal(entry.exports.name, 'abba-secret-chat')
      assert.deepEqual(entry.exports.inject, ['slots', 'sidebarRight', 'sidebarRightTabs'])
      assert.equal(typeof entry.exports.apply, 'function')
    })
    await test('执行 bundle 只注册工厂，不执行 apply', () => {
      assert.equal(env.styles.length, 0, '物化阶段不应有样式副作用')
      assert.equal(env.window.__definition, entry.definition)
    })
    await test('只 require 平台种子（react）', () => {
      // loadBundle 里的 require 桩会对任何非 react 请求抛错，走到这里即通过。
      assert.ok(entry.exports.apply)
    })
  }
  //#endregion

  //#region 2) apply 注册
  section('2) apply 注册（tab 类型 / tab body / 侧栏入口 / 浮层）')
  {
    const env = createEnv({
      fetch: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              running: true,
              port: 8787,
              localUrl: FALLBACK_URL,
              lanUrls: ['http://192.168.1.10:8787/'],
              version: '0.1.0',
            }),
        }),
    })
    const { definition, exports } = loadBundle(env)
    const { ctx, record } = createFakeCtx()
    exports.apply(ctx)
    await settle()

    await test('tab 类型：id / kind / title / guide', () => {
      assert.equal(record.tabTypes.length, 1)
      const tabType = record.tabTypes[0]
      assert.equal(tabType.id, PLUGIN_ID)
      assert.equal(tabType.kind, TAB_KIND)
      assert.equal(typeof tabType.title, 'function')
      assert.equal(tabType.title(), '秘密对话')
      assert.ok(Array.isArray(tabType.guide) && tabType.guide.length === 1)
      assert.equal(tabType.guide[0].id, TAB_KIND)
      assert.equal(tabType.guide[0].order, 40)
      assert.equal(tabType.guide[0].title(), '秘密对话')
      assert.equal(typeof tabType.guide[0].description(), 'string')
    })
    await test('tab body：sidebar.right.pane.tab + key=包 id', () => {
      const slot = record.slots.find((candidate) => candidate.name === 'sidebar.right.pane.tab')
      assert.ok(slot, '必须注册 sidebar.right.pane.tab')
      assert.equal(slot.key, PLUGIN_ID)
      assert.equal(typeof slot.component, 'function')
    })
    await test('侧栏入口：sidebar.footer.action（list 必须带 id）', () => {
      const slot = record.slots.find((candidate) => candidate.name === 'sidebar.footer.action')
      assert.ok(slot, '必须注册 sidebar.footer.action')
      assert.equal(slot.id, PLUGIN_ID)
      assert.equal(typeof slot.order, 'number')
      assert.equal(typeof slot.component, 'function')
    })
    await test('全局浮层：shell.overlay（list 必须带 id）', () => {
      const slot = record.slots.find((candidate) => candidate.name === 'shell.overlay')
      assert.ok(slot, '必须注册 shell.overlay')
      assert.equal(slot.id, PLUGIN_ID)
      assert.equal(typeof slot.component, 'function')
    })
    await test('三个槽位的 inject 目标正确', () => {
      assert.deepEqual(record.injected, ['sidebar.right.pane.tab', 'sidebar.footer.action', 'shell.overlay'])
    })
    await test('全部注册都走 ctx.effect（含可读标签）', () => {
      assert.equal(record.effects.length, record.labels.length)
      assert.deepEqual(record.labels, ['abba: tab type', 'abba: tab body', 'abba: footer button', 'abba: overlay'])
    })
    await test('样式只注入一次，且带 data-plugin=包 id', () => {
      assert.equal(env.styles.length, 1)
      assert.equal(env.styles[0].attrs['data-plugin'], PLUGIN_ID)
      assert.ok(env.styles[0].textContent.includes('.abba-tab'))
      assert.ok(env.styles[0].textContent.includes('.abba-overlay'))
    })
    await test('重复 apply 不会重复注入样式', () => {
      const second = createFakeCtx()
      exports.apply(second.ctx)
      assert.equal(env.styles.length, 1)
    })
    await test('/abba/info 用同源相对路径请求', () => {
      assert.ok(env.fetchCalls.length >= 1)
      assert.equal(env.fetchCalls[0].input, '/abba/info')
      assert.equal(env.fetchCalls[0].init.cache, 'no-store')
    })
  }
  //#endregion

  //#region 3) tab body 渲染
  section('3) tab body 渲染（工具条 + iframe）')
  {
    const env = createEnv({
      fetch: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              running: true,
              port: 8787,
              localUrl: FALLBACK_URL,
              lanUrls: ['http://192.168.1.10:8787/'],
              version: '0.1.0',
            }),
        }),
    })
    const { exports } = loadBundle(env)
    const { ctx, record } = createFakeCtx()
    exports.apply(ctx)
    await settle()
    const Tab = registered(record, 'sidebar.right.pane.tab')
    const markup = ReactDOMServer.renderToStaticMarkup(h(Tab))

    await test('结构：data-abba-tab + 36px 工具条 + iframe', () => {
      assert.ok(markup.includes('data-abba-tab'))
      assert.ok(markup.includes('data-abba-toolbar'))
      assert.ok(markup.includes('<iframe'))
      assert.ok(markup.includes('data-abba-frame'))
    })
    await test('iframe src 来自 /abba/info 的 localUrl', () => {
      assert.ok(markup.includes('src="' + FALLBACK_URL + '"'), '实际 iframe: ' + (markup.match(/src="[^"]*"/) || [])[0])
    })
    await test('工具条文案（中文）：标题 / 对方链接 / 在浏览器打开 / 刷新', () => {
      assert.ok(markup.includes('AB-BA 秘密对话'))
      assert.ok(markup.includes('对方链接'))
      assert.ok(markup.includes('在浏览器打开'))
      assert.ok(markup.includes('刷新聊天页'))
      assert.ok(markup.includes('192.168.1.10:8787'), '对方链接展示局域网地址')
    })
    await test('工具条动作按钮齐全', () => {
      for (const action of ['copy-peer', 'copy', 'open-external', 'refresh']) {
        assert.ok(markup.includes('data-abba-action="' + action + '"'), '缺少动作: ' + action)
      }
    })
    await test('运行中不显示离线横幅', () => {
      assert.ok(!markup.includes('abba-banner'))
    })
    await test('英文环境文案跟随 navigator.language', () => {
      env.navigator.language = 'en-US'
      const enMarkup = ReactDOMServer.renderToStaticMarkup(h(Tab))
      assert.ok(enMarkup.includes('AB-BA Secret Chat'))
      assert.ok(enMarkup.includes('Peer link'))
      assert.ok(enMarkup.includes('Open in browser'))
    })

    await test('info 变化后 iframe src 跟随（localUrl 带回退端口）', async () => {
      const env2 = createEnv({
        fetch: () =>
          Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ ok: true, running: true, port: 8790, localUrl: 'http://127.0.0.1:8790/', lanUrls: [] }),
          }),
      })
      const loaded = loadBundle(env2)
      const fake = createFakeCtx()
      loaded.exports.apply(fake.ctx)
      await settle()
      const tabMarkup = ReactDOMServer.renderToStaticMarkup(h(registered(fake.record, 'sidebar.right.pane.tab')))
      assert.ok(tabMarkup.includes('src="http://127.0.0.1:8790/"'), tabMarkup.slice(0, 400))
      assert.ok(!tabMarkup.includes('192.168.'), '没有 lanUrls 时不展示对方链接胶囊')
    })
  }
  //#endregion

  //#region 4) info 失败 → 回退地址
  section('4) /abba/info 失败时的回落与离线提示')
  {
    const env = createEnv({ fetch: () => Promise.reject(new Error('connect ECONNREFUSED')) })
    const { exports } = loadBundle(env)
    const { ctx, record } = createFakeCtx()
    exports.apply(ctx)
    await settle()
    const Tab = registered(record, 'sidebar.right.pane.tab')
    const markup = ReactDOMServer.renderToStaticMarkup(h(Tab))
    await test('fetch 失败回落到 http://127.0.0.1:8787/', () => {
      assert.ok(markup.includes('src="' + FALLBACK_URL + '"'))
    })
    await test('显示离线横幅含错误摘要与重试', () => {
      assert.ok(markup.includes('abba-banner'))
      assert.ok(markup.includes('聊天服务未运行'))
      assert.ok(markup.includes('ECONNREFUSED'))
      assert.ok(markup.includes('data-abba-action="retry"'))
    })
  }
  //#endregion

  //#region 5) 入口按钮渲染
  section('5) 侧栏底部入口按钮')
  {
    const env = createEnv()
    const { exports } = loadBundle(env)
    const { ctx, record } = createFakeCtx()
    exports.apply(ctx)
    await settle()
    const Entry = registered(record, 'sidebar.footer.action')
    const wideMarkup = ReactDOMServer.renderToStaticMarkup(h(Entry, { wide: true }))
    const narrowMarkup = ReactDOMServer.renderToStaticMarkup(h(Entry, { wide: false }))
    await test('wide：图标 + 「秘密对话」文字', () => {
      assert.ok(wideMarkup.includes('data-abba-entry'))
      assert.ok(wideMarkup.includes('data-wide="true"'))
      assert.ok(wideMarkup.includes('abba-entryLabel'))
      assert.ok(wideMarkup.includes('秘密对话'))
    })
    await test('窄侧栏：只有图标，不出现可见文字', () => {
      assert.ok(narrowMarkup.includes('data-wide="false"'))
      assert.ok(!narrowMarkup.includes('abba-entryLabel'))
      assert.ok(!narrowMarkup.includes('>秘密对话<'))
      assert.ok(narrowMarkup.includes('<svg'), '窄态仍要有锁形图标')
      assert.ok(narrowMarkup.includes('aria-label="打开 AB-BA 秘密对话"'))
    })
    await test('英文环境按钮文案', () => {
      env.navigator.language = 'en-US'
      const enMarkup = ReactDOMServer.renderToStaticMarkup(h(Entry, { wide: true }))
      assert.ok(enMarkup.includes('Secret chat'))
    })
  }
  //#endregion

  //#region 6) 点击链路：主路径
  section('6) 点击入口：右侧栏 tab 主路径')
  {
    const env = createEnv()
    const { exports } = loadBundle(env)
    const { ctx, record } = createFakeCtx()
    exports.apply(ctx)
    await settle()
    const Entry = registered(record, 'sidebar.footer.action')
    await test('点击调用 sidebarRight.openTab(\'abba-chat\')，不 window.open', () => {
      const element = Entry({ wide: true })
      assert.equal(typeof element.props.onClick, 'function')
      element.props.onClick()
      assert.deepEqual(record.openTabCalls, [TAB_KIND])
      assert.equal(env.windowOpenCalls.length, 0)
    })
  }
  //#endregion

  //#region 7) 点击链路：没有会话 → 浮层
  section('7) 点击入口：openTab 抛错（没有会话）→ 全局浮层')
  {
    const env = createEnv()
    const { exports } = loadBundle(env)
    const { ctx, record } = createFakeCtx({ sidebarRight: 'throwing' })
    exports.apply(ctx)
    await settle()
    const Entry = registered(record, 'sidebar.footer.action')
    const Overlay = registered(record, 'shell.overlay')

    await test('浮层默认关闭', () => {
      assert.equal(ReactDOMServer.renderToStaticMarkup(h(Overlay)), '')
    })
    await test('openTab 抛错被吞掉、转到浮层、不 window.open', () => {
      const element = Entry({ wide: true })
      assert.doesNotThrow(() => element.props.onClick())
      assert.deepEqual(record.openTabCalls, [TAB_KIND])
      assert.equal(env.windowOpenCalls.length, 0)
    })
    await settle()
    const overlayMarkup = ReactDOMServer.renderToStaticMarkup(h(Overlay))
    await test('浮层渲染 720×640 卡片 + iframe + 在浏览器打开', () => {
      assert.ok(overlayMarkup.includes('data-abba-overlay'))
      assert.ok(overlayMarkup.includes('data-abba-overlay-card'))
      assert.ok(overlayMarkup.includes('abba-overlayCard'))
      assert.ok(overlayMarkup.includes('<iframe'))
      assert.ok(overlayMarkup.includes('src="' + FALLBACK_URL + '"'))
      assert.ok(overlayMarkup.includes('AB-BA 秘密对话'))
      assert.ok(overlayMarkup.includes('当前没有打开的会话'))
      assert.ok(overlayMarkup.includes('data-abba-action="overlay-open-external"'))
      assert.ok(overlayMarkup.includes('data-abba-action="close"'), '浮层必须有关闭按钮')
    })
    await test('浮层关闭按钮生效（Esc 亦可关）', () => {
      assert.equal(exports.__internals.isOverlayOpen(), true)
      exports.__internals.closeOverlay()
      assert.equal(exports.__internals.isOverlayOpen(), false)
      assert.equal(ReactDOMServer.renderToStaticMarkup(h(Overlay)), '')
    })
    await test('Esc 关闭浮层', () => {
      Entry({ wide: true }).props.onClick()
      assert.equal(exports.__internals.isOverlayOpen(), true)
      env.window.dispatchEvent('keydown', { key: 'Escape' })
      assert.equal(exports.__internals.isOverlayOpen(), false)
    })
    await test('浮层底部「在浏览器打开」等价动作走 window.open', () => {
      // 浮层整体含 hooks，SSR 不能触发 DOM 事件；这里验证同一动作函数，并断言按钮已在上一测试的标记里。
      const opened = exports.__internals.openUrl(FALLBACK_URL)
      assert.equal(opened, true)
      assert.equal(env.windowOpenCalls.length, 1)
      assert.equal(env.windowOpenCalls[0][0], FALLBACK_URL)
    })
  }
  //#endregion

  //#region 8) 点击链路：旧宿主没有 sidebarRight
  section('8) 旧宿主降级：没有 sidebarRight')
  {
    const env = createEnv()
    const { exports } = loadBundle(env)
    const { ctx, record } = createFakeCtx({ sidebarRight: 'absent' })
    let applied = true
    try {
      exports.apply(ctx)
    } catch (error) {
      applied = false
    }
    await settle()
    await test('apply 不抛错，仍然注册按钮', () => {
      assert.equal(applied, true)
      assert.ok(registered(record, 'sidebar.footer.action'))
    })
    await test('点击退化为 window.open(localUrl)，不抛错', () => {
      const Entry = registered(record, 'sidebar.footer.action')
      assert.doesNotThrow(() => Entry({ wide: true }).props.onClick())
      assert.equal(env.windowOpenCalls.length, 1)
      assert.equal(env.windowOpenCalls[0][0], FALLBACK_URL)
      assert.equal(env.windowOpenCalls[0][1], '_blank')
    })
    await test('openTab 抛错且没有浮层时也退化为 window.open', async () => {
      const env2 = createEnv()
      const loaded = loadBundle(env2)
      const fake = createFakeCtx({ sidebarRight: 'throwing' })
      // 模拟 shell.overlay 未声明（老宿主）：inject 直到卸载都不会注册浮层。
      const originalInject = fake.ctx.slots.inject
      fake.ctx.slots.inject = (key, factory) => {
        if (key === 'shell.overlay') return () => {}
        return originalInject(key, factory)
      }
      loaded.exports.apply(fake.ctx)
      await settle()
      const Entry = registered(fake.record, 'sidebar.footer.action')
      assert.doesNotThrow(() => Entry({ wide: true }).props.onClick())
      assert.equal(env2.windowOpenCalls.length, 1)
      assert.equal(env2.windowOpenCalls[0][0], FALLBACK_URL)
    })
    await test('没有 sidebarRightTabs 时 apply 不抛错', () => {
      const env3 = createEnv()
      const loaded = loadBundle(env3)
      const fake = createFakeCtx({ sidebarRightTabs: false })
      assert.doesNotThrow(() => loaded.exports.apply(fake.ctx))
    })
  }
  //#endregion

  //#region 9) 局部加载失败隔离
  section('9) 宿主槽位缺失时不炸掉整页')
  {
    const env = createEnv()
    const { exports } = loadBundle(env)
    const { ctx } = createFakeCtx()
    // sidebar.footer.action 未声明：真宿主里 slots.inject 会一直等，不会抛错。
    const originalInject = ctx.slots.inject
    ctx.slots.inject = (key, factory) => {
      if (key === 'sidebar.footer.action') return () => {}
      return originalInject(key, factory)
    }
    await test('缺少某个 slot 时 apply 正常完成', () => {
      assert.doesNotThrow(() => exports.apply(ctx))
    })
  }
  //#endregion

  //#region 10) 清理
  section('10) 卸载清理')
  {
    const env = createEnv()
    const { exports } = loadBundle(env)
    const { ctx, record } = createFakeCtx()
    exports.apply(ctx)
    await settle()
    await test('注册数量符合预期（1 类型 + 3 槽位）', () => {
      assert.equal(record.tabTypes.length, 1)
      assert.equal(record.slots.length, 3)
    })
    await test('执行 effect cleanup 后注册全部撤销', () => {
      for (const effect of record.effects.slice()) effect.dispose()
      assert.equal(record.tabTypes.length, 0, 'tab 类型应被撤销')
      assert.equal(record.slots.length, 0, '槽位注册应被撤销')
    })
    await test('cleanup 幂等（重复调用不抛错）', () => {
      for (const effect of record.effects.slice()) {
        assert.doesNotThrow(() => effect.dispose())
      }
    })
  }
  //#endregion

  //#region 11) 打开链路分支（内部视图）
  section('11) 打开链路分支')
  {
    const env = createEnv()
    const { exports } = loadBundle(env)
    const { ctx, record } = createFakeCtx()
    exports.apply(ctx)
    await settle()
    await test('有会话：openChat 返回 tab 分支', () => {
      assert.equal(exports.__internals.openChat(), 'tab')
      assert.deepEqual(record.openTabCalls, [TAB_KIND])
    })
    await test('浮层开关是模块级状态', () => {
      exports.__internals.showOverlay()
      assert.equal(exports.__internals.isOverlayOpen(), true)
      exports.__internals.closeOverlay()
      assert.equal(exports.__internals.isOverlayOpen(), false)
    })
    await test('内部视图暴露包 id / kind / 兜底地址', () => {
      assert.equal(exports.__internals.pluginId, PLUGIN_ID)
      assert.equal(exports.__internals.tabKind, TAB_KIND)
      assert.equal(exports.__internals.fallbackUrl, FALLBACK_URL)
    })
  }
  //#endregion

  console.log('\n结果: ' + passed + ' 通过, ' + failures.length + ' 失败')
  if (failures.length > 0) {
    console.log('\n失败详情:')
    for (const failure of failures) console.log(' - ' + failure.name + ': ' + String(failure.error && failure.error.message))
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('\n✘ 自测异常终止')
  console.error(error)
  process.exit(1)
})
