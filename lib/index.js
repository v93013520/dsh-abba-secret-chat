/**
 * AB-BA 秘密对话 · DSH 宿主半
 *
 * 一个 Cordis 插件：启动内嵌聊天服务（默认 0.0.0.0:8787），把 `GET /abba/info`
 * 注册到 DSH 的 webserver，并在有命令面时注册 `/abba` 人类命令。
 *
 * 契约（不得单方面改动）：CONTRACT.md 第 3 节。
 *  - `GET /abba/info` → `{ ok, running, port, localUrl, lanUrls, version, startedAt? , error? }`
 *  - 端口被占用时依次尝试 port+1 … port+9，再失败用 `port: 0` 由系统分配；
 *  - 启动失败只 `warn` 不 `throw`（插件加载失败会让整个 DSH 退出）；
 *  - 服务生命周期挂在 `ctx.effect` 上：DSH 进程退出 / 插件卸载 → 聊天服务关闭。
 *
 * @module dsh-abba-secret-chat
 */
import { readFileSync } from 'node:fs';
import { startChatServer, stopChatServer, lanAddresses } from './server.js';

export const name = 'abba-secret-chat';

/** `webServer` 是硬依赖：没有它就没有 /abba/info 的注册位置。 */
export const inject = ['webServer'];

const DEFAULT_PORT = 8787;
const PORT_FALLBACK_TRIES = 9; // port+1 … port+9
const INFO_ROUTE = '/abba/info';
const SIDEBAR_HINT = '点击左侧栏底部的「秘密对话」按钮，聊天页会出现在右侧栏。';

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.1.0';
  } catch (_) {
    return '0.1.0';
  }
}

const VERSION = readVersion();

function normalizePort(value, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return fallback;
  return n;
}

function normalizeHost(value) {
  if (typeof value !== 'string') return '0.0.0.0';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '0.0.0.0';
}

function isWildcardHost(host) {
  return host === '0.0.0.0' || host === '::' || host === '';
}

function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  return {
    port: normalizePort(config.port, DEFAULT_PORT),
    host: normalizeHost(config.host),
    waitTimeoutMs: Number.isFinite(Number(config.waitTimeoutMs)) && Number(config.waitTimeoutMs) >= 0
      ? Number(config.waitTimeoutMs)
      : undefined,
    indexHtmlPath: typeof config.indexHtmlPath === 'string' ? config.indexHtmlPath : undefined,
  };
}

/** 候选端口：首选、port+1 … port+9，最后交给系统分配（0）。 */
function candidatePorts(preferred) {
  if (preferred === 0) return [0];
  const out = [];
  for (let i = 0; i <= PORT_FALLBACK_TRIES; i += 1) {
    const port = preferred + i;
    if (port >= 1 && port <= 65535) out.push(port);
  }
  out.push(0);
  return out;
}

function describeError(err) {
  if (!err) return '未知错误。';
  const code = typeof err.code === 'string' ? err.code : '';
  if (code === 'EADDRINUSE') return '端口被占用，且备用端口与系统分配端口均不可用。';
  if (code === 'EACCES') return '没有权限绑定端口。';
  return typeof err.message === 'string' && err.message.length > 0 ? err.message : String(err);
}

function buildLanUrls(host, port) {
  if (!isWildcardHost(host)) {
    // 只绑 127.0.0.1 时局域网本不可达，不展示误导性的地址。
    return [];
  }
  return lanAddresses().map((ip) => `http://${ip}:${port}/`);
}

/**
 * Host plugin entry point. Never throws: a failed chat-server start is
 * reported through `/abba/info` (`running:false`, `error`) and the logger,
 * because a rejected plugin load takes the whole DSH process down.
 *
 * @param {any} ctx Cordis plugin context carrying `webServer` and — usually — `commands`.
 * @param {object} [config] `{ port?, host?, waitTimeoutMs?, indexHtmlPath? }`.
 */
export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);

  const state = {
    /** @type {import('node:http').Server | null} */
    server: null,
    actualPort: 0,
    preferredPort: cfg.port,
    startedAt: 0,
    error: undefined,
  };

  let disposed = false;
  let opSeq = 0;

  const log = (level, message) => {
    try {
      const logger = ctx.logger;
      if (logger && typeof logger[level] === 'function') {
        logger[level](message);
        return;
      }
    } catch (_) { /* 日志永远不能影响业务 */ }
    try {
      if (level === 'warn' || level === 'error') console.warn(message);
    } catch (_) { /* ignore */ }
  };

  const isRunning = () => state.server !== null && state.server.listening === true;

  const currentPort = () => (isRunning() ? state.actualPort : state.preferredPort);
  const localUrl = () => `http://127.0.0.1:${currentPort()}/`;

  const info = () => {
    const running = isRunning();
    const port = currentPort();
    const base = {
      ok: true,
      running,
      port,
      localUrl: `http://127.0.0.1:${port}/`,
      lanUrls: running ? buildLanUrls(cfg.host, port) : [],
      version: VERSION,
    };
    if (running) return { ...base, startedAt: state.startedAt };
    return { ...base, error: state.error || '聊天服务尚未启动。' };
  };

  /** 关闭当前服务（不改变 preferredPort）。 */
  const closeCurrent = async () => {
    const server = state.server;
    state.server = null;
    state.actualPort = 0;
    state.startedAt = 0;
    if (server) {
      try {
        await stopChatServer(server);
      } catch (_) { /* 关停失败不影响后续启动 */ }
    }
  };

  /** 停止服务；之后 `/abba/info` 报 running:false。 */
  const stop = async () => {
    opSeq += 1;
    await closeCurrent();
    state.error = '聊天服务已停止。';
    log('info', 'abba-secret-chat: chat server stopped');
  };

  /**
   * 启动服务（先停旧的）。端口回退策略见 CONTRACT 3.2。
   * @returns {Promise<boolean>} 是否启动成功。
   */
  const start = async (preferredPort) => {
    const seq = (opSeq += 1);
    state.preferredPort = preferredPort;
    await closeCurrent();
    if (disposed || seq !== opSeq) return false;

    const options = {
      host: cfg.host,
      waitTimeoutMs: cfg.waitTimeoutMs,
      indexHtmlPath: cfg.indexHtmlPath,
    };

    let lastError;
    for (const port of candidatePorts(preferredPort)) {
      if (disposed || seq !== opSeq) return false;
      try {
        const server = await startChatServer(port, options);
        if (disposed || seq !== opSeq) {
          await stopChatServer(server);
          return false;
        }
        const address = server.address();
        state.server = server;
        state.actualPort = address && typeof address === 'object' ? address.port : port;
        state.startedAt = Date.now();
        state.error = undefined;
        const urls = buildLanUrls(cfg.host, state.actualPort);
        log(
          'info',
          `abba-secret-chat: chat server listening on http://127.0.0.1:${state.actualPort}/` +
            (urls.length > 0 ? ` (LAN: ${urls.join(', ')})` : ''),
        );
        return true;
      } catch (err) {
        lastError = err;
        if (err && err.code === 'EADDRINUSE') continue;
        break;
      }
    }

    state.error = describeError(lastError);
    log('warn', `abba-secret-chat: chat server failed to start (${state.error})`);
    return false;
  };

  // ---- 聊天服务生命周期：随插件卸载 / DSH 退出一起关闭 ----
  ctx.effect(() => {
    disposed = false;
    void start(cfg.port).catch((err) => {
      state.error = describeError(err);
      log('warn', `abba-secret-chat: chat server failed to start (${state.error})`);
    });
    return () => {
      disposed = true;
      return stop();
    };
  }, 'abba: chat server lifecycle');

  // ---- DSH 路由 GET /abba/info ----
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    const handleInfo = (req, res) => {
      try {
        const method = req.method || 'GET';
        if (method !== 'GET' && method !== 'HEAD') {
          const body = JSON.stringify({ ok: false, error: 'Method Not Allowed' });
          res.writeHead(405, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            Allow: 'GET, HEAD',
            'Content-Length': Buffer.byteLength(body),
          });
          res.end(body);
          return;
        }
        const body = JSON.stringify(info());
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(method === 'HEAD' ? undefined : body);
      } catch (err) {
        try {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: false, error: '内部错误。' }));
          } else {
            res.end();
          }
        } catch (_) { /* ignore */ }
      }
    };
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: INFO_ROUTE, handler: handleInfo }),
      'abba: /abba/info route',
    );
  } else {
    log('warn', 'abba-secret-chat: no webServer service, GET /abba/info not registered');
  }

  // ---- 人类命令 /abba（可选增强：命令面存在才注册） ----
  const registerCommand = (commandCtx) => {
    const commands = commandCtx.commands;
    if (!commands || typeof commands.register !== 'function') return;

    const statusText = () => {
      const running = isRunning();
      const lines = [`AB-BA 秘密对话：${running ? '运行中' : '未运行'}`, `本机地址：${localUrl()}`];
      if (running) {
        const lan = buildLanUrls(cfg.host, state.actualPort);
        lines.push(`局域网地址：${lan.length > 0 ? lan.join('，') : '（无 —— 服务仅绑定本机地址）'}`);
        lines.push(SIDEBAR_HINT);
      } else {
        lines.push(`原因：${state.error || '聊天服务尚未启动。'}`);
        lines.push(`重新启动：/abba ${state.preferredPort || DEFAULT_PORT}`);
      }
      return lines.join('\n');
    };

    const handler = async ({ rawInput } = {}) => {
      const arg = String(rawInput ?? '').trim();
      const lower = arg.toLowerCase();

      if (arg === '' || lower === 'status') {
        return { kind: 'success', text: statusText() };
      }

      if (lower === 'stop') {
        await stop();
        return { kind: 'success', text: 'AB-BA 秘密对话服务已停止，聊天页不再可用。' };
      }

      if (lower === 'start' || lower === 'restart') {
        const ok = await start(state.preferredPort || DEFAULT_PORT);
        if (!ok) return { kind: 'error', text: `无法启动聊天服务：${state.error}` };
        return { kind: 'success', text: `AB-BA 秘密对话服务已启动。\n${statusText()}` };
      }

      if (/^\d{1,5}$/.test(arg)) {
        const port = Number(arg);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return { kind: 'error', text: `端口号无效：${arg}（应为 1-65535 的整数）。` };
        }
        const ok = await start(port);
        if (!ok) return { kind: 'error', text: `无法在端口 ${port} 启动聊天服务：${state.error}` };
        return { kind: 'success', text: `已按要求重启 AB-BA 秘密对话服务。\n${statusText()}` };
      }

      return {
        kind: 'error',
        text: '用法：/abba [status|stop|端口号]\n' +
          '  /abba            查看状态与本机/局域网地址\n' +
          '  /abba status     同上\n' +
          '  /abba stop       停止聊天服务\n' +
          '  /abba 9000       停止旧服务并以 9000 端口重启',
      };
    };

    commandCtx.effect(
      () =>
        commands.register({
          name: 'abba',
          description: '打开 AB-BA 秘密对话（右侧栏聊天）',
          input: { hint: '[status|stop|端口号]' },
          handler,
        }),
      'abba: /abba command',
    );
  };

  try {
    if (typeof ctx.inject === 'function') {
      // 命令面属于可选增强：服务缺席时插件仍然完整可用。
      ctx.inject(['commands'], (commandCtx) => registerCommand(commandCtx));
    } else if (ctx.commands) {
      registerCommand(ctx);
    }
  } catch (err) {
    log('warn', `abba-secret-chat: /abba command not registered (${describeError(err)})`);
  }
}
