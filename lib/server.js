#!/usr/bin/env node
/**
 * AB-BA 秘密对话 · 一次性双人聊天 —— 内嵌服务器（协议 v2：端到端密文转发）
 *
 * 移植自 `password-chat/server.js`（v1 语义基线），0.2.0 起升级为协议 v2：
 *   - 服务器**永远不接触**密码明文、密码哈希、加密密钥或消息明文：
 *     配对只收客户端推导出的 `pairKey`，消息只收并转发密文 payload；
 *   - 服务端对 payload 只做形状/大小校验（`v`、`k`、`iv`、`ct`、`mac`、序列化上限），
 *     不解密、不解析 `ct` 内容、不改写、不落盘，日志中不出现 payload；
 *   - 其余会话语义与 v1 完全一致：双人配对、A/B 两个框填反等价（由 `pairKey` 保证）、
 *     第三人 409、发起人等待上限 10 分钟、任一方离开/刷新/断网即销毁房间；
 *   - 房间销毁走统一的 `endRoom`：删除 rooms/pairIndex、清空双方待发事件队列与
 *     `roomId`，内存中不保留任何消息/密文引用（端口由 `stopChatServer` 释放）。
 *
 * 静态资源路由（严格白名单，不是通用文件服务器）：
 *   GET /                 → assets/index.html
 *   GET /index.html       → assets/index.html
 *   GET /crypto.js        → assets/abba-crypto.js
 *   GET /vendor/crypto-js.js → assets/crypto-js.min.js
 *
 * 零依赖，Node.js >= 18。
 * 手工运行：node lib/server.js（可用环境变量 PORT / WAIT_TIMEOUT_MS 覆盖）
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lanAddresses } from './lan.js';

const DEFAULT_PORT = 8787;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000; // 发起人等待上限
const MAX_BODY_BYTES = 3 * 1024 * 1024; // HTTP 请求体上限（v2：3 MiB）
const MAX_PAYLOAD_CHARS = Math.floor(2.5 * 1024 * 1024); // JSON.stringify(payload).length 上限（2.5 MiB）
const MAX_QUEUE = 100; // 单个客户端待发事件条数上限（与 v1 一致）
const MAX_QUEUE_BYTES = 32 * 1024 * 1024; // 待发密文的总字节上限（防御未接通 SSE 时堆积）
const DEFAULT_INDEX_PATH = fileURLToPath(new URL('../assets/index.html', import.meta.url));
const DEFAULT_CRYPTO_JS_PATH = fileURLToPath(new URL('../assets/abba-crypto.js', import.meta.url));
const DEFAULT_VENDOR_CRYPTO_JS_PATH = fileURLToPath(new URL('../assets/crypto-js.min.js', import.meta.url));

/** `密码碰头` 主题色 / 标题都来自 assets/index.html；probeService 用它识别“是不是我们的服务”。 */
const INDEX_MARKER = '密码碰头';

/** 客户端标识：16~64 位 hex（浏览器生成 32 位）。 */
const CID_RE = /^[0-9a-f]{16,64}$/i;
/** pairKey：64 位 hex（两端各自推导，服务器只见这一把“配对钥匙”）。 */
const PAIR_KEY_RE = /^[0-9a-f]{64}$/i;
/** 标准 base64（含 padding 规范）；ct/mac 只做该正则校验，不解码内容。 */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** payload 允许的消息类型。 */
const PAYLOAD_KINDS = new Set(['text', 'image']);

/**
 * 服务端内部状态测试钩子（非枚举 Symbol，不通过网络暴露）。
 * 测试用它断言房间销毁后 rooms/pairIndex/客户端队列无残留。
 */
export const TEST_HOOKS = Symbol.for('dsh-abba-secret-chat.server.test-hooks');

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

/**
 * 读取请求体，超过上限时停止缓存并丢弃剩余字节，保证还能回一个 400。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<string>}
 */
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const tooLarge = () => {
      if (settled) return;
      settled = true;
      // 不直接 destroy：先 drain 掉剩余请求体，让 400 响应能正常写回。
      try { req.resume(); } catch (_) { /* ignore */ }
      reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }));
    };
    req.on('data', (ch) => {
      if (settled) return;
      size += ch.length;
      if (size > limit) {
        tooLarge();
        return;
      }
      chunks.push(ch);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    req.on('close', () => {
      // 客户端中途断开（既没 end 也没 error）时也要结束 Promise，避免悬挂。
      if (settled) return;
      settled = true;
      reject(new Error('request aborted'));
    });
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 合法且非空的 base64（标准字母表 + 规范 padding）。 */
function isNonEmptyBase64(value) {
  return typeof value === 'string' && value.length > 0 && value.length % 4 === 0 && BASE64_RE.test(value);
}

/**
 * v2 payload 形状/大小校验。服务器不解密、不读 `ct` 内容（只按正则判断是否 base64）。
 *
 * 规则（CONTRACT-V2 §2）：
 *   - payload 必须是对象；
 *   - `JSON.stringify(payload).length` ≤ 2.5 MiB；
 *   - `v === 1`；`k ∈ {'text','image'}`；
 *   - `iv` 为合法 base64 且解码后正好 16 字节；
 *   - `ct` / `mac` 为非空合法 base64。
 *
 * @param {unknown} payload
 * @returns {{ok: true, payload: object, serializedLength: number} | {ok: false, error: string}}
 */
function validatePayload(payload) {
  if (!isPlainObject(payload)) return { ok: false, error: '消息内容格式无效。' };

  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch (_) {
    return { ok: false, error: '消息内容格式无效。' };
  }
  if (typeof serialized !== 'string') return { ok: false, error: '消息内容格式无效。' };
  if (serialized.length > MAX_PAYLOAD_CHARS) {
    return { ok: false, error: '消息过大（密文上限 2.5 MiB）。' };
  }
  if (payload.v !== 1) return { ok: false, error: '不支持的消息版本。' };
  if (!PAYLOAD_KINDS.has(payload.k)) return { ok: false, error: '不支持的消息类型。' };
  if (!isNonEmptyBase64(payload.iv)) return { ok: false, error: '消息初始向量无效。' };
  if (Buffer.from(payload.iv, 'base64').length !== 16) {
    return { ok: false, error: '消息初始向量长度无效。' };
  }
  if (!isNonEmptyBase64(payload.ct)) return { ok: false, error: '消息密文无效。' };
  if (!isNonEmptyBase64(payload.mac)) return { ok: false, error: '消息校验码无效。' };

  return { ok: true, payload, serializedLength: serialized.length };
}

function normalizeWaitTimeout(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n;
  const env = Number(process.env.WAIT_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_WAIT_TIMEOUT_MS;
}

/** 静态脚本路由：text/javascript + no-store；文件缺失回 404 文本（不崩）。 */
function serveAsset(res, filePath) {
  let body;
  try {
    body = fs.readFileSync(filePath);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Not Found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  res.end(body);
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
 * @param {string} [options.assetsDir] override the assets directory (index/crypto scripts live there).
 * @param {string} [options.cryptoJsPath] override `assets/abba-crypto.js`.
 * @param {string} [options.vendorCryptoJsPath] override `assets/crypto-js.min.js`.
 * @returns {import('node:http').Server}
 */
export function createChatServer(options = {}) {
  const waitTimeoutMs = normalizeWaitTimeout(options.waitTimeoutMs);
  const assetsDir = options.assetsDir
    || (typeof options.indexHtmlPath === 'string' && options.indexHtmlPath.length > 0
      ? path.dirname(path.resolve(options.indexHtmlPath))
      : path.dirname(DEFAULT_INDEX_PATH));
  const indexHtmlPath = options.indexHtmlPath || path.join(assetsDir, 'index.html');
  const cryptoJsPath = options.cryptoJsPath || path.join(assetsDir, 'abba-crypto.js');
  const vendorCryptoJsPath = options.vendorCryptoJsPath || path.join(assetsDir, 'crypto-js.min.js');

  /** roomId -> { id, pairKey, members:[cid, cid], status:'waiting'|'active', waitTimer } */
  const rooms = new Map();
  /** 配对钥匙（客户端推导的 pairKey）-> roomId */
  const pairIndex = new Map();
  /** cid -> { res, roomId, queue:[], queueBytes, born } */
  const clients = new Map();

  /** 把事件推给某个客户端；SSE 尚未接通时先入队，接通后再补发。 */
  function sseSend(cid, event, sizeHint = 0) {
    const c = clients.get(cid);
    if (!c) return;
    if (c.res) {
      try {
        c.res.write('data: ' + JSON.stringify(event) + '\n\n');
        return;
      } catch (_) { /* 写失败则落入队列 */ }
    }
    if (c.queue.length >= MAX_QUEUE) return;
    const size = sizeHint > 0 ? sizeHint : (event.type === 'msg' ? JSON.stringify(event).length : 0);
    if (c.queueBytes + size > MAX_QUEUE_BYTES) return;
    c.queue.push(event);
    c.queueBytes += size;
  }

  /** 清空客户端待发事件（含密文 payload 引用）与 roomId。 */
  function resetClient(c) {
    if (!c) return;
    c.queue.length = 0;
    c.queueBytes = 0;
    c.roomId = null;
  }

  /**
   * 销毁房间（所有结束路径统一走这里：主动离开 / 等待超时 / SSE 断开 / 服务关闭）。
   * actorCid 为触发者（null 表示超时等系统原因）；
   * actorCid 收到 selfReason，其他人收到 peerReason。
   */
  function endRoom(roomId, actorCid, selfReason, peerReason) {
    const room = rooms.get(roomId);
    if (!room) return;
    rooms.delete(roomId);
    if (room.pairKey && pairIndex.get(room.pairKey) === roomId) pairIndex.delete(room.pairKey);
    if (room.waitTimer) {
      clearTimeout(room.waitTimer);
      room.waitTimer = null;
    }
    const members = room.members.slice();
    room.members.length = 0; // 释放房间对成员的引用；房间对象随后由 GC 回收
    for (const cid of members) {
      // 先彻底清理（队列里可能还压着未投递的密文 payload），再补发结束事件。
      resetClient(clients.get(cid));
      sseSend(cid, { type: 'end', reason: cid === actorCid ? selfReason : (peerReason || selfReason) });
    }
  }

  async function handleApi(req, res, pathname) {
    let body = {};
    try {
      const raw = await readBody(req, MAX_BODY_BYTES);
      if (raw) body = JSON.parse(raw);
    } catch (err) {
      if (err && err.code === 'BODY_TOO_LARGE') {
        return sendJson(res, 400, { ok: false, error: '请求体过大（上限 3 MiB）。' });
      }
      return sendJson(res, 400, { ok: false, error: '请求格式错误。' });
    }
    if (!isPlainObject(body)) {
      return sendJson(res, 400, { ok: false, error: '请求格式错误。' });
    }

    const cid = typeof body.cid === 'string' ? body.cid : '';
    if (!CID_RE.test(cid)) {
      return sendJson(res, 400, { ok: false, error: '客户端标识无效，请刷新页面重试。' });
    }

    // ---------- 进入 / 配对（v2：只收 pairKey，服务器不接触密码） ----------
    if (pathname === '/api/enter') {
      const rawPairKey = typeof body.pairKey === 'string' ? body.pairKey : '';
      if (!PAIR_KEY_RE.test(rawPairKey)) {
        return sendJson(res, 400, {
          ok: false,
          error: '配对信息无效，请返回开始页重新输入 A、B 两个密码。',
        });
      }
      // hex 大小写不敏感：统一小写，避免同一把钥匙因大小写不同而配不上。
      const pairKey = rawPairKey.toLowerCase();

      let c = clients.get(cid);
      if (!c) {
        c = { res: null, roomId: null, queue: [], queueBytes: 0, born: Date.now() };
        clients.set(cid, c);
      }

      const existingId = pairIndex.get(pairKey);
      const existing = existingId ? rooms.get(existingId) : null;

      if (existing && existing.members.includes(cid)) {
        // 重复提交：原样返回当前状态，不重复入座。
        // 内部 active 对应协议里的 connected（对外只暴露 waiting/connected）。
        return sendJson(res, 200, {
          ok: true,
          status: existing.status === 'active' ? 'connected' : 'waiting',
          roomId: existing.id,
        });
      }
      if (existing && existing.status === 'active') {
        return sendJson(res, 409, {
          ok: false,
          error: '该配对对应的聊天正在进行中（已有两人），请稍后再试或换一组密码。',
        });
      }
      if (existing) {
        // 房间正在等待 → 第二位持相同 pairKey 的人配对成功（A/B 填反由客户端保证 pairKey 相同）
        clearTimeout(existing.waitTimer);
        existing.waitTimer = null;
        existing.status = 'active';
        existing.members.push(cid);
        c.roomId = existing.id;
        sseSend(existing.members[0], { type: 'connected' });
        sseSend(cid, { type: 'connected' });
        return sendJson(res, 200, { ok: true, status: 'connected', roomId: existing.id });
      }

      // 没有相同配对钥匙的房间 → 这个人成为第一位发起人，进入等待
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

    // ---------- 发消息（v2：只校验并转发密文 payload，不保存、不解密） ----------
    if (pathname === '/api/send') {
      const room = rooms.get(typeof body.roomId === 'string' ? body.roomId : '');
      if (!room || room.status !== 'active' || !room.members.includes(cid)) {
        return sendJson(res, 410, { ok: false, error: '会话不存在或已结束。' });
      }
      const verdict = validatePayload(body.payload);
      if (!verdict.ok) {
        return sendJson(res, 400, { ok: false, error: verdict.error });
      }
      const peer = room.members.find((m) => m !== cid);
      sseSend(peer, { type: 'msg', payload: verdict.payload }, verdict.serializedLength);
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
      c = { res: null, roomId: null, queue: [], queueBytes: 0, born: Date.now() };
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
      const rid = cur.roomId; // 必须在 resetClient 之前取出，否则会丢掉房间索引
      resetClient(cur);
      clients.delete(cid);
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
    c.queueBytes = 0;
    for (const ev of queued) res.write('data: ' + JSON.stringify(ev) + '\n\n');
    res.write('data: ' + JSON.stringify({ type: 'bound', roomId: c.roomId }) + '\n\n');
    res.write(': connected\n\n');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/events') {
      const cid = url.searchParams.get('cid') || '';
      if (!CID_RE.test(cid)) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
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

    if (req.method === 'GET') {
      if (pathname === '/' || pathname === '/index.html') {
        try {
          const html = fs.readFileSync(indexHtmlPath);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': html.length,
          });
          res.end(html);
        } catch (_) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('index.html 缺失');
        }
        return;
      }
      // 严格白名单：只有这两个脚本文件名会被映射到 assets/，不暴露任意文件。
      if (pathname === '/crypto.js') {
        serveAsset(res, cryptoJsPath);
        return;
      }
      if (pathname === '/vendor/crypto-js.js') {
        serveAsset(res, vendorCryptoJsPath);
        return;
      }
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
      room.members.length = 0;
    }
    rooms.clear();
    pairIndex.clear();
    for (const c of clients.values()) resetClient(c);
    clients.clear();
  });

  // 测试钩子：只读快照，用于断言销毁后无残留（不通过网络暴露）。
  Object.defineProperty(server, TEST_HOOKS, {
    value: () => ({
      rooms: rooms.size,
      pairIndex: pairIndex.size,
      clients: clients.size,
      clientQueues: [...clients.entries()].map(([id, c]) => ({
        id,
        roomId: c.roomId,
        queue: c.queue.map((ev) => ev.type),
      })),
    }),
    enumerable: false,
    configurable: true,
  });

  return server;
}

/**
 * Start and return a listening chat server.
 *
 * @param {number} [port] port to bind; `0` asks the OS for one.
 * @param {object} [options] `{ host, waitTimeoutMs, indexHtmlPath, assetsDir, cryptoJsPath, vendorCryptoJsPath }`.
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
    try { server.closeIdleConnections?.(); } catch (_) {}
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
  console.log('  AB-BA 秘密对话 · 一次性双人加密聊天 已启动');
  console.log('  本机访问:    http://127.0.0.1:' + port);
  if (host === '0.0.0.0' || host === '::') {
    for (const ip of lanAddresses()) console.log('  局域网访问:  http://' + ip + ':' + port);
  }
  console.log('  消息以密文转发，服务器无法解密；Ctrl+C 退出即全部消失。');
  console.log(line);
}

export {
  DEFAULT_PORT,
  DEFAULT_INDEX_PATH,
  DEFAULT_CRYPTO_JS_PATH,
  DEFAULT_VENDOR_CRYPTO_JS_PATH,
  MAX_BODY_BYTES,
  MAX_PAYLOAD_CHARS,
  lanAddresses,
};

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
