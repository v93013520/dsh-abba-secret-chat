/**
 * AB-BA 秘密对话 — DSH 浏览器半（手写 bundle，零依赖，无 JSX，无构建）。
 *
 * 协议：`window.__ModuleLoader__.load({ id, factory })`。执行本文件只注册工厂，
 * 模块副作用（样式注入等）都在工厂物化时发生（见 dsh-client-modules）。
 *
 * 注册的东西：
 *  1) 右侧栏 tab 类型 `abba-chat`（page type：无 patterns，按 kind 打开）+ guide 入口卡片；
 *  2) 该 tab 的 body（`sidebar.right.pane.tab`，key = 本包 id）；
 *  3) 左侧栏底部入口按钮（`sidebar.footer.action`，list slot，必须带 id）；
 *  4) 全局浮层（`shell.overlay`，list slot）—— 当前没有会话、右侧栏打不开时的降级容器。
 *
 * 打开链路（三级降级）：
 *   ctx.sidebarRight.openTab('abba-chat') 成功 → 右侧栏 tab（主路径）
 *   抛错（典型：当前没有会话 surface）   → 本包自己的全局浮层
 *   连 sidebarRight 都没有（旧宿主）     → window.open(localUrl)
 */
window.__ModuleLoader__.load({
  id: 'dsh-abba-secret-chat',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // React 由平台种子表提供，绝不打进 bundle。
    const React = require('react')
    const h = React.createElement

    //#region 常量
    /** 本包名，同时是浏览器模块 id、tab 类型实现 id、列槽位 key、样式标签的 data-plugin。 */
    const PLUGIN_ID = 'dsh-abba-secret-chat'
    /** 右侧栏 page tab 的 kind（无 patterns，按 kind 打开）。 */
    const TAB_KIND = 'abba-chat'
    /** 宿主半注册的同源信息路由。 */
    const INFO_PATH = '/abba/info'
    /** 聊天页兜底地址（与 CONTRACT 3.2 的默认端口一致）。 */
    const FALLBACK_CHAT_URL = 'http://127.0.0.1:8787/'
    /** /abba/info 超时；超时即按“服务没起来”处理，避免 tab 永远转圈。 */
    const INFO_TIMEOUT_MS = 4000
    /** 样式标签选择器：宿主按 data-plugin 归属/回收样式，所以值必须是模块 id。 */
    const STYLE_SELECTOR = 'style[data-plugin="' + PLUGIN_ID + '"]'
    //#endregion

    //#region 文案：跟随 navigator.language，不依赖 locale 服务
    const COPY = {
      zh: {
        tabTitle: '秘密对话',
        toolbarTitle: 'AB-BA 秘密对话',
        entry: '秘密对话',
        entryAria: '打开 AB-BA 秘密对话',
        guideDescription: '与对方配对后的一次性密码聊天，DSH 关闭即消失',
        peerLabel: '对方链接',
        copy: '复制链接',
        copyPeer: '复制对方链接',
        copied: '已复制',
        copyFailed: '复制失败',
        openExternal: '在浏览器打开',
        refresh: '刷新聊天页',
        close: '关闭浮层',
        pending: '正在连接聊天服务…',
        offline: '聊天服务未运行；DSH 关闭后聊天会自动结束',
        overlayHint: '当前没有打开的会话，聊天页显示在这个浮层里',
        overlayTitle: '会话外浮层',
        bannerRetry: '重试',
      },
      en: {
        tabTitle: 'Secret chat',
        toolbarTitle: 'AB-BA Secret Chat',
        entry: 'Secret chat',
        entryAria: 'Open the AB-BA secret chat',
        guideDescription: 'One-off password chat paired with your peer; gone when DSH exits',
        peerLabel: 'Peer link',
        copy: 'Copy link',
        copyPeer: 'Copy peer link',
        copied: 'Copied',
        copyFailed: 'Copy failed',
        openExternal: 'Open in browser',
        refresh: 'Reload chat',
        close: 'Close overlay',
        pending: 'Connecting to the chat service…',
        offline: 'The chat service is not running; chat ends when DSH exits',
        overlayHint: 'No session is open, so the chat is shown in this overlay',
        overlayTitle: 'Out-of-session overlay',
        bannerRetry: 'Retry',
      },
    }

    /** @returns {boolean} 是否中文环境（每次读取，语言变化后重渲染即可跟随）。 */
    function isChinese() {
      try {
        var lang = typeof navigator === 'object' && navigator !== null ? navigator.language : ''
        return typeof lang === 'string' && /^zh/i.test(lang)
      } catch (error) {
        return false
      }
    }

    /**
     * 取一条文案。
     * @param {keyof typeof COPY.zh} key - 字典键。
     * @returns {string} 当前语言的文案（缺失时回退英文、再回退键名）。
     */
    function t(key) {
      var dict = isChinese() ? COPY.zh : COPY.en
      if (typeof dict[key] === 'string') return dict[key]
      if (typeof COPY.en[key] === 'string') return COPY.en[key]
      return key
    }
    //#endregion

    //#region 样式：注入一次；类名统一 abba- 前缀；颜色优先 DSH 变量并给回退
    const CSS_TEXT = [
      '.abba-tab{display:flex;flex-direction:column;flex:1 1 auto;height:100%;min-height:0;min-width:0;color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-bg-base,#fff)}',
      '.abba-toolbar{box-sizing:border-box;flex:none;display:flex;align-items:center;gap:6px;height:36px;min-width:0;padding:0 6px 0 10px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-1,#f7f8fa)}',
      '.abba-title{flex:0 1 auto;display:flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-primary,#1f2329);font:var(--dsw-font-xxs-12,12px/1.4 system-ui);font-weight:600;white-space:nowrap}',
      '.abba-titleIcon{flex:none;color:var(--dsw-alias-state-business-primary,#3370ff)}',
      '.abba-titleText{overflow:hidden;text-overflow:ellipsis}',
      '.abba-peer{flex:0 1 auto;display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:190px;height:22px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:999px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-tertiary,#86909c);font:var(--dsw-font-xxxs-11,11px/1.3 system-ui);cursor:pointer}',
      '.abba-peer:hover{color:var(--dsw-alias-label-secondary,#4e5969);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.abba-peerLabel{flex:none}',
      '.abba-peerUrl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#4e5969)}',
      '.abba-tools{flex:none;display:flex;align-items:center;gap:2px;margin-left:auto}',
      '.abba-tool{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#4e5969);cursor:pointer}',
      '.abba-tool:hover{color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.abba-tool[data-state="done"]{color:var(--dsw-alias-state-success-primary,#17a34a)}',
      '.abba-tool[data-state="failed"]{color:var(--dsw-alias-state-error-primary,#d92d20)}',
      '.abba-frame{display:block;flex:1 1 auto;width:100%;height:100%;min-height:0;border:0;background:var(--dsw-alias-bg-base,#fff)}',
      '.abba-pending{flex:1 1 auto;display:flex;align-items:center;justify-content:center;gap:8px;min-height:0;padding:16px;color:var(--dsw-alias-label-tertiary,#86909c);font:var(--dsw-font-xxs-12,12px/1.4 system-ui)}',
      '.abba-spinner{width:14px;height:14px;flex:none;border:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-top-color:var(--dsw-alias-state-business-primary,#3370ff);border-radius:50%;animation:abba-spin .9s linear infinite}',
      '@keyframes abba-spin{to{transform:rotate(360deg)}}',
      '.abba-banner{flex:none;display:flex;align-items:center;gap:8px;padding:6px 10px;border-top:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-tertiary,#86909c);font:var(--dsw-font-xxxs-11,11px/1.4 system-ui)}',
      '.abba-bannerText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.abba-linkButton{flex:none;padding:0;border:0;background:none;color:var(--dsw-alias-state-business-primary,#3370ff);font:inherit;cursor:pointer}',
      '.abba-entry{box-sizing:border-box;display:inline-flex;align-items:center;gap:8px;height:32px;max-width:100%;min-width:0;margin:0;padding:0 10px;border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-secondary,#4e5969);font:var(--dsw-font-xxs-12,12px/1.4 system-ui);cursor:pointer}',
      '.abba-entry:hover{color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.abba-entry[data-wide="true"]{width:100%}',
      '.abba-entry[data-wide="false"]{width:32px;justify-content:center;padding:0}',
      '.abba-entryIcon{flex:none;color:var(--dsw-alias-state-business-primary,#3370ff)}',
      '.abba-entryLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.abba-overlay{position:fixed;inset:0;z-index:1000;box-sizing:border-box;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(12,16,24,.36)}',
      '.abba-overlayCard{box-sizing:border-box;display:flex;flex-direction:column;width:min(720px,calc(100vw - 48px));height:min(640px,calc(100vh - 48px));min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:var(--dsw-radius-lg,12px);box-shadow:0 18px 48px rgba(0,0,0,.28)}',
      '.abba-overlayFoot{flex:none;display:flex;align-items:center;gap:10px;min-width:0;height:36px;padding:0 12px;border-top:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-1,#f7f8fa);color:var(--dsw-alias-label-tertiary,#86909c);font:var(--dsw-font-xxxs-11,11px/1.4 system-ui)}',
      '.abba-overlayFootText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '@media (prefers-reduced-motion:reduce){.abba-spinner{animation:none}}',
    ].join('')

    /** 幂等注入样式标签（宿主按 data-plugin 回收，所以这里也据此判重）。 */
    function injectStyle() {
      if (typeof document === 'undefined' || document === null) return
      try {
        if (typeof document.querySelector === 'function' && document.querySelector(STYLE_SELECTOR) !== null) return
        var tag = document.createElement('style')
        tag.setAttribute('data-plugin', PLUGIN_ID)
        tag.textContent = CSS_TEXT
        var parent = document.head !== undefined && document.head !== null ? document.head : document.body
        if (parent === undefined || parent === null || typeof parent.appendChild !== 'function') return
        parent.appendChild(tag)
      } catch (error) {
        /* 样式失败不影响功能 */
      }
    }
    //#endregion

    //#region 聊天地址 store：/abba/info → localUrl（模块级可观察）
    const chatState = {
      /** iframe 用的地址。 */
      url: FALLBACK_CHAT_URL,
      /** 展示给对方的局域网地址（lanUrls[0]），可能为空。 */
      lanUrl: '',
      /** 服务是否在跑；null = 未知（尚未拿到 info）。 */
      running: null,
      /** 是否已经完成过一次 info 读取（成功或失败）。 */
      loaded: false,
      /** 失败原因（/abba/info 的 error 或网络错误）。 */
      error: '',
      /** 实际端口。 */
      port: 8787,
      /** 宿主半版本。 */
      version: '',
    }
    /** @type {Set<() => void>} */
    const chatListeners = new Set()

    /** @returns {object} 当前状态的浅快照（供 useState 比较）。 */
    function chatSnapshot() {
      return {
        url: chatState.url,
        lanUrl: chatState.lanUrl,
        running: chatState.running,
        loaded: chatState.loaded,
        error: chatState.error,
        port: chatState.port,
        version: chatState.version,
      }
    }

    /** @param {object} patch - 要合并进状态的字段。 */
    function updateChat(patch) {
      var changed = false
      for (var key in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, key) && chatState[key] !== patch[key]) {
          chatState[key] = patch[key]
          changed = true
        }
      }
      if (!changed) return
      var listeners = Array.from(chatListeners)
      for (var index = 0; index < listeners.length; index += 1) {
        try {
          listeners[index]()
        } catch (error) {
          /* 单个订阅者失败不影响其它渲染 */
        }
      }
    }

    /**
     * 订阅聊天地址变化。
     * @param {() => void} listener - 变化回调。
     * @returns {() => void} 取消订阅。
     */
    function subscribeChat(listener) {
      chatListeners.add(listener)
      return function () {
        chatListeners.delete(listener)
      }
    }

    /** @param {unknown} error - 任意错误值。 @returns {string} 可读文本。 */
    function describeError(error) {
      if (error instanceof Error && typeof error.message === 'string') return error.message
      if (typeof error === 'string') return error
      try {
        return String(error)
      } catch (nested) {
        return 'unknown error'
      }
    }

    /** @param {object|null} info - /abba/info 载荷。 @returns {string} iframe 地址。 */
    function localUrlFrom(info) {
      if (info !== null && typeof info === 'object' && typeof info.localUrl === 'string' && /^https?:\/\//i.test(info.localUrl)) return info.localUrl
      var port = info !== null && typeof info === 'object' && typeof info.port === 'number' && info.port > 0 ? info.port : 8787
      return 'http://127.0.0.1:' + port + '/'
    }

    /**
     * 读一次 /abba/info（同源相对路径）。
     * @returns {Promise<object>} 解析后的 JSON。
     */
    function fetchInfo() {
      if (typeof fetch !== 'function') return Promise.reject(new Error('fetch is unavailable'))
      var controller = typeof AbortController === 'function' ? new AbortController() : null
      var timer = null
      if (controller !== null) {
        timer = setTimeout(function () {
          try {
            controller.abort()
          } catch (error) {
            /* 已结束 */
          }
        }, INFO_TIMEOUT_MS)
      }
      var options = { cache: 'no-store', headers: { accept: 'application/json' } }
      if (controller !== null) options.signal = controller.signal
      var pending
      try {
        pending = fetch(INFO_PATH, options)
      } catch (error) {
        pending = Promise.reject(error)
      }
      return Promise.resolve(pending)
        .then(function (response) {
          if (response === null || response === undefined) throw new Error('empty response')
          if (response.ok === false) throw new Error('HTTP ' + String(response.status))
          if (typeof response.json !== 'function') throw new Error('invalid response body')
          return response.json()
        })
        .then(function (info) {
          if (info === null || typeof info !== 'object') throw new Error('invalid /abba/info payload')
          return info
        })
        .finally(function () {
          if (timer !== null) clearTimeout(timer)
        })
    }

    let infoInFlight = null
    let infoLoaded = false

    /**
     * 保证聊天地址已解析（去重 + 缓存；force 时重新读）。
     * @param {boolean} [force] - 忽略缓存重读。
     * @returns {Promise<object>} 状态快照。
     */
    function ensureChatInfo(force) {
      if (infoInFlight !== null) return infoInFlight
      if (infoLoaded === true && force !== true) return Promise.resolve(chatSnapshot())
      infoInFlight = fetchInfo()
        .then(function (info) {
          var lanUrls = Array.isArray(info.lanUrls)
            ? info.lanUrls.filter(function (candidate) {
                return typeof candidate === 'string' && candidate.length > 0
              })
            : []
          infoLoaded = true
          updateChat({
            url: localUrlFrom(info),
            lanUrl: lanUrls.length > 0 ? lanUrls[0] : '',
            running: info.running !== false,
            port: typeof info.port === 'number' && info.port > 0 ? info.port : 8787,
            version: typeof info.version === 'string' ? info.version : '',
            error: typeof info.error === 'string' ? info.error : '',
            loaded: true,
          })
          return chatSnapshot()
        })
        .catch(function (error) {
          infoLoaded = true
          updateChat({
            url: chatState.loaded === true ? chatState.url : FALLBACK_CHAT_URL,
            lanUrl: chatState.loaded === true ? chatState.lanUrl : '',
            running: false,
            error: describeError(error),
            loaded: true,
          })
          return chatSnapshot()
        })
        .finally(function () {
          infoInFlight = null
        })
      return infoInFlight
    }

    /** 订阅聊天地址的 React 钩子。 @returns {object} 状态快照。 */
    function useChatState() {
      var pair = React.useState(chatSnapshot)
      var snapshot = pair[0]
      var setSnapshot = pair[1]
      React.useEffect(function () {
        function sync() {
          setSnapshot(chatSnapshot())
        }
        sync()
        return subscribeChat(sync)
      }, [])
      return snapshot
    }
    //#endregion

    //#region 浮层 store：没有会话时承载聊天页（shell.overlay，root 级 list slot）
    const overlayState = {
      open: false,
      /** 打开浮层时用过的 URL（仅供状态展示；iframe 用 live 的 chatState.url）。 */
      reason: '',
    }
    /** @type {Set<() => void>} */
    const overlayListeners = new Set()
    /** Esc 关浮层的全局监听是否已挂上（挂一次、关时摘掉，不依赖 React 生命周期）。 */
    let escListenerAttached = false

    /** @param {KeyboardEvent} event - 键盘事件。 */
    function onOverlayKeyDown(event) {
      if (event !== null && event !== undefined && (event.key === 'Escape' || event.key === 'Esc')) closeOverlay()
    }

    /** 浮层打开时挂上 Esc 监听（幂等）。 */
    function attachEscListener() {
      if (escListenerAttached) return
      try {
        if (typeof window !== 'undefined' && window !== null && typeof window.addEventListener === 'function') {
          window.addEventListener('keydown', onOverlayKeyDown)
          escListenerAttached = true
        }
      } catch (error) {
        /* 无 window（SSR/测试） */
      }
    }

    /** 浮层关闭时摘掉 Esc 监听（幂等）。 */
    function detachEscListener() {
      if (!escListenerAttached) return
      escListenerAttached = false
      try {
        if (typeof window !== 'undefined' && window !== null && typeof window.removeEventListener === 'function') {
          window.removeEventListener('keydown', onOverlayKeyDown)
        }
      } catch (error) {
        /* 无 window */
      }
    }

    /** @param {boolean} open - 目标显隐。 */
    function setOverlayOpen(open) {
      var next = open === true
      if (overlayState.open === next) return
      overlayState.open = next
      if (next) attachEscListener()
      else detachEscListener()
      var listeners = Array.from(overlayListeners)
      for (var index = 0; index < listeners.length; index += 1) {
        try {
          listeners[index]()
        } catch (error) {
          /* 订阅者隔离 */
        }
      }
    }

    /** @param {() => void} listener - 变化回调。 @returns {() => void} 取消订阅。 */
    function subscribeOverlay(listener) {
      overlayListeners.add(listener)
      return function () {
        overlayListeners.delete(listener)
      }
    }

    /** 打开浮层（通常是“当前没有会话”的降级）。 */
    function showOverlay() {
      setOverlayOpen(true)
      void ensureChatInfo()
    }

    /** 关闭浮层。 */
    function closeOverlay() {
      setOverlayOpen(false)
    }

    /** 浮层显隐的 React 钩子。 @returns {boolean} 是否打开。 */
    function useOverlayOpen() {
      var pair = React.useState(overlayState.open)
      var open = pair[0]
      var setOpen = pair[1]
      React.useEffect(function () {
        function sync() {
          setOpen(overlayState.open)
        }
        sync()
        return subscribeOverlay(sync)
      }, [])
      return open
    }
    //#endregion

    //#region 宿主动作：打开聊天、外部浏览器、剪贴板
    /** apply 时绑定的宿主 ctx（组件在渲染期通过闭包拿不到 ctx）。 */
    let pluginCtx = null
    /** 解析过一次的 sidebarRight（兼容 ctx.get 与旧宿主）。 */
    let sidebarRightRef = null
    /** shell.overlay 是否已注册成功（决定“打不开右侧栏”时能否降级到浮层）。 */
    let overlayRegistered = false

    /** @returns {object|null} 可用的 sidebarRight（openTab 为函数），否则 null。 */
    function resolveSidebarRight() {
      if (sidebarRightRef !== null && typeof sidebarRightRef.openTab === 'function') return sidebarRightRef
      if (pluginCtx === null) return null
      var candidate = pluginCtx.sidebarRight
      if (candidate !== null && candidate !== undefined && typeof candidate.openTab === 'function') {
        sidebarRightRef = candidate
        return candidate
      }
      try {
        if (typeof pluginCtx.get === 'function') {
          var viaGet = pluginCtx.get('sidebarRight')
          if (viaGet !== null && viaGet !== undefined && typeof viaGet.openTab === 'function') {
            sidebarRightRef = viaGet
            return viaGet
          }
        }
      } catch (error) {
        /* 旧宿主没有 ctx.get */
      }
      return null
    }

    /**
     * 用系统/外部浏览器打开聊天页。
     * @param {string} url - 目标地址。
     * @returns {boolean} 是否发起了打开动作。
     */
    function openChatUrl(url) {
      var target = typeof url === 'string' && url.length > 0 ? url : chatState.url
      try {
        if (typeof window !== 'undefined' && window !== null && typeof window.open === 'function') {
          window.open(target, '_blank', 'noopener,noreferrer')
          return true
        }
      } catch (error) {
        /* 弹窗被拦截 */
      }
      return false
    }

    /** 关掉浏览器自己的兜底（window.open 失败时的最后一步）。 */
    function fallbackOpenExternal() {
      openChatUrl(chatState.url)
    }

    /**
     * 入口按钮的点击行为：右侧栏 tab → 浮层 → 外部浏览器，逐级降级。
     * 任何一级的异常都在这里吞掉，绝不冒泡成未捕获错误。
     * @returns {'tab'|'overlay'|'external'} 实际走到的分支（测试用）。
     */
    function openChat() {
      void ensureChatInfo()
      var sidebarRight = resolveSidebarRight()
      if (sidebarRight === null) {
        fallbackOpenExternal()
        return 'external'
      }
      try {
        sidebarRight.openTab(TAB_KIND)
        return 'tab'
      } catch (error) {
        /* 典型原因：当前没有会话 surface —— sidebarRight 文档明确会 throw */
      }
      if (overlayRegistered === true) {
        showOverlay()
        return 'overlay'
      }
      fallbackOpenExternal()
      return 'external'
    }

    /** 复制文本到剪贴板（Clipboard API 优先，退化到 execCommand）。 @param {string} text - 文本。 @returns {Promise<boolean>} 是否成功。 */
    function copyText(text) {
      var value = typeof text === 'string' ? text : ''
      if (value.length === 0) return Promise.resolve(false)
      var clipboard = null
      try {
        clipboard = typeof navigator === 'object' && navigator !== null ? navigator.clipboard : null
      } catch (error) {
        clipboard = null
      }
      if (clipboard !== null && clipboard !== undefined && typeof clipboard.writeText === 'function') {
        try {
          return Promise.resolve(clipboard.writeText(value)).then(
            function () {
              return true
            },
            function () {
              return legacyCopy(value)
            },
          )
        } catch (error) {
          return Promise.resolve(legacyCopy(value))
        }
      }
      return Promise.resolve(legacyCopy(value))
    }

    /** @param {string} value - 文本。 @returns {boolean} execCommand 是否成功。 */
    function legacyCopy(value) {
      try {
        if (typeof document === 'undefined' || document === null || typeof document.createElement !== 'function') return false
        var area = document.createElement('textarea')
        area.value = value
        area.setAttribute('readonly', 'readonly')
        if (area.style !== undefined && area.style !== null) {
          area.style.position = 'fixed'
          area.style.top = '-1000px'
          area.style.opacity = '0'
        }
        var parent = document.body !== undefined && document.body !== null ? document.body : document.head
        if (parent === undefined || parent === null || typeof parent.appendChild !== 'function') return false
        parent.appendChild(area)
        if (typeof area.select === 'function') area.select()
        var ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
        if (typeof area.remove === 'function') area.remove()
        return ok === true
      } catch (error) {
        return false
      }
    }

    /** 复制反馈状态（'' | 'copied' | 'failed'）。 @returns {[string, (text: string) => void]} */
    function useCopyFeedback() {
      var pair = React.useState('')
      var feedback = pair[0]
      var setFeedback = pair[1]
      var timerRef = React.useRef(null)
      React.useEffect(function () {
        return function () {
          if (timerRef.current !== null) {
            clearTimeout(timerRef.current)
            timerRef.current = null
          }
        }
      }, [])
      function copy(text) {
        void copyText(text).then(function (ok) {
          setFeedback(ok ? 'copied' : 'failed')
          if (timerRef.current !== null) clearTimeout(timerRef.current)
          timerRef.current = setTimeout(function () {
            timerRef.current = null
            setFeedback('')
          }, 1500)
        })
      }
      return [feedback, copy]
    }
    //#endregion

    //#region 图形（内联 SVG，currentColor，不依赖 primitives 图标集）
    /** @param {object} props - { size, className }。 @returns {object} React 元素。 */
    function IconLock(props) {
      var size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          className: props !== null && props !== undefined ? props.className : undefined,
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M5.1 7V5.6a2.9 2.9 0 0 1 5.8 0V7',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('rect', { x: 3.2, y: 7, width: 9.6, height: 6.8, rx: 1.8, fill: 'currentColor' }),
      )
    }

    /** @param {object} props - { size, className }。 @returns {object} React 元素。 */
    function IconCopy(props) {
      var size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          className: props !== null && props !== undefined ? props.className : undefined,
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', { x: 5.6, y: 5.6, width: 7.4, height: 7.4, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', {
          d: 'M10.4 3.9A1.5 1.5 0 0 0 8.9 2.4H4.5A1.5 1.5 0 0 0 3 3.9v4.4a1.5 1.5 0 0 0 1.5 1.5',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
      )
    }

    /** @param {object} props - { size, className }。 @returns {object} React 元素。 */
    function IconCheck(props) {
      var size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          className: props !== null && props !== undefined ? props.className : undefined,
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M3.2 8.6 6.4 11.8 12.8 4.8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    /** @param {object} props - { size, className }。 @returns {object} React 元素。 */
    function IconExternal(props) {
      var size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          className: props !== null && props !== undefined ? props.className : undefined,
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M9.2 2.8h4v4M13.2 2.8 7.6 8.4',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M12.4 9.6v2.9a1.5 1.5 0 0 1-1.5 1.5H3.5A1.5 1.5 0 0 1 2 12.5V5.1a1.5 1.5 0 0 1 1.5-1.5h2.9',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
      )
    }

    /** @param {object} props - { size, className }。 @returns {object} React 元素。 */
    function IconRefresh(props) {
      var size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          className: props !== null && props !== undefined ? props.className : undefined,
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M13 8a5 5 0 1 1-1.6-3.7',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M13.2 2.6v3.2H10',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** @param {object} props - { size, className }。 @returns {object} React 元素。 */
    function IconClose(props) {
      var size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          className: props !== null && props !== undefined ? props.className : undefined,
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      )
    }
    //#endregion

    //#region 组件
    /** @param {string} url - 地址。 @returns {string} 去掉协议与尾部斜杠的紧凑显示。 */
    function shortUrl(url) {
      if (typeof url !== 'string' || url.length === 0) return ''
      return url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
    }

    /**
     * 复制按钮（带短暂的 copied/failed 反馈）。
     * `chip` 为真时渲染成工具条里的“对方链接”胶囊。
     * @param {object} props - { text, label, action, chip }。
     * @returns {object} React 元素。
     */
    function AbbaCopyButton(props) {
      var pair = useCopyFeedback()
      var feedback = pair[0]
      var copy = pair[1]
      var label = feedback === 'copied' ? t('copied') : feedback === 'failed' ? t('copyFailed') : props.label
      var stateAttr = feedback === '' ? undefined : feedback === 'copied' ? 'done' : 'failed'
      var text = typeof props.text === 'string' ? props.text : ''
      if (props.chip === true) {
        return h(
          'button',
          {
            type: 'button',
            className: 'abba-peer',
            title: label,
            'aria-label': label,
            'data-abba-action': props.action,
            'data-state': stateAttr,
            onClick: function () {
              copy(text)
            },
          },
          h('span', { className: 'abba-peerLabel' }, t('peerLabel')),
          h('span', { className: 'abba-peerUrl' }, feedback === '' ? shortUrl(text) : label),
        )
      }
      return h(
        'button',
        {
          type: 'button',
          className: 'abba-tool',
          title: label,
          'aria-label': label,
          'data-abba-action': props.action,
          'data-state': stateAttr,
          onClick: function () {
            copy(text)
          },
        },
        feedback === 'copied' ? h(IconCheck, { size: 16 }) : h(IconCopy, { size: 16 }),
      )
    }

    /** @param {object} props - { className, children }。 @returns {object} React 元素。 */
    function AbbaIconButton(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'abba-tool',
          title: props.label,
          'aria-label': props.label,
          'data-abba-action': props.action,
          onClick: props.onClick,
        },
        props.children,
      )
    }

    /**
     * 36px 工具条：标题 + 对方链接（点击复制）+ 复制 / 在浏览器打开 / 刷新 / 关闭。
     * @param {object} props - { state, onRefresh, onClose }。
     * @returns {object} React 元素。
     */
    function AbbaToolbar(props) {
      var state = props.state
      var peerText = state.lanUrl !== '' ? state.lanUrl : state.url
      return h(
        'div',
        { className: 'abba-toolbar', 'data-abba-toolbar': '' },
        h(
          'span',
          { className: 'abba-title' },
          h(IconLock, { size: 14, className: 'abba-titleIcon' }),
          h('span', { className: 'abba-titleText' }, t('toolbarTitle')),
        ),
        peerText !== ''
          ? h(AbbaCopyButton, {
              chip: true,
              text: peerText,
              action: 'copy-peer',
              label: t('copyPeer'),
            })
          : null,
        h(
          'span',
          { className: 'abba-tools' },
          h(AbbaCopyButton, { text: peerText, action: 'copy', label: t('copy') }),
          h(
            AbbaIconButton,
            {
              label: t('openExternal'),
              action: 'open-external',
              onClick: function () {
                openChatUrl(state.url)
              },
            },
            h(IconExternal, { size: 16 }),
          ),
          typeof props.onRefresh === 'function'
            ? h(
                AbbaIconButton,
                {
                  label: t('refresh'),
                  action: 'refresh',
                  onClick: props.onRefresh,
                },
                h(IconRefresh, { size: 16 }),
              )
            : null,
          typeof props.onClose === 'function'
            ? h(
                AbbaIconButton,
                {
                  label: t('close'),
                  action: 'close',
                  onClick: props.onClose,
                },
                h(IconClose, { size: 16 }),
              )
            : null,
        ),
      )
    }

    /**
     * 聊天页 iframe（占满剩余高度；reload 变化时通过 key 重挂载强制刷新）。
     * @param {object} props - { src, reload }。
     * @returns {object} React 元素。
     */
    function AbbaChatFrame(props) {
      return h('iframe', {
        key: 'abba-frame-' + String(props.reload || 0),
        className: 'abba-frame',
        src: props.src,
        title: t('toolbarTitle'),
        'data-abba-frame': '',
        // display-capture：v0.2.0 的「截屏」按钮需要在 iframe 内调 getDisplayMedia；
        // 缺这个 allow 时浏览器会直接拒绝（DSH 桌面端仍可能由宿主策略拦截，页面会给出退路提示）。
        allow: 'clipboard-read; clipboard-write; display-capture',
        referrerPolicy: 'no-referrer',
      })
    }

    /** @returns {object} React 元素。 */
    function AbbaPending() {
      return h('div', { className: 'abba-pending', role: 'status' }, h('span', { className: 'abba-spinner' }), h('span', null, t('pending')))
    }

    /** 右侧栏 tab body：工具条 + iframe。 @returns {object} React 元素。 */
    function AbbaChatTab() {
      var state = useChatState()
      var reloadPair = React.useState(0)
      var reload = reloadPair[0]
      var setReload = reloadPair[1]
      React.useEffect(function () {
        void ensureChatInfo()
      }, [])
      function refresh() {
        void ensureChatInfo(true)
        setReload(function (value) {
          return value + 1
        })
      }
      return h(
        'div',
        { className: 'abba-tab', 'data-abba-tab': '' },
        h(AbbaToolbar, {
          state: state,
          onRefresh: refresh,
        }),
        state.loaded === true
          ? h(AbbaChatFrame, { src: state.url, reload: reload })
          : h(AbbaPending, null),
        state.loaded === true && state.running === false
          ? h(
              'div',
              { className: 'abba-banner', role: 'status' },
              h('span', { className: 'abba-bannerText' }, t('offline') + (state.error !== '' ? ' · ' + state.error : '')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'abba-linkButton',
                  'data-abba-action': 'retry',
                  onClick: refresh,
                },
                t('bannerRetry'),
              ),
            )
          : null,
      )
    }

    /**
     * 左侧栏底部入口按钮。
     * 刻意不含 hooks：测试可以直接调用本函数拿到元素并触发 onClick。
     * @param {object} props - { wide }。
     * @returns {object} React 元素。
     */
    function AbbaEntryButton(props) {
      var wide = props !== null && props !== undefined && props.wide === true
      return h(
        'button',
        {
          type: 'button',
          className: 'abba-entry',
          title: t('entryAria'),
          'aria-label': t('entryAria'),
          'data-abba-entry': '',
          'data-wide': wide ? 'true' : 'false',
          onClick: function () {
            openChat()
          },
        },
        h(IconLock, { size: 16, className: 'abba-entryIcon' }),
        wide ? h('span', { className: 'abba-entryLabel' }, t('entry')) : null,
      )
    }

    /** 全局浮层：没有会话时承载同一个聊天页。 @returns {object|null} React 元素。 */
    function AbbaOverlay() {
      var open = useOverlayOpen()
      var state = useChatState()
      var reloadPair = React.useState(0)
      var reload = reloadPair[0]
      var setReload = reloadPair[1]
      React.useEffect(
        function () {
          if (open !== true) return undefined
          void ensureChatInfo()
          return undefined
        },
        [open],
      )
      if (open !== true) return null
      function refresh() {
        void ensureChatInfo(true)
        setReload(function (value) {
          return value + 1
        })
      }
      return h(
        'div',
        {
          className: 'abba-overlay',
          'data-abba-overlay': '',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('toolbarTitle'),
          onClick: function () {
            closeOverlay()
          },
        },
        h(
          'div',
          {
            className: 'abba-overlayCard',
            'data-abba-overlay-card': '',
            onClick: function (event) {
              if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation()
            },
          },
          h(AbbaToolbar, { state: state, onRefresh: refresh, onClose: closeOverlay }),
          state.loaded === true
            ? h(AbbaChatFrame, { src: state.url, reload: reload })
            : h(AbbaPending, null),
          h(
            'div',
            { className: 'abba-overlayFoot' },
            h('span', { className: 'abba-overlayFootText' }, t('overlayHint')),
            h(
              'button',
              {
                type: 'button',
                className: 'abba-linkButton',
                'data-abba-action': 'overlay-open-external',
                onClick: function () {
                  openChatUrl(state.url)
                },
              },
              t('openExternal'),
            ),
          ),
        ),
      )
    }
    //#endregion

    //#region 插件导出
    /** 必需服务（CONTRACT 3.5）。 */
    const inject = ['slots', 'sidebarRight', 'sidebarRightTabs']

    /**
     * 注册 tab 类型、tab body、侧栏入口、全局浮层。
     * @param {object} ctx - 浏览器客户端 ctx。
     */
    function apply(ctx) {
      pluginCtx = ctx
      sidebarRightRef = null
      injectStyle()

      // 1) tab 类型（page type：无 patterns，按 kind 打开；page tab 会按 kind 去重聚焦）。
      if (ctx.sidebarRightTabs !== null && ctx.sidebarRightTabs !== undefined && typeof ctx.sidebarRightTabs.register === 'function') {
        ctx.effect(
          function () {
            return ctx.sidebarRightTabs.register({
              id: PLUGIN_ID,
              kind: TAB_KIND,
              // 聊天页 = 一个 iframe；切走再切回不应重载，否则会丢掉已配对的会话。
              keepMounted: true,
              title: function () {
                return t('tabTitle')
              },
              guide: [
                {
                  id: TAB_KIND,
                  order: 40,
                  title: function () {
                    return t('tabTitle')
                  },
                  description: function () {
                    return t('guideDescription')
                  },
                },
              ],
            })
          },
          'abba: tab type',
        )
      }

      // 2) tab body（keyed slot：key = 类型 id）。
      ctx.effect(
        function () {
          return ctx.slots.inject('sidebar.right.pane.tab', function () {
            return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PLUGIN_ID }, AbbaChatTab)
          })
        },
        'abba: tab body',
      )

      // 3) 左侧栏底部入口（list slot：必须带 id 与 order）。
      ctx.effect(
        function () {
          return ctx.slots.inject('sidebar.footer.action', function () {
            return ctx.slots.register({ name: 'sidebar.footer.action', id: PLUGIN_ID, order: 60 }, AbbaEntryButton)
          })
        },
        'abba: footer button',
      )

      // 4) 全局浮层（root 级 list slot：没有会话时聊天页还能显示）。
      ctx.effect(
        function () {
          return ctx.slots.inject('shell.overlay', function () {
            overlayRegistered = true
            return ctx.slots.register({ name: 'shell.overlay', id: PLUGIN_ID, order: 60 }, AbbaOverlay)
          })
        },
        'abba: overlay',
      )

      // 先把 /abba/info 读起来，打开时就不用等（失败会自行回落到默认地址）。
      void ensureChatInfo()
    }

    exports.name = 'abba-secret-chat'
    exports.inject = inject
    exports.apply = apply
    /**
     * 离线自测（test/client-harness.mjs）用的最小内部视图。
     * 宿主只读 name/inject/apply，未知导出会被忽略；这里刻意保持只读、无副作用。
     */
    exports.__internals = {
      pluginId: PLUGIN_ID,
      tabKind: TAB_KIND,
      fallbackUrl: FALLBACK_CHAT_URL,
      openChat: openChat,
      showOverlay: showOverlay,
      closeOverlay: closeOverlay,
      openUrl: openChatUrl,
      isOverlayOpen: function () {
        return overlayState.open
      },
      chatUrl: function () {
        return chatState.url
      },
      chatLoaded: function () {
        return chatState.loaded === true
      },
    }
    return module.exports
    //#endregion
  },
})
