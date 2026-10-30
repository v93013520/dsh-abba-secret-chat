#!/usr/bin/env node
/**
 * test/crypto-unit.mjs
 * ---------------------------------------------------------------------------
 * Node-only unit + interop test for the 0.2.0 encryption layer
 * (`assets/abba-crypto.js` over vendored `assets/crypto-js.min.js`).
 *
 * Covers CONTRACT-V2.md §1 (key derivation, payload format, encrypt-then-MAC)
 * and §5.1 (roundtrip, wrong-password rejection, tamper rejection, Node `crypto`
 * interop, fill-in-reverse pairKey equivalence).
 *
 * Run:   node test/crypto-unit.mjs
 * Deps:  none (node: builtins + the vendored bundle; no node_modules needed).
 *
 * Loading note: the package is `"type": "module"` and `assets/abba-crypto.js` is a
 * UMD file meant to be evaluated as a classic script (browser -> window.AbbaCrypto)
 * or a CommonJS module (Node -> module.exports). It is therefore evaluated inside
 * `vm` contexts here: one providing `module`/`exports`/`require` (CommonJS branch)
 * and one plain global context (browser branch, with a getRandomValues-only crypto
 * object to prove crypto.subtle is never required - plain-http LAN pages are not
 * secure contexts, so subtle is unavailable there).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes as nodeRandomBytes,
  timingSafeEqual
} from 'node:crypto';

/* ------------------------------------------------------------------------- *
 * 0. Harness
 * ------------------------------------------------------------------------- */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VENDOR_PATH = path.join(ROOT, 'assets', 'crypto-js.min.js');
const WRAPPER_PATH = path.join(ROOT, 'assets', 'abba-crypto.js');

const vendorSource = readFileSync(VENDOR_PATH, 'utf8');
const wrapperSource = readFileSync(WRAPPER_PATH, 'utf8');

let checkCount = 0;
const failures = [];
let sectionName = '';

function beginSection(name) {
  sectionName = name;
  console.log('\n## ' + name);
}

function ok(cond, label) {
  checkCount++;
  if (!cond) {
    const where = sectionName ? '[' + sectionName + '] ' : '';
    failures.push(where + label);
    console.log('  FAIL  ' + where + label);
  }
}

function fmt(v) {
  if (typeof v === 'string') {
    return JSON.stringify(v.length > 60 ? v.slice(0, 57) + '...' : v);
  }
  if (v instanceof Error) return v.name + ': ' + v.message;
  try { return String(v); } catch (e) { return '<unprintable>'; }
}

function eq(actual, expected, label) {
  ok(Object.is(actual, expected), label + '  [expected ' + fmt(expected) + ', got ' + fmt(actual) + ']');
}

function neq(actual, unexpected, label) {
  ok(!Object.is(actual, unexpected), label + '  [value must differ from ' + fmt(unexpected) + ']');
}

const toTag = Object.prototype.toString;

function isBytes(x) {
  const t = toTag.call(x);
  return t === '[object Uint8Array]' || t === '[object Uint8ClampedArray]';
}

/** Copy any Uint8Array/ArrayBuffer (possibly from a vm realm) into this realm. */
function toBytes(x) {
  const t = toTag.call(x);
  if (t === '[object Uint8Array]' || t === '[object Uint8ClampedArray]') {
    const tag = toTag.call(x);
    if (tag === '[object Uint8ClampedArray]') { return Uint8Array.from(x); }
    const out = new Uint8Array(x.length);
    out.set(x);
    return out;
  }
  if (t === '[object ArrayBuffer]') {
    const out = new Uint8Array(x.byteLength);
    out.set(new Uint8Array(x));
    return out;
  }
  throw new Error('toBytes: unsupported byte container: ' + t);
}

function bytesEqual(a, b) {
  if (!isBytes(a) || !isBytes(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
  return true;
}

function eqBytes(actual, expected, label) {
  const a = isBytes(actual) ? toBytes(actual) : null;
  const b = isBytes(expected) ? toBytes(expected) : null;
  if (!a || !b) {
    ok(false, label + '  [not byte containers: ' + fmt(actual) + ' / ' + fmt(expected) + ']');
    return;
  }
  let firstDiff = -1;
  if (a.length === b.length) {
    for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { firstDiff = i; break; } }
  }
  ok(a.length === b.length && firstDiff === -1,
    label + '  [length ' + a.length + ' vs ' + b.length +
    (firstDiff >= 0 ? ', first diff at ' + firstDiff : '') + ']');
}

function hexOf(x) {
  if (x instanceof Error) return x;
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object' && Array.isArray(x.words)) {
    return CryptoJS.enc.Hex.stringify(x);
  }
  return String(x);
}

function eqKey(wa, nodeBuffer, label) {
  const hex = hexOf(wa);
  ok(typeof hex === 'string' && /^[0-9a-f]+$/.test(hex), label + ' is a hex WordArray');
  eq(hex, Buffer.from(nodeBuffer).toString('hex'), label + ' matches Node crypto.pbkdf2Sync');
}

/** Expect fn() to throw; optionally require err.code. Returns the error. */
function throws(fn, code, label) {
  checkCount++;
  try {
    const ret = fn();
    failures.push((sectionName ? '[' + sectionName + '] ' : '') + label +
      '  [expected throw' + (code ? ' ' + code : '') + ', returned ' + fmt(ret) + ']');
    console.log('  FAIL  ' + label + '  (did not throw, returned ' + fmt(ret) + ')');
    return null;
  } catch (err) {
    if (code && (!err || err.code !== code)) {
      failures.push((sectionName ? '[' + sectionName + '] ' : '') + label +
        '  [expected code ' + code + ', got ' + (err && err.code) + ': ' + (err && err.message) + ']');
      console.log('  FAIL  ' + label + '  (expected ' + code + ', got ' + (err && err.code) + ')');
      return err;
    }
    return err;
  }
}

function timeMs(fn, iterations = 1) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6 / iterations;
}

/** Deterministic pseudo-random bytes for reproducible fixtures (NOT for crypto). */
function pseudoBytes(n, seed) {
  const out = new Uint8Array(n);
  let s = (seed >>> 0) || 0x9e3779b9;
  for (let i = 0; i < n; i++) {
    s ^= (s << 13); s >>>= 0;
    s ^= (s >>> 17); s >>>= 0;
    s ^= (s << 5); s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isNoStoreAscii(json) {
  return typeof json === 'string' && /^[\x20-\x7e]*$/.test(json);
}

/* ------------------------------------------------------------------------- *
 * 1. Load the vendored crypto-js and the wrapper (both UMD branches)
 * ------------------------------------------------------------------------- */

function loadCryptoJS() {
  const sandbox = { module: { exports: {} }, exports: {} };
  const ctx = createContext(sandbox);
  runInContext(vendorSource, ctx, { filename: 'assets/crypto-js.min.js' });
  return sandbox.module.exports;
}

const CryptoJS = loadCryptoJS();

const nodeCryptoForStub = { randomBytes: nodeRandomBytes };

/** CommonJS branch: module.exports = ... */
function loadWrapperCommonJS() {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require(id) {
      if (id === './crypto-js.min.js' || id === 'crypto-js' ||
        String(id).endsWith('/crypto-js.min.js')) {
        return CryptoJS;
      }
      if (id === 'crypto' || id === 'node:crypto') { return nodeCryptoForStub; }
      throw new Error('unexpected require(' + id + ')');
    }
  };
  const ctx = createContext(sandbox);
  runInContext(wrapperSource, ctx, { filename: 'assets/abba-crypto.js' });
  return sandbox.module.exports;
}

/**
 * Browser branch: window.AbbaCrypto = ... (UMD global).
 * `cryptoProvider` is the global `crypto` object the page would have. When omitted
 * the page has no crypto global at all (used to test the no-RNG guard).
 * The vendor global can be injected via `vendorFirst` (script order vendor -> wrapper)
 * or by assigning `sandbox.CryptoJS` after construction (script order wrapper -> vendor).
 */
function loadWrapperBrowser(opts = {}) {
  const sandbox = {};
  if (opts.cryptoProvider) { sandbox.crypto = opts.cryptoProvider; }
  if (opts.vendorFirst) { sandbox.CryptoJS = CryptoJS; }
  const ctx = createContext(sandbox);
  runInContext(wrapperSource, ctx, { filename: 'assets/abba-crypto.js' });
  return { api: sandbox.AbbaCrypto, sandbox };
}

const fakeGetRandomValues = {
  getRandomValues(arr) {
    const b = nodeRandomBytes(arr.length);
    for (let i = 0; i < arr.length; i++) arr[i] = b[i];
    return arr;
  }
};

const api = loadWrapperCommonJS();
const browser = loadWrapperBrowser({ vendorFirst: true, cryptoProvider: fakeGetRandomValues });

/* ------------------------------------------------------------------------- *
 * 2. Node `crypto` independent implementation of the same algorithm
 * ------------------------------------------------------------------------- */

const SALT_ENC = 'dsh-abba-secret-chat/v1';
const SALT_MAC = 'dsh-abba-secret-chat/v1/mac';

function nodeDerive(passwordA, passwordB) {
  const hA = createHash('sha256').update(passwordA, 'utf8').digest('hex');
  const hB = createHash('sha256').update(passwordB, 'utf8').digest('hex');
  const [hx, hy] = hA <= hB ? [hA, hB] : [hB, hA];
  const encPass = hx + '|' + hy;
  return {
    hA, hB, hx, hy, encPass,
    pairKey: createHash('sha256').update(hx + '|' + hy, 'utf8').digest('hex'),
    encKey: pbkdf2Sync(encPass, SALT_ENC, 10000, 32, 'sha256'),
    macKey: pbkdf2Sync(encPass, SALT_MAC, 10000, 32, 'sha256')
  };
}

/** Node-side encrypt of raw plaintext bytes -> wire JSON (independent impl). */
function nodeEncrypt(kind, plaintext, keys) {
  const iv = nodeRandomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', keys.encKey, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const mac = createHmac('sha256', keys.macKey)
    .update(Buffer.concat([iv, ct])).digest();
  return JSON.stringify({
    k: kind,
    v: 1,
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    mac: mac.toString('base64')
  });
}

/** Node-side decrypt/verify a wrapper payload -> raw plaintext Buffer. */
function nodeDecrypt(payloadString, keys) {
  const p = JSON.parse(payloadString);
  if (p.v !== 1) throw new Error('nodeDecrypt: bad v');
  const iv = Buffer.from(p.iv, 'base64');
  const ct = Buffer.from(p.ct, 'base64');
  const mac = Buffer.from(p.mac, 'base64');
  const expected = createHmac('sha256', keys.macKey)
    .update(Buffer.concat([iv, ct])).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    throw new Error('nodeDecrypt: MAC mismatch');
  }
  const decipher = createDecipheriv('aes-256-cbc', keys.encKey, iv);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function nodeDecryptText(payloadString, keys) {
  return nodeDecrypt(payloadString, keys).toString('utf8');
}

/* Payload shape assertions for the wire JSON. */
function assertWireShape(json, expectedKind, label) {
  let obj;
  try { obj = JSON.parse(json); } catch (e) {
    ok(false, label + ': payload is valid JSON');
    return null;
  }
  eq(Object.keys(obj).sort().join(','), 'ct,iv,k,mac,v', label + ': exact wire keys {k,v,iv,ct,mac}');
  eq(obj.k, expectedKind, label + ': k');
  eq(obj.v, 1, label + ': v');
  ok(typeof obj.iv === 'string' && BASE64_RE.test(obj.iv), label + ': iv is strict base64');
  ok(typeof obj.ct === 'string' && BASE64_RE.test(obj.ct), label + ': ct is strict base64');
  ok(typeof obj.mac === 'string' && BASE64_RE.test(obj.mac), label + ': mac is strict base64');
  const ivBytes = Buffer.from(obj.iv || '', 'base64');
  const ctBytes = Buffer.from(obj.ct || '', 'base64');
  const macBytes = Buffer.from(obj.mac || '', 'base64');
  eq(ivBytes.length, 16, label + ': iv decodes to 16 bytes');
  eq(macBytes.length, 32, label + ': mac decodes to 32 bytes');
  ok(ctBytes.length > 0 && ctBytes.length % 16 === 0,
    label + ': ct decodes to a non-empty multiple of 16 bytes');
  ok(isNoStoreAscii(json), label + ': wire JSON is pure ASCII (no plaintext leakage surface)');
  return obj;
}

/* ========================================================================= *
 * Tests
 * ========================================================================= */

const PWA = 'correct horse battery staple A';
const PWB = '第二个密码-B-2026-秘密';
const PWC = 'not-the-right-password';

const keys = api.deriveKeys(PWA, PWB);
const nodeKeys = nodeDerive(PWA, PWB);

beginSection('UMD loading (CommonJS + browser global)');

eq(typeof api, 'object', 'CommonJS load gives an API object (module.exports)');
eq(typeof api.deriveKeys, 'function', 'module.exports.deriveKeys');
eq(typeof api.encrypt, 'function', 'module.exports.encrypt');
eq(typeof api.decrypt, 'function', 'module.exports.decrypt');
eq(api.VERSION, '0.2.0', 'API VERSION');
eq(api.PROTOCOL_VERSION, 1, 'PROTOCOL_VERSION');
eq(api.MAX_PLAINTEXT_BYTES, 2 * 1024 * 1024, 'MAX_PLAINTEXT_BYTES guard');
eq(api.isReady(), true, 'isReady() true when vendored crypto-js is loadable');

eq(typeof browser.api, 'object', 'browser branch sets window.AbbaCrypto (global)');
eq(typeof browser.api.deriveKeys, 'function', 'browser AbbaCrypto.deriveKeys');
const browserKeys = browser.api.deriveKeys(PWA, PWB);
eq(browserKeys.pairKey, keys.pairKey, 'browser and CommonJS builds derive the same pairKey');

// Load order: /crypto.js may run before /vendor/crypto-js.js; resolution is lazy.
const late = loadWrapperBrowser({ cryptoProvider: fakeGetRandomValues });
eq(typeof late.api.isReady, 'function', 'wrapper evaluates before crypto-js vendor script');
eq(late.api.isReady(), false, 'isReady() false before the vendor script arrives');
late.sandbox.CryptoJS = CryptoJS; // simulate the /vendor/crypto-js.js <script> arriving
eq(late.api.isReady(), true, 'after vendor script arrives, lazy resolution works');
eq(late.api.deriveKeys(PWA, PWB).pairKey, keys.pairKey, 'late-loaded vendor derives the same pairKey');

const noVendor = loadWrapperBrowser({ cryptoProvider: fakeGetRandomValues });
throws(() => noVendor.api.deriveKeys(PWA, PWB), 'ABBA_VENDOR_MISSING',
  'clear error when /vendor/crypto-js.js never loads');
eq(noVendor.api.isReady(), false, 'isReady() false without vendor');

// CONTRACT: must not rely on crypto.subtle (unavailable on plain-http LAN origins).
// Comments are stripped first so the doc/header mentions do not count as usage.
const wrapperCode = wrapperSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
ok(!/\.subtle\s*[.(]/.test(wrapperCode), 'wrapper code never calls crypto.subtle');
ok(!/\bwindow\.[A-Za-z_$]/.test(wrapperCode), 'wrapper code does not hard-require window.* (uses globalThis)');
ok(!/\bMath\.random\s*\(/.test(wrapperCode), 'wrapper code never uses Math.random for the IV');

beginSection('deriveKeys vs independent Node crypto implementation');

eq(typeof keys.pairKey, 'string', 'pairKey is a string');
ok(/^[0-9a-f]{64}$/.test(keys.pairKey), 'pairKey is 64 lowercase hex chars');
eq(keys.pairKey, nodeKeys.pairKey, 'pairKey = hex(SHA256(hx+"|"+hy)) matches Node');
eqKey(keys.encKey, nodeKeys.encKey, 'encKey = PBKDF2(encPass, ".../v1", 10000, 32)');
eqKey(keys.macKey, nodeKeys.macKey, 'macKey = PBKDF2(encPass, ".../v1/mac", 10000, 32)');
eq(Object.keys(keys).sort().join(','), 'encKey,macKey,pairKey',
  'deriveKeys returns exactly {pairKey, encKey, macKey} (no plaintext/hash leakage)');

// Fill-in-reverse equivalence.
const reversed = api.deriveKeys(PWB, PWA);
eq(reversed.pairKey, keys.pairKey, 'A/B filled in reverse -> identical pairKey');
eq(hexOf(reversed.encKey), hexOf(keys.encKey), 'A/B filled in reverse -> identical encKey');
eq(hexOf(reversed.macKey), hexOf(keys.macKey), 'A/B filled in reverse -> identical macKey');

// Different passwords -> different pairKey / keys.
const otherKeys = api.deriveKeys(PWA, PWC);
neq(otherKeys.pairKey, keys.pairKey, 'different password pair -> different pairKey');
neq(hexOf(otherKeys.encKey), hexOf(keys.encKey), 'different password pair -> different encKey');

// Unicode + page-length boundaries (page validates 4..128 chars; crypto must match).
const unicodeKeys = api.deriveKeys('密码🔑甲乙', 'abcd');
const unicodeNode = nodeDerive('密码🔑甲乙', 'abcd');
eq(unicodeKeys.pairKey, unicodeNode.pairKey, 'Unicode/emoji passwords derive the same pairKey as Node');
eqKey(unicodeKeys.encKey, unicodeNode.encKey, 'Unicode passwords: encKey matches Node');
const longPw = 'x'.repeat(128);
const lenKeys = api.deriveKeys('a'.repeat(4), longPw);
const lenNode = nodeDerive('a'.repeat(4), longPw);
eq(lenKeys.pairKey, lenNode.pairKey, '4-char and 128-char passwords derive the same pairKey as Node');
throws(() => api.deriveKeys('', PWB), 'ABBA_BAD_INPUT', 'empty password rejected');
throws(() => api.deriveKeys(123, PWB), 'ABBA_BAD_INPUT', 'non-string password rejected');

beginSection('text roundtrip (UTF-8, padding boundaries)');

const textFixtures = [
  '',
  'a',
  'hello world',
  '中文测试：你好，世界！',
  'emoji 😀🔒🚀 and accents éàü',
  'line1\nline2\tend',
  '{"looks":"like json"}',
  'x'.repeat(15),
  'x'.repeat(16),
  'x'.repeat(17),
  'x'.repeat(31),
  'x'.repeat(32),
  'x'.repeat(33),
  'x'.repeat(255),
  'x'.repeat(256),
  'x'.repeat(4096)
];

for (const text of textFixtures) {
  const label = 'text len=' + (text.length > 20 ? 'n=' + text.length : JSON.stringify(text));
  const json = api.encrypt({ k: 'text', text }, keys.encKey, keys.macKey);
  eq(typeof json, 'string', label + ': encrypt returns a JSON string');
  assertWireShape(json, 'text', label);
  const out = api.decrypt(json, keys.encKey, keys.macKey);
  eq(out.k, 'text', label + ': decrypt k');
  eq(out.v, 1, label + ': decrypt v');
  eq(out.text, text, label + ': plaintext roundtrips exactly');
}

// Random IV: same plaintext must never produce the same wire payload.
const rtA = api.encrypt({ k: 'text', text: 'same plaintext' }, keys.encKey, keys.macKey);
const rtB = api.encrypt({ k: 'text', text: 'same plaintext' }, keys.encKey, keys.macKey);
neq(JSON.parse(rtA).iv, JSON.parse(rtB).iv, 'random 16-byte IV differs per message');
neq(rtA, rtB, 'same plaintext encrypts to different payloads');
eq(api.decrypt(rtA, keys.encKey, keys.macKey).text, 'same plaintext', 'both payloads decrypt');
eq(api.decrypt(rtB, keys.encKey, keys.macKey).text, 'same plaintext', 'both payloads decrypt (2)');

// Explicit v:1 in the plaintext object is accepted and forced to 1.
const explicitV = api.encrypt({ k: 'text', v: 1, text: 'with v' }, keys.encKey, keys.macKey);
eq(JSON.parse(explicitV).v, 1, 'plaintext object v:1 accepted, wire v stays 1');
eq(api.decrypt(explicitV, keys.encKey, keys.macKey).text, 'with v', 'payload with explicit v roundtrips');

// `k` omitted is inferred from the presence of `text`.
const inferred = api.encrypt({ text: 'inferred kind' }, keys.encKey, keys.macKey);
eq(JSON.parse(inferred).k, 'text', 'k inferred as text when omitted');
eq(api.decrypt(inferred, keys.encKey, keys.macKey).text, 'inferred kind', 'inferred-kind payload roundtrips');

beginSection('image roundtrip (compressed JPEG bytes)');

const imageFixtures = [
  { name: '1 byte', bytes: pseudoBytes(1, 1) },
  { name: '16 bytes', bytes: pseudoBytes(16, 2) },
  { name: '1 KiB', bytes: pseudoBytes(1024, 3) },
  { name: '600 KiB (UI compression cap)', bytes: pseudoBytes(600 * 1024, 4) }
];

for (const { name, bytes } of imageFixtures) {
  const label = 'image ' + name;
  const json = api.encrypt({ k: 'image', bytes }, keys.encKey, keys.macKey);
  const wire = assertWireShape(json, 'image', label);
  ok(json.length < 2.5 * 1024 * 1024, label + ': wire payload under 2.5 MiB (' + json.length + ' bytes)');
  const out = api.decrypt(json, keys.encKey, keys.macKey);
  eq(out.k, 'image', label + ': decrypt k');
  eq(out.v, 1, label + ': decrypt v');
  eqBytes(out.bytes, bytes, label + ': bytes roundtrip exactly');
  ok(typeof out.dataURL === 'string' && out.dataURL.indexOf('data:image/jpeg;base64,') === 0,
    label + ': decrypt returns an image data URL for <img>.src');
  eqBytes(api.dataURLToBytes(out.dataURL), bytes, label + ': dataURL decodes back to the same bytes');
  ok(wire && typeof wire.ct === 'string', label + ': ct carries the encrypted image bytes');
}

// Accepted input aliases / containers.
const imgBytes = pseudoBytes(2048, 5);
const viaAliasData = api.encrypt({ k: 'image', data: imgBytes }, keys.encKey, keys.macKey);
eqBytes(api.decrypt(viaAliasData, keys.encKey, keys.macKey).bytes, imgBytes, 'alias "data" accepted for image bytes');

const viaAliasDataURL = api.encrypt(
  { k: 'image', dataURL: api.bytesToDataURL(imgBytes, 'image/jpeg') },
  keys.encKey, keys.macKey
);
eqBytes(api.decrypt(viaAliasDataURL, keys.encKey, keys.macKey).bytes, imgBytes, 'alias "dataURL" accepted for image bytes');

const arrayBuffer = imgBytes.buffer.slice(imgBytes.byteOffset, imgBytes.byteOffset + imgBytes.byteLength);
const viaArrayBuffer = api.encrypt({ k: 'image', bytes: arrayBuffer }, keys.encKey, keys.macKey);
eqBytes(api.decrypt(viaArrayBuffer, keys.encKey, keys.macKey).bytes, imgBytes, 'ArrayBuffer input accepted');

const viaNodeBuffer = api.encrypt({ k: 'image', bytes: Buffer.from(imgBytes) }, keys.encKey, keys.macKey);
eqBytes(api.decrypt(viaNodeBuffer, keys.encKey, keys.macKey).bytes, imgBytes, 'Node Buffer (Uint8Array) input accepted');

// No plaintext image bytes leak into the wire payload.
const imageJson = api.encrypt({ k: 'image', bytes: imgBytes }, keys.encKey, keys.macKey);
ok(imageJson.indexOf(Buffer.from(imgBytes).toString('base64').slice(0, 24)) === -1,
  'raw image bytes are not present in the wire payload');

beginSection('fill-in-reverse: encrypt with (A,B), decrypt with (B,A)');

const reversedKeys = api.deriveKeys(PWB, PWA);
const textFromReversed = api.encrypt({ k: 'text', text: 'reverse order works' }, keys.encKey, keys.macKey);
eq(api.decrypt(textFromReversed, reversedKeys.encKey, reversedKeys.macKey).text,
  'reverse order works', 'text decrypts when passwords were typed in reverse');
const imageFromReversed = api.encrypt({ k: 'image', bytes: imgBytes }, keys.encKey, keys.macKey);
eqBytes(api.decrypt(imageFromReversed, reversedKeys.encKey, reversedKeys.macKey).bytes,
  imgBytes, 'image decrypts when passwords were typed in reverse');

beginSection('wrong passwords must fail');

const wrongKeys = api.deriveKeys(PWA, PWC);
const validText = api.encrypt({ k: 'text', text: 'top secret' }, keys.encKey, keys.macKey);
const validImage = api.encrypt({ k: 'image', bytes: imgBytes }, keys.encKey, keys.macKey);

throws(() => api.decrypt(validText, wrongKeys.encKey, wrongKeys.macKey), 'ABBA_MAC_INVALID',
  'wrong password pair cannot decrypt text (MAC fails)');
throws(() => api.decrypt(validImage, wrongKeys.encKey, wrongKeys.macKey), 'ABBA_MAC_INVALID',
  'wrong password pair cannot decrypt image (MAC fails)');
throws(() => api.decrypt(validText, wrongKeys.encKey, keys.macKey), 'ABBA_DECRYPT_FAILED',
  'synthetic wrong encKey + genuine macKey passes MAC then fails AES decryption');
throws(() => api.decrypt(validText, keys.encKey, wrongKeys.macKey), 'ABBA_MAC_INVALID',
  'wrong macKey alone cannot decrypt');

// MAC must be checked BEFORE decryption: a garbage ciphertext with a matching shape
// still fails on MAC (ABBA_MAC_INVALID), never on padding/decryption.
const garbage = JSON.parse(validText);
garbage.ct = Buffer.alloc(32, 0x41).toString('base64');
throws(() => api.decrypt(JSON.stringify(garbage), keys.encKey, keys.macKey), 'ABBA_MAC_INVALID',
  'valid-shaped but unauthenticated ciphertext rejected by MAC first (no padding oracle)');

beginSection('tamper detection (iv / ct / mac / structure)');

function tamper(json, fn) {
  const obj = JSON.parse(json);
  fn(obj);
  return JSON.stringify(obj);
}

function flipB64Byte(b64, index) {
  const buf = Buffer.from(b64, 'base64');
  const i = ((index % buf.length) + buf.length) % buf.length;
  buf[i] = buf[i] ^ 0x01;
  return buf.toString('base64');
}

throws(() => api.decrypt(tamper(validText, (o) => { o.iv = flipB64Byte(o.iv, 0); }),
  keys.encKey, keys.macKey), 'ABBA_MAC_INVALID', 'tampered iv (bit flip) rejected');
throws(() => api.decrypt(tamper(validText, (o) => { o.ct = flipB64Byte(o.ct, 0); }),
  keys.encKey, keys.macKey), 'ABBA_MAC_INVALID', 'tampered ct (first byte) rejected');
throws(() => api.decrypt(tamper(validText, (o) => { o.ct = flipB64Byte(o.ct, o.ct.length - 2); }),
  keys.encKey, keys.macKey), 'ABBA_MAC_INVALID', 'tampered ct (last block) rejected');
throws(() => api.decrypt(tamper(validText, (o) => { o.mac = flipB64Byte(o.mac, 0); }),
  keys.encKey, keys.macKey), 'ABBA_MAC_INVALID', 'tampered mac rejected');
throws(() => api.decrypt(tamper(validText, (o) => { o.mac = Buffer.alloc(32, 0).toString('base64'); }),
  keys.encKey, keys.macKey), 'ABBA_MAC_INVALID', 'forged mac (all zeroes) rejected');
throws(() => api.decrypt(tamper(validText, (o) => { o.v = 2; }), keys.encKey, keys.macKey),
  'ABBA_BAD_PAYLOAD', 'unsupported payload version rejected');
throws(() => api.decrypt(tamper(validText, (o) => { o.k = 'video'; }), keys.encKey, keys.macKey),
  'ABBA_BAD_PAYLOAD', 'unsupported payload kind rejected');
throws(() => api.decrypt(tamper(validText, (o) => { delete o.mac; }), keys.encKey, keys.macKey),
  'ABBA_BAD_PAYLOAD', 'missing mac rejected');
throws(() => api.decrypt(tamper(validText, (o) => { delete o.ct; }), keys.encKey, keys.macKey),
  'ABBA_BAD_PAYLOAD', 'missing ct rejected');
throws(() => api.decrypt(tamper(validText, (o) => { delete o.iv; }), keys.encKey, keys.macKey),
  'ABBA_BAD_PAYLOAD', 'missing iv rejected');
throws(() => api.decrypt(tamper(validText, (o) => { o.iv = Buffer.alloc(15, 7).toString('base64'); }),
  keys.encKey, keys.macKey), 'ABBA_BAD_PAYLOAD', 'iv that decodes to 15 bytes rejected');
throws(() => api.decrypt(tamper(validText, (o) => { o.iv = Buffer.alloc(17, 7).toString('base64'); }),
  keys.encKey, keys.macKey), 'ABBA_BAD_PAYLOAD', 'iv that decodes to 17 bytes rejected');
throws(() => api.decrypt(tamper(validText, (o) => { o.mac = Buffer.alloc(31, 7).toString('base64'); }),
  keys.encKey, keys.macKey), 'ABBA_BAD_PAYLOAD', 'mac that decodes to 31 bytes rejected');
throws(() => api.decrypt(tamper(validText, (o) => { o.ct = Buffer.alloc(15, 7).toString('base64'); }),
  keys.encKey, keys.macKey), 'ABBA_BAD_PAYLOAD', 'ct not a multiple of the AES block size rejected');
throws(() => api.decrypt(tamper(validText, (o) => { o.ct = ''; }), keys.encKey, keys.macKey),
  'ABBA_BAD_PAYLOAD', 'empty ct rejected');
throws(() => api.decrypt(tamper(validText, (o) => { o.ct = 'not base64 !!!'; }), keys.encKey, keys.macKey),
  'ABBA_BAD_PAYLOAD', 'non-base64 ct rejected');
throws(() => api.decrypt(tamper(validText, (o) => { o.iv = 'AAA'; }), keys.encKey, keys.macKey),
  'ABBA_BAD_PAYLOAD', 'base64 with invalid length rejected');
throws(() => api.decrypt(tamper(validText, (o) => { o.iv = o.iv.slice(0, 8) + ' ' + o.iv.slice(8); }),
  keys.encKey, keys.macKey), 'ABBA_BAD_PAYLOAD', 'whitespace inside base64 rejected');
throws(() => api.decrypt(tamper(validText, (o) => { o.iv = o.iv.replace(/=+$/, ''); }),
  keys.encKey, keys.macKey), 'ABBA_BAD_PAYLOAD', 'missing base64 padding (wrong length) rejected');
throws(() => api.decrypt('not json at all', keys.encKey, keys.macKey), 'ABBA_BAD_PAYLOAD',
  'non-JSON payload rejected');
throws(() => api.decrypt('[]', keys.encKey, keys.macKey), 'ABBA_BAD_PAYLOAD', 'JSON array rejected');
throws(() => api.decrypt('null', keys.encKey, keys.macKey), 'ABBA_BAD_PAYLOAD', 'JSON null rejected');
throws(() => api.decrypt(42, keys.encKey, keys.macKey), 'ABBA_BAD_PAYLOAD', 'non-string payload rejected');

// Structural tampering must not be mistaken for a key error; MAC tampering must not
// be reported as BAD_PAYLOAD: the page maps both to "cannot decrypt" anyway.
const macErr = throws(() => api.decrypt(tamper(validText, (o) => { o.mac = flipB64Byte(o.mac, 3); }),
  keys.encKey, keys.macKey), 'ABBA_MAC_INVALID', 'mac tamper error code is ABBA_MAC_INVALID');
if (macErr) {
  eq(macErr.name, 'AbbaCryptoError', 'MAC error has name AbbaCryptoError');
  // The API runs inside a vm realm here, so check the intrinsic tag instead of
  // `instanceof Error` (cross-realm Error instances are not instanceof this realm's Error).
  eq(toTag.call(macErr), '[object Error]', 'MAC error is an Error instance');
  ok(typeof macErr.message === 'string' && macErr.message.length > 0, 'MAC error carries a message');
}

beginSection('interop with Node crypto (both directions)');

const interopTexts = ['node -> wrapper', '双向互通：中文/emoji 🔐', 'x'.repeat(1000)];
for (const text of interopTexts) {
  const fromNode = nodeEncrypt('text', Buffer.from(text, 'utf8'), nodeKeys);
  const decoded = api.decrypt(fromNode, keys.encKey, keys.macKey);
  eq(decoded.text, text, 'Node encrypt -> wrapper decrypt  [' + fmt(text) + ']');
  eq(decoded.k, 'text', 'Node encrypt -> wrapper decrypt k');
}

for (const text of interopTexts) {
  const fromWrapper = api.encrypt({ k: 'text', text }, keys.encKey, keys.macKey);
  eq(nodeDecryptText(fromWrapper, nodeKeys), text, 'wrapper encrypt -> Node decrypt  [' + fmt(text) + ']');
}

const interopImage = pseudoBytes(70 * 1024, 6);
const nodeImageWire = nodeEncrypt('image', interopImage, nodeKeys);
const wrapperDecodedImage = api.decrypt(nodeImageWire, keys.encKey, keys.macKey);
eq(wrapperDecodedImage.k, 'image', 'Node encrypt image -> wrapper decrypt k');
eqBytes(wrapperDecodedImage.bytes, interopImage, 'Node encrypt image -> wrapper decrypt bytes');

const wrapperImageWire = api.encrypt({ k: 'image', bytes: interopImage }, keys.encKey, keys.macKey);
eqBytes(nodeDecrypt(wrapperImageWire, nodeKeys), interopImage, 'wrapper encrypt image -> Node decrypt bytes');

// Fixed-vector check pins the exact algorithm (IV 00..0f, plaintext "vector-test").
{
  const fixedIv = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const cipher = createCipheriv('aes-256-cbc', nodeKeys.encKey, fixedIv);
  const fixedCt = Buffer.concat([cipher.update(Buffer.from('vector-test', 'utf8')), cipher.final()]);
  const fixedMac = createHmac('sha256', nodeKeys.macKey)
    .update(Buffer.concat([fixedIv, fixedCt])).digest();
  const fixedPayload = JSON.stringify({
    k: 'text', v: 1,
    iv: fixedIv.toString('base64'),
    ct: fixedCt.toString('base64'),
    mac: fixedMac.toString('base64')
  });
  eq(api.decrypt(fixedPayload, keys.encKey, keys.macKey).text, 'vector-test',
    'fixed AES-256-CBC/HMAC vector decrypts with wrapper keys');
  eq(fixedCt.toString('hex').length, 32, 'fixed vector ct is one padded block');
}

// Key material returned by deriveKeys must be usable byte-for-byte by Node crypto.
eq(Buffer.from(hexOf(keys.encKey), 'hex').length, 32, 'wrapper encKey is 32 bytes -> AES-256');
eq(Buffer.from(hexOf(keys.macKey), 'hex').length, 32, 'wrapper macKey is 32 bytes -> HMAC-SHA256');

beginSection('wire payload: no plaintext / password leakage');

const secretText = '绝密消息 top-secret-2026';
const secretWire = api.encrypt({ k: 'text', text: secretText }, keys.encKey, keys.macKey);
ok(secretWire.indexOf(secretText) === -1, 'plaintext message is not present in the wire payload');
ok(secretWire.indexOf(PWA) === -1 && secretWire.indexOf(PWB) === -1, 'plaintext passwords not in payload');
ok(secretWire.indexOf(keys.pairKey) === -1, 'pairKey is not repeated inside the payload');
ok(secretWire.indexOf(nodeKeys.hA) === -1 && secretWire.indexOf(nodeKeys.hB) === -1,
  'password SHA256 hashes not in payload');
ok(!/[^\x20-\x7e]/.test(secretWire), 'payload JSON is ASCII-only (base64 fields only)');
const wireObj = JSON.parse(secretWire);
ok(Object.keys(wireObj).every((k) => ['k', 'v', 'iv', 'ct', 'mac'].indexOf(k) !== -1),
  'only the contract fields are sent');
ok(wireObj.k === 'text' && wireObj.v === 1, 'payload declares k:text, v:1');

beginSection('size limits');

const base = new Uint8Array(2 * 1024 * 1024 + 1);
throws(() => api.encrypt({ k: 'image', bytes: base }, keys.encKey, keys.macKey), 'ABBA_TOO_LARGE',
  'image plaintext over the 2 MiB guard rejected before encrypting');
throws(() => api.encrypt({ k: 'text', text: 'a'.repeat(2 * 1024 * 1024 + 1) }, keys.encKey, keys.macKey),
  'ABBA_TOO_LARGE', 'text plaintext over the 2 MiB guard rejected');
throws(() => api.encrypt({ k: 'image', bytes: new Uint8Array(0) }, keys.encKey, keys.macKey),
  'ABBA_BAD_INPUT', 'empty image payload rejected');

const capWire = api.encrypt({ k: 'image', bytes: pseudoBytes(600 * 1024, 4) }, keys.encKey, keys.macKey);
ok(capWire.length < 2.5 * 1024 * 1024,
  '600 KiB image wire payload is ' + capWire.length + ' B, under the 2.5 MiB server cap');
console.log('  info  600 KiB image -> wire payload ' + capWire.length + ' bytes (' +
  (capWire.length / 1024 / 1024).toFixed(2) + ' MiB)');

beginSection('input validation');

throws(() => api.encrypt(null, keys.encKey, keys.macKey), 'ABBA_BAD_INPUT', 'null payload rejected');
throws(() => api.encrypt('string', keys.encKey, keys.macKey), 'ABBA_BAD_INPUT', 'string payload rejected');
throws(() => api.encrypt({}, keys.encKey, keys.macKey), 'ABBA_BAD_INPUT', 'empty payload rejected');
throws(() => api.encrypt({ k: 'audio', text: 'x' }, keys.encKey, keys.macKey), 'ABBA_BAD_INPUT',
  'unknown kind rejected');
throws(() => api.encrypt({ k: 'text' }, keys.encKey, keys.macKey), 'ABBA_BAD_INPUT',
  'text payload without text rejected');
throws(() => api.encrypt({ k: 'text', text: 42 }, keys.encKey, keys.macKey), 'ABBA_BAD_INPUT',
  'non-string text rejected');
throws(() => api.encrypt({ k: 'text', text: 'x', v: 2 }, keys.encKey, keys.macKey), 'ABBA_BAD_INPUT',
  'plaintext object with v:2 rejected');
throws(() => api.encrypt({ k: 'image' }, keys.encKey, keys.macKey), 'ABBA_BAD_INPUT',
  'image payload without bytes rejected');
throws(() => api.encrypt({ k: 'image', bytes: 'aGVsbG8=' }, keys.encKey, keys.macKey), 'ABBA_BAD_INPUT',
  'image bytes given as a plain string rejected (use dataURL)');
throws(() => api.encrypt({ k: 'image', dataURL: 'data:text/plain;base64,aGVsbG8=' }, keys.encKey, keys.macKey),
  'ABBA_BAD_INPUT', 'non-image data URL rejected');
throws(() => api.encrypt({ k: 'text', text: 'x' }, 'not-a-key', keys.macKey), 'ABBA_BAD_KEY',
  'encKey must be a 32-byte WordArray');
throws(() => api.encrypt({ k: 'text', text: 'x' }, keys.encKey, null), 'ABBA_BAD_KEY',
  'macKey must be a WordArray');
throws(() => api.decrypt(validText, keys.encKey, { words: [], sigBytes: 16 }), 'ABBA_BAD_KEY',
  '16-byte key rejected (AES-256 requires 32 bytes)');

// Lone surrogates are not encodable as UTF-8 -> clear input error.
throws(() => api.encrypt({ k: 'text', text: '\uD800' }, keys.encKey, keys.macKey), 'ABBA_BAD_INPUT',
  'lone surrogate text rejected');

throws(() => api.bytesToDataURL('nope'), 'ABBA_BAD_INPUT', 'bytesToDataURL rejects non-bytes');
throws(() => api.dataURLToBytes('not a data url'), 'ABBA_BAD_INPUT', 'dataURLToBytes rejects bad input');

// Keys are not mutated by encrypt/decrypt.
const encBefore = hexOf(keys.encKey);
const macBefore = hexOf(keys.macKey);
api.decrypt(api.encrypt({ k: 'text', text: 'mutation check' }, keys.encKey, keys.macKey),
  keys.encKey, keys.macKey);
eq(hexOf(keys.encKey), encBefore, 'encrypt/decrypt do not mutate encKey');
eq(hexOf(keys.macKey), macBefore, 'encrypt/decrypt do not mutate macKey');

beginSection('browser mode: no crypto.subtle needed / no RNG guard');

const browserKeys2 = browser.api.deriveKeys(PWA, PWB);
const browserWire = browser.api.encrypt({ k: 'text', text: 'browser mode no subtle' },
  browserKeys2.encKey, browserKeys2.macKey);
eq(browser.api.decrypt(browserWire, browserKeys2.encKey, browserKeys2.macKey).text,
  'browser mode no subtle', 'browser branch encrypt/decrypt works with only crypto.getRandomValues');
const browserImage = pseudoBytes(4096, 7);
eqBytes(browser.api.decrypt(
  browser.api.encrypt({ k: 'image', bytes: browserImage }, browserKeys2.encKey, browserKeys2.macKey),
  browserKeys2.encKey, browserKeys2.macKey).bytes, browserImage, 'browser branch image roundtrip');
ok(!Object.prototype.hasOwnProperty.call(fakeGetRandomValues, 'subtle'),
  'test crypto provider exposes no subtle (plain-http LAN simulation)');

const noRng = loadWrapperBrowser({ vendorFirst: true }); // no crypto global, no require
const noRngKeys = noRng.api.deriveKeys(PWA, PWB);
eq(noRng.api.isReady(), true, 'wrapper is usable without any crypto global (vendor only)');
throws(() => noRng.api.encrypt({ k: 'text', text: 'needs iv' }, noRngKeys.encKey, noRngKeys.macKey),
  'ABBA_NO_RNG', 'encrypt refuses to run without a secure RNG instead of using Math.random');

beginSection('performance');

const DERIVE_RUNS = 3;
const deriveAvg = timeMs(() => api.deriveKeys(PWA, PWB), DERIVE_RUNS);
const deriveNodeAvg = timeMs(() => nodeDerive(PWA, PWB), DERIVE_RUNS);
console.log('  info  deriveKeys (2x PBKDF2-HMAC-SHA256, 10000 iters): ' +
  deriveAvg.toFixed(1) + ' ms/op (~' + (deriveAvg / 2).toFixed(1) +
  ' ms per single 10000-iteration PBKDF2; Node native pbkdf2Sync ref: ' +
  deriveNodeAvg.toFixed(1) + ' ms/op for both keys)');
ok(deriveAvg < 3000, 'deriveKeys avg under 3 s (' + deriveAvg.toFixed(1) + ' ms)');

const perfImage = pseudoBytes(600 * 1024, 8);
const encAvg = timeMs(() => api.encrypt({ k: 'image', bytes: perfImage }, keys.encKey, keys.macKey), 2);
const perfWire = api.encrypt({ k: 'image', bytes: perfImage }, keys.encKey, keys.macKey);
const decAvg = timeMs(() => api.decrypt(perfWire, keys.encKey, keys.macKey), 2);
console.log('  info  encrypt 600 KiB image: ' + encAvg.toFixed(1) +
  ' ms/op; decrypt: ' + decAvg.toFixed(1) + ' ms/op');
ok(encAvg < 5000, 'encrypt a 600 KiB image under 5 s (' + encAvg.toFixed(1) + ' ms)');
ok(decAvg < 5000, 'decrypt a 600 KiB image under 5 s (' + decAvg.toFixed(1) + ' ms)');

/* ------------------------------------------------------------------------- *
 * Summary
 * ------------------------------------------------------------------------- */

console.log('\n' + '='.repeat(70));
if (failures.length === 0) {
  console.log('PASS  crypto-unit: ' + checkCount + ' checks, 0 failures');
  console.log('      assets/abba-crypto.js over assets/crypto-js.min.js v4.2.0 — OK');
  process.exit(0);
} else {
  console.log('FAIL  crypto-unit: ' + checkCount + ' checks, ' + failures.length + ' failure(s)');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
