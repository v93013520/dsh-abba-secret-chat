#!/usr/bin/env node
/**
 * 宿主半契约自检：node test/host-info.mjs
 *
 * 用真实 http 承载一个假的 Cordis ctx（webServer / commands / effect），直接调用
 * `lib/index.js` 的 `apply()`，逐条验证 CONTRACT 第 3 节：
 *   1. GET /abba/info 的 JSON 形状、状态码与响应头（运行中 / 已停止都 200）。
 *   2. 端口回退：首选端口被占 → port+1；port…port+9 全被占 → port:0 由系统分配。
 *   3. 启动失败只 warn 不 throw（绑定不可用地址），并在 /abba/info 报 running:false。
 *   4. /abba 命令：无参 / status / stop / 纯数字换端口重启，以及非法输入提示。
 *   5. stop 与插件卸载（效果清理）后端口释放，路由被移除。
 */
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const { apply } = await import('../lib/index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 5000, intervalMs = 50, label = '条件' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待${label}超时`);
    await sleep(intervalMs);
  }
}

/** 监听一个 net server，返回 { port, close }。 */
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

/** 该端口现在是否能被绑定（即已释放）。 */
async function portIsFree(port) {
  try {
    const blocker = await listenNet(port);
    await blocker.close();
    return true;
  } catch (_) {
    return false;
  }
}

/** 找一个空闲的连续端口段 [base, base+count-1]。 */
async function findFreePortRange(count, startHint = 41700) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const base = startHint + attempt * 50;
    const blockers = [];
    let ok = true;
    for (let i = 0; i < count; i += 1) {
      try {
        blockers.push(await listenNet(base + i));
      } catch (_) {
        ok = false;
        break;
      }
    }
    if (ok) return { base, blockers };
    for (const b of blockers) await b.close();
  }
  throw new Error('找不到可用的连续端口段');
}

/** 一个最小的假 Cordis 上下文：webServer / commands / effect / inject / logger。 */
function makeFakeCtx() {
  const routes = new Map();
  const commands = new Map();
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
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    commands: {
      register(definition) {
        if (commands.has(definition.name)) throw new Error(`duplicate command ${definition.name}`);
        commands.set(definition.name, definition);
        return () => commands.delete(definition.name);
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
    commands,
    logs,
    async dispose() {
      while (disposers.length > 0) {
        const disposer = disposers.pop();
        try { await disposer(); } catch (_) { /* 清理失败不影响断言 */ }
      }
    },
  };
}

/** 把假 ctx 的路由挂到一个真实 http server 上（exact pathname 匹配）。 */
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
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

function request(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function info(webPort) {
  const res = await request(webPort, '/abba/info');
  assert.strictEqual(res.status, 200, '/abba/info 必须返回 200（含未运行状态）');
  return { res, json: JSON.parse(res.body) };
}

async function runCommand(fake, rawInput) {
  const definition = fake.commands.get('abba');
  assert.ok(definition, '/abba 命令应已注册');
  return definition.handler({ rawInput, agent: null, attachments: [] });
}

// ─────────────────────────── 用例 1：形状 / 回退 / 生命周期 ───────────────────────────
console.log('1. /abba/info 形状、端口回退与生命周期');

const range = await findFreePortRange(2);
const basePort = range.base;
// blockers[0] = 占住首选端口；blockers[1] 留着（只用来证明端口段可用，随后释放）
const blocker = range.blockers[0];
await range.blockers[1].close();

const fake = makeFakeCtx();
const pluginCfg = { port: basePort, host: '127.0.0.1' };
apply(fake.ctx, pluginCfg);

const web = await startFakeWebServer(fake);
try {
  const runningInfo = await waitFor(async () => {
    const { json } = await info(web.port);
    return json.running ? json : undefined;
  }, { label: '聊天服务启动' });

  assert.strictEqual(runningInfo.ok, true);
  assert.strictEqual(runningInfo.port, basePort + 1, '首选端口被占用后应回退到 port+1');
  assert.strictEqual(runningInfo.localUrl, `http://127.0.0.1:${basePort + 1}/`);
  assert.deepStrictEqual(runningInfo.lanUrls, [], '绑定 127.0.0.1 时不应展示局域网地址');
  assert.strictEqual(
    runningInfo.version,
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  );
  assert.ok(Number.isInteger(runningInfo.startedAt) && runningInfo.startedAt > 0, 'startedAt 应为毫秒时间戳');
  assert.deepStrictEqual(
    Object.keys(runningInfo).sort(),
    ['lanUrls', 'localUrl', 'ok', 'port', 'running', 'startedAt', 'version'],
    '运行中 JSON 形状必须与 CONTRACT 3.1 一致',
  );
  const infoRes = (await info(web.port)).res;
  assert.strictEqual(infoRes.headers['content-type'], 'application/json; charset=utf-8');
  assert.strictEqual(infoRes.headers['cache-control'], 'no-store');
  console.log(`   /abba/info（运行中）: ${JSON.stringify(runningInfo)}`);

  // 真实聊天页可从 localUrl 打开
  const page = await request(basePort + 1, '/');
  assert.strictEqual(page.status, 200);
  assert.ok(page.body.includes('密码碰头'));
  console.log('   聊天页 localUrl 可访问，返回 assets/index.html');

  // HEAD / 非 GET
  const head = await request(web.port, '/abba/info', 'HEAD');
  assert.strictEqual(head.status, 200);
  assert.strictEqual(head.body, '');
  const post = await request(web.port, '/abba/info', 'POST');
  assert.strictEqual(post.status, 405);
  console.log('   HEAD → 200 空正文；POST → 405');

  // /abba 命令（无参 / status / 非法输入）
  const noArg = await runCommand(fake, '');
  assert.strictEqual(noArg.kind, 'success');
  assert.ok(noArg.text.includes(`http://127.0.0.1:${basePort + 1}/`), '无参文本应含 localUrl');
  assert.ok(noArg.text.includes('点击左侧栏底部的「秘密对话」按钮'), '无参文本应含入口指引');
  const status = await runCommand(fake, 'status');
  assert.strictEqual(status.kind, 'success');
  assert.ok(status.text.includes('运行中'));
  const bad = await runCommand(fake, 'bogus');
  assert.strictEqual(bad.kind, 'error');
  console.log('   /abba 命令：无参 / status / 非法输入 均符合契约');

  // /abba stop → running:false，端口释放，/abba/info 仍 200
  const stopped = await runCommand(fake, 'stop');
  assert.strictEqual(stopped.kind, 'success');
  const afterStop = await waitFor(async () => {
    const { json } = await info(web.port);
    return json.running ? undefined : json;
  }, { label: '服务停止' });
  assert.strictEqual(afterStop.ok, true);
  assert.strictEqual(afterStop.running, false);
  assert.strictEqual(afterStop.port, basePort, '未运行时 port 报配置端口');
  assert.deepStrictEqual(afterStop.lanUrls, []);
  assert.ok(typeof afterStop.error === 'string' && afterStop.error.length > 0, '未运行时应带 error 原因');
  assert.ok(!('startedAt' in afterStop), '未运行时不应有 startedAt');
  assert.ok(await portIsFree(basePort + 1), 'stop 后聊天端口必须释放');
  console.log(`   stop 后 /abba/info: ${JSON.stringify(afterStop)}；端口 ${basePort + 1} 已释放`);

  // /abba <port> → 换端口重启
  const freeAgain = await listenNet(0);
  const newPort = freeAgain.port;
  await freeAgain.close();
  const restarted = await runCommand(fake, String(newPort));
  assert.strictEqual(restarted.kind, 'success', '数字参数应重启成功: ' + restarted.text);
  const afterRestart = await waitFor(async () => {
    const { json } = await info(web.port);
    return json.running ? json : undefined;
  }, { label: '换端口重启' });
  assert.strictEqual(afterRestart.port, newPort);
  assert.strictEqual(afterRestart.localUrl, `http://127.0.0.1:${newPort}/`);
  assert.ok(await portIsFree(newPort) === false, '重启后新端口应被占用');
  console.log(`   /abba ${newPort} 重启成功：${afterRestart.localUrl}`);
} finally {
  await fake.dispose();
  await web.close();
  await blocker.close();
}

const disposedOk = await waitFor(async () => (await portIsFree(basePort + 1)), { label: '插件卸载后端口释放' });
assert.ok(disposedOk, '插件卸载后聊天端口必须释放');
assert.ok(await portIsFree(basePort), '配置端口（blocker 释放后）应可用');
console.log('   插件 ctx 清理后端口释放 ✓');

// ─────────────────────────── 用例 2：全占用 → port 0 ───────────────────────────
console.log('\n2. port…port+9 全被占用 → 交给系统分配（port: 0）');

const tenRange = await findFreePortRange(10, 43100);
try {
  const fake2 = makeFakeCtx();
  apply(fake2.ctx, { port: tenRange.base, host: '127.0.0.1' });
  const web2 = await startFakeWebServer(fake2);
  try {
    const info2 = await waitFor(async () => {
      const { json } = await info(web2.port);
      return json.running ? json : undefined;
    }, { label: '系统分配端口启动' });
    assert.ok(info2.port > 0, '系统分配端口必须体现在 /abba/info');
    assert.ok(
      info2.port < tenRange.base || info2.port > tenRange.base + 9,
      `回退失败后应使用 port:0，实际端口 ${info2.port} 不应落在 ${tenRange.base}..${tenRange.base + 9}`,
    );
    assert.strictEqual(info2.localUrl, `http://127.0.0.1:${info2.port}/`);
    const page2 = await request(info2.port, '/');
    assert.strictEqual(page2.status, 200);
    console.log(`   首选 10 个端口均被占 → 系统分配 ${info2.port}，聊天页可访问`);
  } finally {
    await fake2.dispose();
    await web2.close();
  }
} finally {
  for (const b of tenRange.blockers) await b.close();
}

// ─────────────────────────── 用例 3：启动失败只 warn 不 throw ───────────────────────────
console.log('\n3. 绑定失败：只 warn 不 throw，/abba/info 报 running:false');

const fake3 = makeFakeCtx();
let threwDuringApply = false;
try {
  apply(fake3.ctx, { port: 43999, host: '203.0.113.1' }); // TEST-NET-3，本机不可绑定
} catch (_) {
  threwDuringApply = true;
}
assert.strictEqual(threwDuringApply, false, 'apply() 不得因启动失败而 throw');

const web3 = await startFakeWebServer(fake3);
try {
  const failedInfo = await waitFor(async () => {
    const { json } = await info(web3.port);
    return json.running === false && typeof json.error === 'string' ? json : undefined;
  }, { label: '启动失败状态' });
  assert.strictEqual(failedInfo.ok, true);
  assert.strictEqual(failedInfo.running, false);
  assert.strictEqual(failedInfo.port, 43999, '未运行时 port 报配置端口');
  assert.deepStrictEqual(failedInfo.lanUrls, []);
  assert.ok(failedInfo.error.length > 0);
  await waitFor(() => fake3.logs.warn.length > 0, { label: '启动失败 warn 日志' });
  console.log(`   启动失败 → /abba/info: ${JSON.stringify(failedInfo)}`);
  console.log(`   logger.warn: ${fake3.logs.warn[0]}`);
} finally {
  await fake3.dispose();
  await web3.close();
}

console.log('\n✅ 宿主半契约自检全部通过');
