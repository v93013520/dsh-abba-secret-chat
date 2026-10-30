#!/usr/bin/env node
/**
 * 服务端协议 v2 端到端自检：node test/host-e2e-v2.mjs
 *
 * 覆盖 CONTRACT-V2 §2 / §5.2：
 *   0. 静态路由：/、/index.html、/crypto.js、/vendor/crypto-js.js（严格白名单，文件缺失 404 不崩）
 *   1. /api/enter：pairKey 配对、A/B 填反等价（pairKey 相同）、第三人 409、
 *      重复提交幂等、v1 的 passwordA/passwordB 形状已不再接受、非法 pairKey 400
 *   2. /api/send：密文 payload（text/image）原样转发；坏 payload 各类 400 且不转发；
 *      日志中不出现 payload；HTTP 体超过 3 MiB → 400
 *   3. 离开：统一销毁房间、pairIndex、双方队列（含尚未投递的密文引用）与 roomId；
 *      同 pairKey 可重新发起；销毁后不再投递任何密文
 *   4. 等待超时自动取消；stopChatServer 释放端口且可重复调用
 *   5. 用真实 lib/index.js 的 apply() 验证 /abba/info 契约与 v2 聊天路由共存，
 *      插件卸载后聊天端口释放（不依赖/不修改 test/host-info.mjs）
 *   6. 主服务停止后端口释放
 *
 * 零依赖：只用 Node 内置模块。允许并行开发期 assets/crypto*.js 尚未就绪，
 * 对应路由按“文件缺失 → 404 文本”验证。
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { apply } from '../lib/index.js';
import {
  startChatServer,
  stopChatServer,
  MAX_BODY_BYTES,
  TEST_HOOKS,
} from '../lib/server.js';

const ASSETS_DIR = new URL('../assets/', import.meta.url);
const SHORT_WAIT_MS = 2000; // 主服务等待上限（配对用例需在此时限内完成）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cid = () => crypto.randomBytes(16).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** 与 assets/abba-crypto.js 完全一致的 pairKey 推导（hA/hB 字典序拼接后再哈希）。 */
function derivePairKey(passwordA, passwordB) {
  const hA = sha256(passwordA);
  const hB = sha256(passwordB);
  const [hx, hy] = hA < hB ? [hA, hB] : [hB, hA];
  return sha256(hx + '|' + hy);
}

/** 一个形状合法的“密文 payload”（伪造随机字节，用于验证服务器只转发不解密）。 */
function randomPayload(kind = 'text', patch = {}) {
  return {
    k: kind,
    v: 1,
    iv: crypto.randomBytes(16).toString('base64'),
    ct: crypto.randomBytes(64).toString('base64'),
    mac: crypto.randomBytes(32).toString('base64'),
    ...patch,
  };
}

function readAsset(name) {
  try {
    return readFileSync(new URL(name, ASSETS_DIR));
  } catch (_) {
    return null;
  }
}

// ─────────────────────────── HTTP / SSE 小工具 ───────────────────────────

/**
 * @param {number} port
 * @param {string} pathname
 * @param {{method?: string, json?: unknown, rawBody?: string}} [options]
 */
function request(port, pathname, options = {}) {
  const { method = 'GET', json, rawBody } = options;
  const bodyText = rawBody !== undefined
    ? rawBody
    : (json !== undefined ? JSON.stringify(json) : undefined);
  /** @type {Record<string, string|number>} */
  const headers = {};
  if (bodyText !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Length'] = Buffer.byteLength(bodyText);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const body = buffer.toString('utf8');
        let parsed;
        try { parsed = JSON.parse(body); } catch (_) { parsed = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, body, buffer, json: parsed });
      });
    });
    req.on('error', reject);
    if (bodyText !== undefined) req.write(bodyText);
    req.end();
  });
}

/** 建立 SSE 监听，返回 { events, countOf(type), waitFor(type, extra, ms), close() }。 */
function sse(port, id) {
  const events = [];
  let buf = '';
  const req = http.get({ host: '127.0.0.1', port, path: '/events?cid=' + id }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          try { events.push(JSON.parse(line.slice(6))); } catch (_) { /* 忽略坏帧 */ }
        }
      }
    });
  });
  req.on('error', () => { /* 连接被服务端关闭（stopChatServer）时忽略 */ });
  return {
    events,
    countOf(type) {
      return events.filter((e) => e.type === type).length;
    },
    async waitFor(type, extra = {}, ms = 5000) {
      const t0 = Date.now();
      for (;;) {
        const hit = events.find((e) => e.type === type
          && Object.entries(extra).every(([k, v]) => (typeof v === 'function' ? v(e[k]) : e[k] === v)));
        if (hit) return hit;
        if (Date.now() - t0 > ms) {
          throw new Error('等待 SSE 事件 ' + type + ' 超时；已收到: ' + JSON.stringify(events));
        }
        await sleep(30);
      }
    },
    close() {
      req.destroy();
    },
  };
}

/** 服务端内部状态快照（rooms / pairIndex / 客户端队列的类型列表）。 */
function snapshot(server) {
  const hook = server[TEST_HOOKS];
  assert.strictEqual(typeof hook, 'function', 'server 上应挂 TEST_HOOKS 测试钩子');
  return hook();
}

/** 断言“彻底清理”：无房间、无 pairIndex、无 roomId 残留、队列中无密文事件。 */
function assertClean(server, label) {
  const st = snapshot(server);
  assert.strictEqual(st.rooms, 0, label + '：不应残留房间');
  assert.strictEqual(st.pairIndex, 0, label + '：不应残留 pairIndex');
  assert.ok(
    st.clientQueues.every((c) => c.roomId === null),
    label + '：所有 client.roomId 应清空，实际 ' + JSON.stringify(st.clientQueues),
  );
  assert.ok(
    st.clientQueues.every((c) => !c.queue.includes('msg')),
    label + '：队列中不得残留密文事件，实际 ' + JSON.stringify(st.clientQueues),
  );
}

// ─────────────────────────── 端口 / 假 ctx 工具 ───────────────────────────

function listenNet(port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function portIsFree(port) {
  try {
    const blocker = await listenNet(port);
    await blocker.close();
    return true;
  } catch (_) {
    return false;
  }
}

async function waitFor(fn, { timeoutMs = 5000, intervalMs = 50, label = '条件' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - t0 > timeoutMs) throw new Error('等待' + label + '超时');
    await sleep(intervalMs);
  }
}

/** 最小假 Cordis 上下文：webServer.register / inject / effect / logger（与 host-info.mjs 同构）。 */
function makeFakeCtx() {
  const routes = new Map();
  const disposers = [];
  const logs = { info: [], warn: [] };
  const ctx = {
    logger: {
      info: (m) => logs.info.push(String(m)),
      warn: (m) => logs.warn.push(String(m)),
      error: (m) => logs.warn.push(String(m)),
      debug: () => {},
    },
    webServer: {
      register(route) {
        assert.ok(route && typeof route.handler === 'function', 'webServer.register 需要 handler');
        if (routes.has(route.path)) throw new Error('duplicate route ' + route.path);
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    inject(deps, callback) {
      if (deps.every((dep) => ctx[dep] !== undefined)) callback(ctx);
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
    get(service) {
      return ctx[service];
    },
  };
  return {
    ctx,
    routes,
    logs,
    async dispose() {
      while (disposers.length > 0) {
        const disposer = disposers.pop();
        try { await disposer(); } catch (_) { /* 清理失败不掩盖断言 */ }
      }
    },
  };
}

/** 把假 ctx 的 exact 路由挂到真实 http server 上。 */
async function startFakeWebServer(fake) {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const route = fake.routes.get(pathname);
    if (!route || route.kind !== 'exact') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    try {
      await route.handler(req, res);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err && err.message));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

// ─────────────────────────── 主流程 ───────────────────────────

const server = await startChatServer(0, { host: '127.0.0.1', waitTimeoutMs: SHORT_WAIT_MS });
const port = server.address().port;
console.log('聊天服务已启动：http://127.0.0.1:' + port + '/');
const opened = [];
let mainStopped = false;

try {
  // ═══════════════ 0. 静态路由 ═══════════════
  console.log('\n0. 静态路由：/ 与 /index.html、/crypto.js、/vendor/crypto-js.js');
  const indexRes = await request(port, '/');
  assert.strictEqual(indexRes.status, 200, 'GET / 应返回 200');
  assert.strictEqual(indexRes.headers['content-type'], 'text/html; charset=utf-8');
  assert.strictEqual(indexRes.headers['cache-control'], 'no-store');
  assert.ok(indexRes.buffer.length > 0, 'GET / 正文不能为空');
  const indexRes2 = await request(port, '/index.html');
  assert.strictEqual(indexRes2.status, 200, 'GET /index.html 应返回 200');
  assert.ok(indexRes2.buffer.equals(indexRes.buffer), '/ 与 /index.html 应返回同一份 assets/index.html');
  const diskIndex = readAsset('index.html');
  if (diskIndex && diskIndex.equals(indexRes.buffer)) {
    console.log('   / 与磁盘 assets/index.html 完全一致');
  } else {
    console.log('   / 返回了 HTML（页面可能正被并行改写，跳过字节比对）');
  }

  for (const [route, assetName] of [
    ['/crypto.js', 'abba-crypto.js'],
    ['/vendor/crypto-js.js', 'crypto-js.min.js'],
  ]) {
    const disk = readAsset(assetName);
    const res = await request(port, route);
    assert.strictEqual(res.headers['cache-control'], 'no-store', route + ' 必须 Cache-Control: no-store');
    if (disk) {
      assert.strictEqual(res.status, 200, route + ' 应返回 200');
      assert.strictEqual(res.headers['content-type'], 'text/javascript; charset=utf-8', route + ' Content-Type 不对');
      assert.ok(res.buffer.equals(disk), route + ' 应原样返回 assets/' + assetName);
      console.log('   ' + route + ' → assets/' + assetName + '（200，text/javascript，no-store）');
    } else {
      assert.strictEqual(res.status, 404, route + ' 在文件缺失时应返回 404（不能崩）');
      assert.ok(/^text\/plain/.test(res.headers['content-type'] || ''), route + ' 缺失时应返回 text/plain');
      assert.strictEqual(res.body, 'Not Found');
      console.log('   ' + route + ' → 文件缺失（assets/' + assetName + '），404 文本，不崩');
    }
  }

  // 严格白名单：不得变成通用文件服务器；/abba/info 只属于 DSH webserver，不在聊天端口上
  for (const pathname of ['/assets/index.html', '/assets/abba-crypto.js', '/lib/server.js', '/abba/info']) {
    const res = await request(port, pathname);
    assert.strictEqual(res.status, 404, '静态白名单不得暴露 ' + pathname);
  }
  console.log('   非白名单路径（/assets/**、/lib/server.js、/abba/info）→ 404 ✓');

  const unknownApi = await request(port, '/api/nope', { method: 'POST', json: { cid: cid() } });
  assert.strictEqual(unknownApi.status, 404, '未知 API 应返回 404');
  const badSse = await request(port, '/events?cid=not-a-valid-cid');
  assert.strictEqual(badSse.status, 400, 'SSE 坏 cid 应返回 400');
  console.log('   未知 API → 404；SSE 坏 cid → 400 ✓');

  // ═══════════════ 1. /api/enter：pairKey 配对 ═══════════════
  console.log('\n1. /api/enter：pairKey 配对 / 填反等价 / 第三人 409 / 重复提交');
  const pA = 'A-' + crypto.randomBytes(6).toString('hex');
  const pB = 'B-' + crypto.randomBytes(6).toString('hex');
  const pkAB = derivePairKey(pA, pB);
  const pkBA = derivePairKey(pB, pA);
  assert.strictEqual(pkAB, pkBA, 'A、B 两个框填反必须得到同一个 pairKey');
  assert.match(pkAB, /^[0-9a-f]{64}$/, 'pairKey 必须是 64 位 hex');
  console.log('   填反等价：pairKey = ' + pkAB.slice(0, 16) + '…（两种填法一致）');

  const a = cid();
  const b = cid();
  const third = cid();
  const fourth = cid();
  const A = sse(port, a);
  opened.push(A);
  const rEnterA = await request(port, '/api/enter', { method: 'POST', json: { cid: a, pairKey: pkAB } });
  assert.strictEqual(rEnterA.status, 200, '第一位进入应 200');
  assert.strictEqual(rEnterA.json.ok, true);
  assert.strictEqual(rEnterA.json.status, 'waiting', '第一位应为 waiting');
  assert.match(rEnterA.json.roomId, /^[0-9a-f]{32}$/, 'roomId 应为 32 位 hex');
  const roomId = rEnterA.json.roomId;
  let st = snapshot(server);
  assert.strictEqual(st.rooms, 1);
  assert.strictEqual(st.pairIndex, 1);

  const B = sse(port, b);
  opened.push(B);
  const rEnterB = await request(port, '/api/enter', { method: 'POST', json: { cid: b, pairKey: pkBA } });
  assert.strictEqual(rEnterB.status, 200, '第二位进入应 200');
  assert.strictEqual(rEnterB.json.status, 'connected', '相同 pairKey（填反）应配对成功');
  assert.strictEqual(rEnterB.json.roomId, roomId, '双方应在同一个房间');
  await A.waitFor('connected');
  await B.waitFor('connected');
  console.log('   第二位用“填反”密码推导出的同一 pairKey 配对成功 ✓');

  // 重复提交幂等
  const dupA = await request(port, '/api/enter', { method: 'POST', json: { cid: a, pairKey: pkAB } });
  assert.strictEqual(dupA.status, 200);
  assert.strictEqual(dupA.json.status, 'connected');
  assert.strictEqual(dupA.json.roomId, roomId);

  // v1 的密码形状已不再被接受（服务器不接触密码）
  const legacy = await request(port, '/api/enter', {
    method: 'POST',
    json: { cid: fourth, passwordA: pA, passwordB: pB },
  });
  assert.strictEqual(legacy.status, 400, '只带 passwordA/passwordB（v1 形状）应 400');
  assert.strictEqual(legacy.json.ok, false);
  console.log('   v1 的 passwordA/passwordB 请求 → 400：' + legacy.json.error);

  // 非法 pairKey
  for (const bad of ['', 'abc', 'z'.repeat(64), '0'.repeat(63), '0'.repeat(65), ' ' + '0'.repeat(64)]) {
    const res = await request(port, '/api/enter', { method: 'POST', json: { cid: fourth, pairKey: bad } });
    assert.strictEqual(res.status, 400, '非法 pairKey 应 400：' + JSON.stringify(bad));
    assert.strictEqual(res.json.ok, false);
  }
  console.log('   非法 pairKey（长度/非 hex）→ 400 ✓');

  // 第三人：相同 pairKey 已被两人占用 → 409
  const rThird = await request(port, '/api/enter', { method: 'POST', json: { cid: third, pairKey: pkAB } });
  assert.strictEqual(rThird.status, 409, '第三人应 409');
  assert.strictEqual(rThird.json.ok, false);
  console.log('   第三人（相同 pairKey）→ 409：' + rThird.json.error);

  // 大写 pairKey 规范化后仍是同一把钥匙 → 409
  const rUpper = await request(port, '/api/enter', { method: 'POST', json: { cid: fourth, pairKey: pkAB.toUpperCase() } });
  assert.strictEqual(rUpper.status, 409, '大写 pairKey 应规范化为同一把钥匙 → 409');

  // 不同 pairKey → 另开等待房，不混入进行中的会话
  const pkOther = derivePairKey(pA, 'other-' + crypto.randomBytes(4).toString('hex'));
  const rOther = await request(port, '/api/enter', { method: 'POST', json: { cid: fourth, pairKey: pkOther } });
  assert.strictEqual(rOther.status, 200);
  assert.strictEqual(rOther.json.status, 'waiting', '不同 pairKey 应另开等待房');
  assert.notStrictEqual(rOther.json.roomId, roomId, '不得混入进行中的会话');
  await request(port, '/api/leave', { method: 'POST', json: { cid: fourth, roomId: rOther.json.roomId } });
  st = snapshot(server);
  assert.strictEqual(st.rooms, 1, '取消等待后只应剩进行中的房间');
  console.log('   不同 pairKey 另开新房、取消等待后配对房不受影响 ✓');

  // ═══════════════ 2. /api/send：密文转发 + 校验 ═══════════════
  console.log('\n2. /api/send：密文 payload 原样转发 + 坏 payload 400 不转发');
  const textPayload = randomPayload('text');
  const sendText = await request(port, '/api/send', { method: 'POST', json: { cid: a, roomId, payload: textPayload } });
  assert.strictEqual(sendText.status, 200);
  assert.strictEqual(sendText.json.ok, true);
  const gotB = await B.waitFor('msg');
  assert.deepStrictEqual(gotB.payload, textPayload, '服务器不得改写/解密 payload');
  const imagePayload = randomPayload('image');
  await request(port, '/api/send', { method: 'POST', json: { cid: b, roomId, payload: imagePayload } });
  const gotA = await A.waitFor('msg');
  assert.deepStrictEqual(gotA.payload, imagePayload, 'image 类型 payload 应原样转发');
  console.log('   文字/图片密文 payload 双向原样转发（k/v/iv/ct/mac 完全一致）✓');

  // 日志里不出现 payload（含 ct 中的特征串）
  const marker = 'ABBA-PAYLOAD-MARKER-' + crypto.randomBytes(4).toString('hex');
  const markerCt = Buffer.concat([crypto.randomBytes(24), Buffer.from(marker, 'utf8')]).toString('base64');
  const markerPayload = randomPayload('text', { ct: markerCt });
  const logLines = [];
  const originalConsole = {};
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    originalConsole[method] = console[method];
    console[method] = (...args) => { logLines.push(args.map(String).join(' ')); };
  }
  let markerSendStatus = 0;
  try {
    const res = await request(port, '/api/send', { method: 'POST', json: { cid: a, roomId, payload: markerPayload } });
    markerSendStatus = res.status;
  } finally {
    for (const method of Object.keys(originalConsole)) console[method] = originalConsole[method];
  }
  assert.strictEqual(markerSendStatus, 200);
  assert.ok(
    !logLines.some((line) => line.includes(marker) || line.includes(markerCt)),
    '服务器日志中不得出现 payload 内容：' + JSON.stringify(logLines),
  );
  await B.waitFor('msg', { payload: (p) => p && p.ct === markerCt });
  console.log('   转发成功且日志中无任何 payload 内容 ✓');

  // 坏 payload：全部 400 且不转发
  const beforeBad = B.countOf('msg');
  const base = randomPayload('text');
  const missing = (key) => {
    const copy = { ...base };
    delete copy[key];
    return copy;
  };
  /** @type {Array<[string, unknown]>} */
  const badPayloads = [
    ['payload 缺失', undefined],
    ['payload 是字符串', 'not-an-object'],
    ['payload 是数组', []],
    ['k 非法（video）', { ...base, k: 'video' }],
    ['k 缺失', missing('k')],
    ['v=2', { ...base, v: 2 }],
    ['v 是字符串 "1"', { ...base, v: '1' }],
    ['iv 非 base64', { ...base, iv: '!!!not-base64!!!' }],
    ['iv 解码不是 16 字节', { ...base, iv: crypto.randomBytes(15).toString('base64') }],
    ['iv 缺失', missing('iv')],
    ['ct 非 base64', { ...base, ct: 'not base64!!' }],
    ['ct 缺失', missing('ct')],
    ['mac 非 base64', { ...base, mac: '@@@' }],
    ['mac 缺失', missing('mac')],
    // 2.5 MiB 上限：ct 本身就是合法 base64，但序列化后超过 2.5 MiB
    ['payload 序列化超过 2.5 MiB', { ...base, ct: 'A'.repeat(2650000) }],
  ];
  for (const [label, payload] of badPayloads) {
    const res = await request(port, '/api/send', { method: 'POST', json: { cid: a, roomId, payload } });
    assert.strictEqual(res.status, 400, '坏 payload 应 400：' + label);
    assert.strictEqual(res.json.ok, false, label + ' 应返回 ok:false');
    assert.ok(typeof res.json.error === 'string' && res.json.error.length > 0, label + ' 应带错误信息');
  }
  await sleep(250);
  assert.strictEqual(B.countOf('msg'), beforeBad, '坏 payload 不得被转发');
  console.log('   ' + badPayloads.length + ' 类坏 payload 全部 400 且未转发 ✓');

  // 超大 HTTP 体（> 3 MiB）→ 400
  const oversizedBody = await request(port, '/api/enter', {
    method: 'POST',
    rawBody: ' '.repeat(MAX_BODY_BYTES + 1024),
  });
  assert.strictEqual(oversizedBody.status, 400, '超过 ' + MAX_BODY_BYTES + ' 字节的请求体应 400');
  assert.strictEqual(oversizedBody.json.ok, false);
  console.log('   HTTP 体超过 3 MiB → 400（连接未被砍断）✓');

  // 非成员 / 不存在的房间 → 410
  const wrongRoom = await request(port, '/api/send', { method: 'POST', json: { cid: a, roomId: '0'.repeat(32), payload: randomPayload() } });
  assert.strictEqual(wrongRoom.status, 410, '不存在的房间应 410');
  const nonMember = await request(port, '/api/send', { method: 'POST', json: { cid: third, roomId, payload: randomPayload() } });
  assert.strictEqual(nonMember.status, 410, '非成员发送应 410');
  console.log('   不存在的房间 / 非成员 → 410 ✓');

  // ═══════════════ 3. 离开 → 统一彻底清理 ═══════════════
  console.log('\n3. 离开：统一销毁房间 / pairIndex / 队列中的密文引用 / roomId');

  // 3.1 主配对由 B 离开销毁：A 收到“对方结束”，全量状态无残留
  await request(port, '/api/leave', { method: 'POST', json: { cid: b, roomId } });
  const endA = await A.waitFor('end');
  assert.ok(/对方/.test(endA.reason), 'A 应收到“对方结束了会话”：' + endA.reason);
  assertClean(server, '对端离开后');
  const afterEnd = await request(port, '/api/send', { method: 'POST', json: { cid: a, roomId, payload: randomPayload() } });
  assert.strictEqual(afterEnd.status, 410, '会话结束后再发送应 410');
  console.log('   对端离开即毁（发送 410），房间/队列无残留 ✓');

  // 3.2 队列里的密文引用：y 未接通 SSE 时消息暂存，房间销毁必须一并清除
  const pkQueued = derivePairKey('Q-A-' + crypto.randomBytes(4).toString('hex'), 'Q-B-' + crypto.randomBytes(4).toString('hex'));
  const x = cid();
  const y = cid();
  const X = sse(port, x);
  opened.push(X);
  const rX = await request(port, '/api/enter', { method: 'POST', json: { cid: x, pairKey: pkQueued } });
  assert.strictEqual(rX.json.status, 'waiting');
  const roomQueued = rX.json.roomId;
  // y 只 enter、不建立 SSE：发给它的密文会暂存在队列里
  const rY = await request(port, '/api/enter', { method: 'POST', json: { cid: y, pairKey: pkQueued } });
  assert.strictEqual(rY.json.status, 'connected');
  await X.waitFor('connected');
  const queuedPayload = randomPayload('text');
  const rQueuedSend = await request(port, '/api/send', { method: 'POST', json: { cid: x, roomId: roomQueued, payload: queuedPayload } });
  assert.strictEqual(rQueuedSend.status, 200);
  st = snapshot(server);
  const yEntry = st.clientQueues.find((c) => c.id === y);
  assert.ok(yEntry && yEntry.queue.includes('msg'), 'y 未接通 SSE 时密文应暂存在其队列里');
  console.log('   y 未接通 SSE，密文进入待发队列（验证清理前状态）✓');

  // 发起人离开 → 房间销毁，队列中的密文引用必须一并清除
  await request(port, '/api/leave', { method: 'POST', json: { cid: x, roomId: roomQueued } });
  const endX = await X.waitFor('end');
  assert.ok(/结束了会话/.test(endX.reason), '离开者应收到结束原因：' + endX.reason);
  assertClean(server, '离开后');
  console.log('   房间/pairIndex/roomId/队列密文 全部无残留 ✓');

  // 之后才接通 SSE 的 y：只能收到 end/bound，绝不能收到 msg
  const Y = sse(port, y);
  opened.push(Y);
  await sleep(300);
  assert.strictEqual(Y.countOf('msg'), 0, '房间销毁后不得再投递任何密文');
  const boundY = await Y.waitFor('bound');
  assert.strictEqual(boundY.roomId, null, '房间销毁后 bound 应报告 roomId:null');
  console.log('   销毁后接通 SSE 的对端不会收到任何密文，bound.roomId=null ✓');

  // 同 pairKey 可重新发起（证明 pairIndex 已删除）
  const rX2 = await request(port, '/api/enter', { method: 'POST', json: { cid: x, pairKey: pkQueued } });
  assert.strictEqual(rX2.json.status, 'waiting', '会话结束后相同 pairKey 应可重新发起');
  assert.notStrictEqual(rX2.json.roomId, roomQueued);
  await request(port, '/api/leave', { method: 'POST', json: { cid: x, roomId: rX2.json.roomId } });
  await X.waitFor('end', { reason: (r) => /取消等待/.test(r) });
  assertClean(server, '取消等待后');
  console.log('   销毁后同 pairKey 可重新发起，取消等待后仍无残留 ✓');

  // 3.4 SSE 断开（对方刷新/关闭页面/断网）同样走统一销毁
  const pkDrop = derivePairKey('D-A-' + crypto.randomBytes(4).toString('hex'), 'D-B-' + crypto.randomBytes(4).toString('hex'));
  const g = cid();
  const h = cid();
  const G = sse(port, g);
  opened.push(G);
  const rG = await request(port, '/api/enter', { method: 'POST', json: { cid: g, pairKey: pkDrop } });
  assert.strictEqual(rG.json.status, 'waiting');
  const H = sse(port, h);
  opened.push(H);
  const rH = await request(port, '/api/enter', { method: 'POST', json: { cid: h, pairKey: pkDrop } });
  assert.strictEqual(rH.json.status, 'connected');
  await G.waitFor('connected');
  H.close(); // 模拟对方刷新/关闭页面（SSE 断开）
  const endG = await G.waitFor('end', {}, 6000);
  assert.ok(/断开|离开/.test(endG.reason), 'SSE 断开时对端应收到结束原因：' + endG.reason);
  assertClean(server, 'SSE 断开后');
  console.log('   SSE 断开（刷新/关页）→ 对端收到结束，状态无残留 ✓');

  // ═══════════════ 4. 等待超时 + 端口释放 ═══════════════
  console.log('\n4. 等待超时自动取消；stopChatServer 释放端口（幂等）');
  const timeoutServer = await startChatServer(0, { host: '127.0.0.1', waitTimeoutMs: 500 });
  const timeoutPort = timeoutServer.address().port;
  const k = cid();
  const K = sse(timeoutPort, k);
  opened.push(K);
  const pkTimeout = derivePairKey('T-A-' + crypto.randomBytes(4).toString('hex'), 'T-B-' + crypto.randomBytes(4).toString('hex'));
  const rK = await request(timeoutPort, '/api/enter', { method: 'POST', json: { cid: k, pairKey: pkTimeout } });
  assert.strictEqual(rK.json.status, 'waiting');
  const endK = await K.waitFor('end', {}, 5000);
  assert.ok(/超时|取消/.test(endK.reason), '等待超时应收到取消原因：' + endK.reason);
  assertClean(timeoutServer, '等待超时后');
  const rK2 = await request(timeoutPort, '/api/enter', { method: 'POST', json: { cid: k, pairKey: pkTimeout } });
  assert.strictEqual(rK2.json.status, 'waiting', '等待超时后相同 pairKey 应可重新发起');
  await request(timeoutPort, '/api/leave', { method: 'POST', json: { cid: k, roomId: rK2.json.roomId } });
  await stopChatServer(timeoutServer);
  await stopChatServer(timeoutServer); // 二次调用必须安全
  assert.ok(await waitFor(() => portIsFree(timeoutPort), { label: '超时服务端口释放' }));
  console.log('   超时自动取消 + 同 pairKey 可重发；stopChatServer 后端口 ' + timeoutPort + ' 已释放 ✓');

  // ═══════════════ 5. apply()：/abba/info 与 v2 路由共存 ═══════════════
  console.log('\n5. lib/index.js apply()：/abba/info 契约 + v2 聊天路由共存');
  const fake = makeFakeCtx();
  apply(fake.ctx, { port: 0, host: '127.0.0.1' });
  const web = await startFakeWebServer(fake);
  let chatPort = 0;
  try {
    const runningInfo = await waitFor(async () => {
      const res = await request(web.port, '/abba/info');
      assert.strictEqual(res.status, 200, '/abba/info 必须 200');
      return res.json && res.json.running ? res.json : undefined;
    }, { label: '/abba/info 报告 running:true' });
    chatPort = runningInfo.port;
    assert.ok(Number.isInteger(chatPort) && chatPort > 0, '/abba/info 应报告实际端口');
    assert.deepStrictEqual(
      Object.keys(runningInfo).sort(),
      ['lanUrls', 'localUrl', 'ok', 'port', 'running', 'startedAt', 'version'],
      '/abba/info 运行中 JSON 形状必须与 CONTRACT 3.1 一致',
    );
    assert.strictEqual(runningInfo.localUrl, 'http://127.0.0.1:' + chatPort + '/');
    assert.ok(typeof runningInfo.version === 'string' && runningInfo.version.length > 0);
    const infoRes = await request(web.port, '/abba/info');
    assert.strictEqual(infoRes.headers['content-type'], 'application/json; charset=utf-8');
    assert.strictEqual(infoRes.headers['cache-control'], 'no-store');
    console.log('   /abba/info → ' + JSON.stringify(runningInfo));

    // 同一个聊天实例上 v2 路由与静态路由都可用
    const page = await request(chatPort, '/');
    assert.strictEqual(page.status, 200);
    assert.strictEqual(page.headers['content-type'], 'text/html; charset=utf-8');
    const scriptRoute = await request(chatPort, '/crypto.js');
    assert.ok([200, 404].includes(scriptRoute.status), '/crypto.js 应为 200（文件存在）或 404（缺失）');
    const noKey = await request(chatPort, '/api/enter', { method: 'POST', json: { cid: cid() } });
    assert.strictEqual(noKey.status, 400, 'v2 /api/enter 仍校验 pairKey');
    const pluginCid = cid();
    const pluginEnter = await request(chatPort, '/api/enter', {
      method: 'POST',
      json: { cid: pluginCid, pairKey: derivePairKey('I-A-' + crypto.randomBytes(4).toString('hex'), 'I-B-' + crypto.randomBytes(4).toString('hex')) },
    });
    assert.strictEqual(pluginEnter.json.status, 'waiting');
    await request(chatPort, '/api/leave', { method: 'POST', json: { cid: pluginCid, roomId: pluginEnter.json.roomId } });
    // /abba/info 只在 DSH webserver 上，不在聊天端口
    const infoOnChatPort = await request(chatPort, '/abba/info');
    assert.strictEqual(infoOnChatPort.status, 404, '/abba/info 不应出现在聊天端口');
    console.log('   apply() 启动的实例：/abba/info 与 /、/crypto.js、/api/enter 共存 ✓');
  } finally {
    await fake.dispose();
    await web.close();
  }
  assert.ok(await waitFor(() => portIsFree(chatPort), { label: '插件卸载后聊天端口释放' }));
  console.log('   插件 ctx 清理（ctx.effect disposer）后聊天端口 ' + chatPort + ' 已释放 ✓');

  // ═══════════════ 6. 主服务停止 → 端口释放 ═══════════════
  console.log('\n6. 主服务 stopChatServer → 端口释放');
  await stopChatServer(server);
  mainStopped = true;
  assert.ok(await waitFor(() => portIsFree(port), { label: '主服务端口释放' }));
  console.log('   端口 ' + port + ' 已释放 ✓');
} finally {
  for (const s of opened) {
    try { s.close(); } catch (_) { /* ignore */ }
  }
  if (!mainStopped) await stopChatServer(server);
}

console.log('\n✅ 服务端协议 v2 端到端自检全部通过');
