#!/usr/bin/env node
/**
 * 宿主半端到端自检：node test/host-e2e.mjs
 *
 * 直接启动 lib/server.js 的聊天服务（随机端口），复用 password-chat/test-e2e.js
 * 的 10 项用例并适配 ESM：
 *   发起等待 → 相同组合配对 → 双向收发 → 第三人相同组合被拒
 *   → 缺一个密码被拒 → 错误组合另开新房不会混入 → 一方退出即结束且房间销毁
 *   → 两个框填反也算同一组合 → 刷新/断开即结束 → 等待超时自动取消
 *
 * 另外校验：GET / 返回插件 assets/index.html、SSE 坏 cid 返回 400、未知 API 404。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { startChatServer, stopChatServer } from '../lib/server.js';

const SHORT_WAIT_MS = 1500;

let BASE = '';

const cid = () => crypto.randomBytes(16).toString('hex');

function post(pathname, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request(BASE + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try { resolve({ code: res.statusCode, data: JSON.parse(raw) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + pathname, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: raw }));
    });
    req.on('error', reject);
  });
}

/** 建立 SSE 监听，返回 { events, waitFor(type, extra, ms), close() } */
function sse(id) {
  const events = [];
  let closed = false;
  const req = http.get(BASE + '/events?cid=' + id, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          try { events.push(JSON.parse(line.slice(6))); } catch (_) {}
        }
      }
    });
    res.on('close', () => { closed = true; });
  });
  req.on('error', () => { closed = true; });
  return {
    events,
    async waitFor(type, extra = {}, ms = 4000) {
      const t0 = Date.now();
      for (;;) {
        const hit = events.find((e) =>
          e.type === type &&
          Object.entries(extra).every(([k, v]) =>
            typeof v === 'function' ? v(e[k]) : e[k] === v));
        if (hit) return hit;
        if (Date.now() - t0 > ms) {
          throw new Error('等待事件 ' + type + ' 超时；已收到: ' + JSON.stringify(events));
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    close() { req.destroy(); closed = true; },
  };
}

function step(n, title) {
  console.log(`  ${n}. ${title}`);
}

const server = await startChatServer(0, { host: '127.0.0.1', waitTimeoutMs: SHORT_WAIT_MS });
const actualPort = server.address().port;
BASE = `http://127.0.0.1:${actualPort}`;
console.log(`聊天服务已启动：${BASE}/ (端口 ${actualPort})`);

const opened = [];

try {
  const index = await get('/');
  assert.strictEqual(index.code, 200, 'GET / 应返回 200');
  assert.ok(/text\/html/.test(index.headers['content-type'] || ''), 'GET / 应为 HTML');
  assert.ok(index.body.includes('密码碰头'), 'GET / 应来自 assets/index.html');
  assert.ok(/Cache-Control/i.test(Object.keys(index.headers).join(',')), '应有缓存头');
  const assetBody = readFileSync(new URL('../assets/index.html', import.meta.url), 'utf8');
  assert.strictEqual(index.body, assetBody, 'GET / 的正文应与 assets/index.html 完全一致');
  console.log('  GET / 与 assets/index.html 一致');

  const badEvents = await get('/events?cid=not-a-valid-cid');
  assert.strictEqual(badEvents.code, 400, 'SSE 坏 cid 应返回 400');
  console.log('  SSE 坏 cid → 400');

  const unknownApi = await post('/api/nope', { cid: cid() });
  assert.strictEqual(unknownApi.code, 404, '未知 API 应返回 404');
  console.log('  未知 API → 404');

  const pA = '甲-' + crypto.randomBytes(4).toString('hex'); // A 的密码
  const pB = '乙-' + crypto.randomBytes(4).toString('hex'); // B 的密码
  const a = cid(), b = cid(), c3 = cid(), d2 = cid();

  step(1, 'A 用 (pA, pB) 发起 → 等待');
  const A = sse(a); opened.push(A);
  const r1 = await post('/api/enter', { cid: a, passwordA: pA, passwordB: pB });
  assert.strictEqual(r1.data.ok, true, '发起应成功');
  assert.strictEqual(r1.data.status, 'waiting', '第一人应为等待方');

  step(2, 'B 输入相同组合 → 配对');
  const B = sse(b); opened.push(B);
  const r2 = await post('/api/enter', { cid: b, passwordA: pA, passwordB: pB });
  assert.strictEqual(r2.data.status, 'connected', '相同组合应配对成功');
  await A.waitFor('connected');
  await B.waitFor('connected');

  step(3, '双向收发');
  await post('/api/send', { cid: a, roomId: r1.data.roomId, text: '你好，我是 A' });
  await B.waitFor('msg', { text: '你好，我是 A' });
  await post('/api/send', { cid: b, roomId: r2.data.roomId, text: '我是 B，收到' });
  await A.waitFor('msg', { text: '我是 B，收到' });

  step(4, '第三个人输入相同组合 → 被拒');
  const r3 = await post('/api/enter', { cid: c3, passwordA: pA, passwordB: pB });
  assert.strictEqual(r3.data.ok, false, '第三人应被拒绝');
  console.log('     第三人被拒提示:', r3.data.error);

  step(5, '只填一个密码 → 400');
  const rBad = await post('/api/enter', { cid: c3, passwordA: pA });
  assert.strictEqual(rBad.data.ok, false, '缺少 B 密码应被拒');
  console.log('     缺密码提示:', rBad.data.error);

  step(6, '错误组合（B 密码不对）→ 另开新等待房，不会混入 A、B 的会话');
  const rWrong = await post('/api/enter', { cid: c3, passwordA: pA, passwordB: '不对-' + crypto.randomBytes(4).toString('hex') });
  assert.strictEqual(rWrong.data.status, 'waiting', '错误组合应是新房间');
  assert.notStrictEqual(rWrong.data.roomId, r1.data.roomId, '不得混入进行中的会话');
  await post('/api/leave', { cid: c3, roomId: rWrong.data.roomId });

  step(7, 'B 退出 → 会话结束，A 收到"对方已退出"');
  await post('/api/leave', { cid: b, roomId: r2.data.roomId });
  const endA = await A.waitFor('end');
  assert.ok(/对方/.test(endA.reason), 'A 应收到"对方已退出": ' + endA.reason);

  step(8, '房间销毁后可重新发起；两个框填反也算同一组合，仍能配上');
  const E = sse(d2); opened.push(E);
  const r5 = await post('/api/enter', { cid: d2, passwordA: pA, passwordB: pB });
  assert.strictEqual(r5.data.status, 'waiting', '会话结束后同组合应可重新发起');
  const f2 = cid();
  const F = sse(f2); opened.push(F);
  const r6 = await post('/api/enter', { cid: f2, passwordA: pB, passwordB: pA }); // 填反
  assert.strictEqual(r6.data.status, 'connected', '填反两个框也应配对');
  await E.waitFor('connected');
  await F.waitFor('connected');
  await post('/api/leave', { cid: f2, roomId: r6.data.roomId });
  await post('/api/leave', { cid: d2, roomId: r5.data.roomId });

  step(9, '刷新/断开连接也会结束会话');
  const qA = '丙-' + crypto.randomBytes(4).toString('hex');
  const qB = '丁-' + crypto.randomBytes(4).toString('hex');
  const g = cid(), h = cid();
  const G = sse(g); opened.push(G);
  await post('/api/enter', { cid: g, passwordA: qA, passwordB: qB });
  const H = sse(h); opened.push(H);
  await post('/api/enter', { cid: h, passwordA: qA, passwordB: qB });
  await G.waitFor('connected');
  H.close(); // 模拟对方直接关闭页面
  const endG = await G.waitFor('end', {}, 5000);
  assert.ok(/断开|关闭/.test(endG.reason), '断开方对端应收到结束原因: ' + endG.reason);

  step(10, '等待超时自动取消（短等待时长）');
  const wA = '戊-' + crypto.randomBytes(4).toString('hex');
  const wB = '己-' + crypto.randomBytes(4).toString('hex');
  const k = cid();
  const K = sse(k); opened.push(K);
  const r7 = await post('/api/enter', { cid: k, passwordA: wA, passwordB: wB });
  assert.strictEqual(r7.data.status, 'waiting');
  const endK = await K.waitFor('end', {}, 4000);
  assert.ok(/超时|取消/.test(endK.reason), '超时原因: ' + endK.reason);
  console.log('     等待超时用例: 通过');

  console.log('✅ 宿主半端到端自检全部通过');
} finally {
  for (const s of opened) {
    try { s.close(); } catch (_) {}
  }
  await stopChatServer(server);
}
