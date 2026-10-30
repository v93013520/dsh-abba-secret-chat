#!/usr/bin/env node
/**
 * AB-BA 秘密对话 · 一次性双人文字聊天 —— 内嵌服务器（ESM 移植）
 *
 * 移植自 `password-chat/server.js`（同一聊天语义，逐行对照）。零依赖，Node.js >= 18。
 *
 * 设计原则（与源实现一致）：
 *   - 房间与连接只存在于内存，进程退出即全部消失，磁盘上不写任何东西；
 *   - 聊天消息只做转发（A -> 服务器 -> B），服务器不留副本、不写日志；
 *   - A、B 双密码配对：双方各提供一个密码并互相告知，两个密码都填对才能连入；
 *     第一个填出某密码组合的人进入等待，第二个填出相同组合的人与其配对（框填反也算同一组合）；
 *   - 同一密码组合同一时间只允许两个人；任何一方退出/断开，房间立即销毁。
 *
 * 与源文件的两处结构性差异（不改变可观察语义）：
 *   1. 模块是 ESM，房间/客户端状态封装在 `createChatServer()` 的闭包里，
 *      因此同一个进程可以创建多个互不干扰的服务实例（便于测试与换端口重启）；
 *   2. 首页路径指向插件资源 `../assets/index.html`；监听地址与等待超时可由参数覆盖。
 *
 * 手工运行：node lib/server.js（可用环境变量 PORT / WAIT_TIMEOUT_MS 覆盖）
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lanAddresses } from './lan.js';

const DEFAULT_PORT = 8787;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000; // 发起人等待上限
const MAX_TEXT_LEN = 2000;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_QUEUE = 100;
const DEFAULT_INDEX_PATH = fileURLToPath(new URL('../assets/index.html', import.meta.url));

/** `密码碰头` 主题色 / 标题都来自 assets/index.html；probeService 用它识别“是不是我们的服务”。 */
const INDEX_MARKER = '密码碰头';

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (ch) => {
      size += ch.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(ch);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function normalizeWaitTimeout(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n;
  const env = Number(process.env.WAIT_TIMEOUT_MS);
  return Number.isFinite(env) && env >= 0 && env > 0 ? env : DEFAULT_WAIT_TIMEOUT_MS;
}

/**
 * Create an unlistened chat server.
 *
 * The returned `http.Server` owns its own rooms/clients state, so several
 * instances can coexist in one process (the DSH host uses one).
 *
 * @param {object} [options]
 * @param {number} [options.waitTimeoutMs] initiator wait limit; defaults to `WAIT_TIMEOUT_MS` env or 10 min.
 * @param {string} [options.indexHtmlPath] override for the chat page asset.
 * @returns {import('node:http').Server}
 */
export function createChatServer(options = {}) {
  const waitTimeoutMs = normalizeWaitTimeout(options.waitTimeoutMs);
  const indexHtmlPath = options.indexHtmlPath || DEFAULT_INDEX_PATH;

  /** roomId -> { id, pairKey, members:[cid, cid], status:'waiting'|'active', waitTimer } */
  const rooms = new Map();
  /** 房间钥匙（A、B 两个密码哈希的规范组合）-> roomId */
  const pairIndex = new Map();
  /** cid -> { res, roomId, queue:[], born } */
  const clients = new Map();

  /** 把事件推给某个客户端；SSE 尚未接通时先入队，接通后再补发。 */
  function sseSend(cid, event) {
    const c = clients.get(cid);
    if (!c) return;
    if (c.res) {
      try {
        c.res.write('data: ' + JSON.stringify(event) + '\n\n');
        return;
      } catch (_) { /* 写失败则落入队列 */ }
    }
    if (c.queue.length < MAX_QUEUE) c.queue.push(event);
  }

  /**
   * 销毁房间。actorCid 为触发者（null 表示超时等系统原因）；
   * actorCid 收到 selfReason，其他人收到 peerReason。
   */
  function endRoom(roomId, actorCid, selfReason, peerReason) {
    const room = rooms.get(roomId);
    if (!room) return;
    rooms.delete(roomId);
    if (pairIndex.get(room.pairKey) === roomId) pairIndex.delete(room.pairKey);
    if (room.waitTimer) clearTimeout(room.waitTimer);
    for (const cid of room.members) {
      sseSend(cid, { type: 'end', reason: cid === actorCid ? selfReason : (peerReason || selfReason) });
      const c = clients.get(cid);
      if (c) c.roomId = null;
    }
  }

  async function handleApi(req, res, pathname) {
    let body = {};
    try {
      const raw = await readBody(req);
      if (raw) body = JSON.parse(raw);
    } catch (_) {
      return sendJson(res, 400, { ok: false, error: '请求格式错误。' });
    }

    const cid = typeof body.cid === 'string' ? body.cid : '';
    if (!/^[0-9a-f]{16,64}$/i.test(cid)) {
      return sendJson(res, 400, { ok: false, error: '客户端标识无效，请刷新页面重试。' });
    }

    // ---------- 进入 / 配对（A、B 双密码） ----------
    if (pathname === '/api/enter') {
      const passwordA = typeof body.passwordA === 'string' ? body.passwordA : '';
      const passwordB = typeof body.passwordB === 'string' ? body.passwordB : '';
      const okLen = (p) => p.length >= 4 && p.length <= 128;
      if (!okLen(passwordA) || !okLen(passwordB)) {
        return sendJson(res, 400, {
          ok: false,
          error: 'A、B 两个密码都要填写，长度需在 4 到 128 个字符之间。',
        });
      }

      let c = clients.get(cid);
      if (!c) {
        c = { res: null, roomId: null, queue: [], born: Date.now() };
        clients.set(cid, c);
      }

      // 房间钥匙 = 两个密码哈希按字典序拼接后再哈希；
      // 即使两人把 A 框、B 框填反，得到的也是同一把钥匙，仍能配上
      const hA = sha256(passwordA);
      const hB = sha256(passwordB);
      const [hx, hy] = hA < hB ? [hA, hB] : [hB, hA];
      const pairKey = sha256(hx + '|' + hy);

      const existingId = pairIndex.get(pairKey);
      const existing = existingId ? rooms.get(existingId) : null;

      if (existing && existing.members.includes(cid)) {
        // 重复提交：原样返回当前状态，不重复入座
        return sendJson(res, 200, { ok: true, status: existing.status, roomId: existing.id });
      }
      if (existing && existing.status === 'active') {
        return sendJson(res, 409, {
          ok: false,
          error: '该密码组合对应的聊天正在进行中（已有两人），请稍后再试或换一组密码。',
        });
      }
      if (existing) {
        // 房间正在等待 → 第二位输入相同密码的人配对成功
        clearTimeout(existing.waitTimer);
        existing.status = 'active';
        existing.members.push(cid);
        c.roomId = existing.id;
        sseSend(existing.members[0], { type: 'connected' });
        sseSend(cid, { type: 'connected' });
        return sendJson(res, 200, { ok: true, status: 'connected', roomId: existing.id });
      }

      // 没有相同组合的房间 → 这个人成为第一位发起人，进入等待
      const rid = crypto.randomBytes(16).toString('hex');
      const room = { id: rid, pairKey, members: [cid], status: 'waiting', waitTimer: null };
      room.waitTimer = setTimeout(() => {
        endRoom(rid, null, '等待超时：一直没有人填出相同的密码组合，已自动取消。', '');
      }, waitTimeoutMs);
      rooms.set(rid, room);
      pairIndex.set(pairKey, rid);
      c.roomId = rid;
      return sendJson(res, 200, { ok: true, status: 'waiting', roomId: rid });
    }

    // ---------- 发消息（只转发，不保存） ----------
    if (pathname === '/api/send') {
      const room = rooms.get(typeof body.roomId === 'string' ? body.roomId : '');
      const text = typeof body.text === 'string' ? body.text : '';
      if (!room || room.status !== 'active' || !room.members.includes(cid)) {
        return sendJson(res, 410, { ok: false, error: '会话不存在或已结束。' });
      }
      const t = text.replace(/\r?\n/g, ' ').trim();
      if (!t) return sendJson(res, 400, { ok: false, error: '消息不能为空。' });
      if (t.length > MAX_TEXT_LEN) {
        return sendJson(res, 400, { ok: false, error: '消息太长（最多 ' + MAX_TEXT_LEN + ' 个字符）。' });
      }
      const peer = room.members.find((m) => m !== cid);
      sseSend(peer, { type: 'msg', text: t });
      return sendJson(res, 200, { ok: true });
    }

    // ---------- 主动退出 ----------
    if (pathname === '/api/leave') {
      const room = rooms.get(typeof body.roomId === 'string' ? body.roomId : '');
      if (room && room.members.includes(cid)) {
        if (room.status === 'waiting') {
          endRoom(room.id, cid, '你已取消等待。', '');
        } else {
          endRoom(
            room.id,
            cid,
            '你结束了会话，聊天内容已清除。',
            '对方结束了会话，聊天内容已清除。'
          );
        }
      }
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { ok: false, error: '未知接口。' });
  }

  /** SSE 长连接：服务器把配对、消息、结束事件实时推给浏览器。 */
  function handleSse(req, res, cid) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (res.flushHeaders) res.flushHeaders();

    let c = clients.get(cid);
    if (!c) {
      c = { res: null, roomId: null, queue: [], born: Date.now() };
      clients.set(cid, c);
    }
    if (c.res && c.res !== res) {
      try { c.res._replaced = true; } catch (_) {} // 旧连接作废，其 close 事件不触发离开逻辑
    }
    c.res = res;

    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) {}
    }, 25000);

    res.on('close', () => {
      clearInterval(ping);
      const cur = clients.get(cid);
      if (!cur || cur.res !== res) return; // 已被新连接替换或已清理
      cur.res = null;
      clients.delete(cid);
      const rid = cur.roomId;
      if (!rid) return;
      const room = rooms.get(rid);
      if (!room) return;
      if (room.status === 'active') {
        // 对端刷新/关闭页面/断网 → 会话立即结束
        endRoom(rid, cid, '你已离开，会话已结束。', '对方离开或断开连接，会话已结束，聊天内容已清除。');
      } else {
        endRoom(rid, cid, '你已离开，等待已取消。', '');
      }
    });

    // 补发积压事件，并告知客户端当前会话是否仍有效（服务器重启后 roomId 会变空）
    const queued = c.queue.splice(0);
    for (const ev of queued) res.write('data: ' + JSON.stringify(ev) + '\n\n');
    res.write('data: ' + JSON.stringify({ type: 'bound', roomId: c.roomId }) + '\n\n');
    res.write(': connected\n\n');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/events') {
      const cid = url.searchParams.get('cid') || '';
      if (!/^[0-9a-f]{16,64}$/i.test(cid)) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('bad cid');
        return;
      }
      handleSse(req, res, cid);
      return;
    }

    if (req.method === 'POST' && pathname.startsWith('/api/')) {
      try {
        await handleApi(req, res, pathname);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: '服务器内部错误。' });
        } else {
          try { res.end(); } catch (_) {}
        }
      }
      return;
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      try {
        const html = fs.readFileSync(indexHtmlPath);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } catch (_) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('index.html 缺失');
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  // 定期清理从未建立 SSE、又不属于任何房间的僵尸客户端记录
  const zombieTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, c] of clients) {
      if (!c.res && !c.roomId && now - (c.born || 0) > 5 * 60 * 1000) clients.delete(key);
    }
  }, 60 * 1000);
  zombieTimer.unref?.();

  server.on('close', () => {
    clearInterval(zombieTimer);
    for (const room of rooms.values()) {
      if (room.waitTimer) clearTimeout(room.waitTimer);
    }
    rooms.clear();
    pairIndex.clear();
    clients.clear();
  });

  return server;
}

/**
 * Start and return a listening chat server.
 *
 * @param {number} [port] port to bind; `0` asks the OS for one.
 * @param {object} [options] `{ host, waitTimeoutMs, indexHtmlPath }`.
 * @returns {Promise<import('node:http').Server>} the listening server; rejects on bind errors.
 */
export function startChatServer(port = DEFAULT_PORT, options = {}) {
  const host = options.host || '0.0.0.0';
  return new Promise((resolve, reject) => {
    const server = createChatServer(options);
    let settled = false;
    const onError = (err) => {
      if (settled) return;
      settled = true;
      server.removeListener('listening', onListening);
      try { server.close(); } catch (_) {}
      reject(err);
    };
    const onListening = () => {
      if (settled) return;
      settled = true;
      server.removeListener('error', onError);
      server.on('error', (err) => console.error('聊天服务运行时错误：', err));
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(port, host);
    } catch (err) {
      onError(err);
    }
  });
}

/**
 * Stop a chat server and release its port.
 *
 * Existing keep-alive/SSE connections would otherwise hold `close()` open, so
 * they are terminated first. Safe to call twice and on a server that never
 * listened.
 *
 * @param {import('node:http').Server | null | undefined} server
 * @returns {Promise<void>} resolves once the listening socket is closed.
 */
export function stopChatServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      if (server) {
        try { server.close(); } catch (_) {}
      }
      resolve();
      return;
    }
    const done = () => resolve();
    server.once('close', done);
    try { server.closeAllConnections?.(); } catch (_) {}
    try { server.close(() => {}); } catch (_) { resolve(); }
  });
}

/** 探测端口上的服务：{ http: 是否有任何响应, ours: 是否是本聊天服务 } */
export function probeService(port, pathname = '/') {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ http: true, ours: res.statusCode === 200 && body.includes(INDEX_MARKER) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ http: true, ours: false }); });
    req.on('error', () => resolve({ http: false, ours: false }));
  });
}

/** 启动横幅（手工运行时使用；插件内由 index.js 通过 logger 汇报）。 */
export function printBanner(port, host = '0.0.0.0') {
  const line = '-'.repeat(56);
  console.log(line);
  console.log('  AB-BA 秘密对话 · 一次性双人文字聊天 已启动');
  console.log('  本机访问:    http://127.0.0.1:' + port);
  if (host === '0.0.0.0' || host === '::') {
    for (const ip of lanAddresses()) console.log('  局域网访问:  http://' + ip + ':' + port);
  }
  console.log('  消息只在内存中转发，不落盘；Ctrl+C 退出即全部消失。');
  console.log(line);
}

export { DEFAULT_PORT, DEFAULT_INDEX_PATH, lanAddresses };

const isDirectRun = (() => {
  try {
    return process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch (_) {
    return false;
  }
})();

if (isDirectRun) {
  const PORT = Number(process.env.PORT) || DEFAULT_PORT;
  const HOST = process.env.HOST || '0.0.0.0';
  startChatServer(PORT, { host: HOST })
    .then((server) => printBanner(server.address().port, HOST))
    .catch((err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.error('端口 ' + PORT + ' 已被占用。可换端口启动：PORT=9000 node lib/server.js');
        process.exit(1);
      }
      console.error('服务器错误：', err);
      process.exit(1);
    });
}
