/*!
 * abba-crypto.js - "AB-BA Secret Chat" end-to-end encryption layer (v0.2.0)
 * ---------------------------------------------------------------------------
 * Thin UMD wrapper over the vendored crypto-js 4.2.0 bundle
 * (assets/crypto-js.min.js, MIT; see THIRD_PARTY_NOTICES.md).
 *
 * Implements CONTRACT-V2.md section 1 exactly:
 *
 *   hA = hex(SHA256(utf8(passwordA)))
 *   hB = hex(SHA256(utf8(passwordB)))
 *   hx, hy = lexicographically sorted (hA, hB)
 *   pairKey = hex(SHA256(utf8(hx + "|" + hy)))            // only this goes to the server
 *   encPass = hx + "|" + hy
 *   encKey  = PBKDF2-HMAC-SHA256(encPass, "dsh-abba-secret-chat/v1",     10000, 32 bytes)
 *   macKey  = PBKDF2-HMAC-SHA256(encPass, "dsh-abba-secret-chat/v1/mac", 10000, 32 bytes)
 *   wire payload = {"k":"text"|"image","v":1,"iv":base64,"ct":base64,"mac":base64}
 *   encrypt-then-MAC: AES-256-CBC/PKCS7 with random 16-byte IV; mac = HMAC-SHA256(macKey, iv || ct)
 *
 * Public API (frozen by CONTRACT-V2.md section 3):
 *
 *   deriveKeys(passwordA, passwordB)
 *     -> { pairKey: string(64 lowercase hex), encKey: WordArray(32B), macKey: WordArray(32B) }
 *
 *   encrypt(payloadObj, encKey, macKey) -> JSON string
 *     text:  { k:'text',  text: '...' }                     (v may be omitted or 1)
 *     image: { k:'image', bytes: Uint8Array|ArrayBuffer }   (aliases: data, dataURL)
 *     The plaintext is UTF-8 text or the raw (already compressed JPEG) bytes.
 *
 *   decrypt(payloadString, encKey, macKey) -> payloadObj
 *     text:  { k:'text',  v:1, text: string }
 *     image: { k:'image', v:1, bytes: Uint8Array, dataURL: string }
 *     MAC is verified in constant time BEFORE any decryption; failure throws.
 *
 *   bytesToDataURL(bytes, mime?) -> string
 *   dataURLToBytes(dataURL) -> Uint8Array
 *   isReady() -> boolean
 *
 * Error codes (err.code): ABBA_VENDOR_MISSING | ABBA_BAD_INPUT | ABBA_BAD_KEY |
 *   ABBA_BAD_PAYLOAD | ABBA_MAC_INVALID | ABBA_ENCRYPT_FAILED | ABBA_DECRYPT_FAILED |
 *   ABBA_TOO_LARGE | ABBA_NO_RNG. The receiving page should catch every decrypt error
 *   and show one generic "this message cannot be decrypted" notice (no oracle).
 *
 * Deliberately does NOT use WebCrypto (`crypto.subtle`): the chat page is served over
 * plain http on a LAN address, which is not a secure context, so subtle would be
 * unavailable there. All primitives come from the vendored crypto-js bundle.
 *
 * UMD: browser -> window.AbbaCrypto; CommonJS/Node -> module.exports.
 */
;(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) {
    /* CommonJS / Node. crypto-js is vendored next to this file; fall back to an
     * installed package named "crypto-js" only if the sibling file cannot load. */
    var CryptoJS = null;
    try {
      if (typeof require === 'function') CryptoJS = require('./crypto-js.min.js');
    } catch (e1) { /* handled by getCryptoJS() with a clear error */ }
    if (!CryptoJS || !CryptoJS.lib) {
      try {
        if (typeof require === 'function') CryptoJS = require('crypto-js');
      } catch (e2) { CryptoJS = CryptoJS || null; }
    }
    module.exports = factory(root, CryptoJS);
  } else if (typeof define === 'function' && define.amd) {
    define(['./crypto-js.min.js'], function (CryptoJS) {
      return factory(root, CryptoJS);
    });
  } else {
    root.AbbaCrypto = factory(root, root.CryptoJS);
  }
}(
  (typeof globalThis !== 'undefined') ? globalThis
    : (typeof self !== 'undefined') ? self
      : (typeof window !== 'undefined') ? window
        : this,
  function (root, initialCryptoJS) {
    'use strict';

    /* ------------------------------------------------------------------ *
     * Constants (CONTRACT-V2.md section 1)                                *
     * ------------------------------------------------------------------ */

    var API_VERSION = '0.2.0';
    var PAYLOAD_VERSION = 1;

    var SALT_ENC = 'dsh-abba-secret-chat/v1';
    var SALT_MAC = 'dsh-abba-secret-chat/v1/mac';
    var PBKDF2_ITERATIONS = 10000;
    var KEY_BYTES = 32;          // AES-256 + HMAC-SHA256
    var IV_BYTES = 16;           // AES block size
    var MAC_BYTES = 32;          // HMAC-SHA256 output
    var BLOCK_BYTES = 16;
    var KINDS = { text: true, image: true };

    /* Guard rails. The wire payload (JSON) must stay under the server's 2.5 MiB
     * cap; a 2 MiB plaintext limit plus the post-encrypt check below guarantee it,
     * while giving the UI (<= 600 KB compressed JPEG) a very wide margin. */
    var MAX_PLAINTEXT_BYTES = 2 * 1024 * 1024;       // 2 097 152
    var MAX_WIRE_BYTES = 2.5 * 1024 * 1024;          // 2 621 440 (server limit)

    var BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
    var DATA_URL_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i;

    /* ------------------------------------------------------------------ *
     * Errors                                                              *
     * ------------------------------------------------------------------ */

    function makeError(code, message, cause) {
      var err = new Error(message);
      err.name = 'AbbaCryptoError';
      err.code = code;
      if (cause) { err.cause = cause; }
      return err;
    }

    function badInput(message) { return makeError('ABBA_BAD_INPUT', message); }
    function badPayload(message) { return makeError('ABBA_BAD_PAYLOAD', message); }

    /* ------------------------------------------------------------------ *
     * crypto-js resolution (lazy: <script> load order does not matter as  *
     * long as both scripts are loaded before the first API call)          *
     * ------------------------------------------------------------------ */

    var CryptoJS = null;

    function isUsableCryptoJS(c) {
      return !!(c && c.lib && c.lib.WordArray && c.lib.CipherParams &&
        c.enc && c.enc.Utf8 && c.enc.Base64 && c.enc.Hex &&
        c.algo && c.algo.SHA256 && (c.AES || c.algo.AES) &&
        typeof c.PBKDF2 === 'function' && typeof c.HmacSHA256 === 'function' &&
        c.mode && c.mode.CBC && c.pad && c.pad.Pkcs7);
    }

    function getCryptoJS() {
      if (CryptoJS) { return CryptoJS; }
      if (isUsableCryptoJS(initialCryptoJS)) {
        CryptoJS = initialCryptoJS;
        return CryptoJS;
      }
      if (root && isUsableCryptoJS(root.CryptoJS)) {
        CryptoJS = root.CryptoJS;
        return CryptoJS;
      }
      throw makeError('ABBA_VENDOR_MISSING',
        'crypto-js is not loaded. Load /vendor/crypto-js.js before /crypto.js ' +
        '(the vendored crypto-js bundle provides AES/SHA256/HMAC/PBKDF2).');
    }

    /* ------------------------------------------------------------------ *
     * Randomness (CSPRNG; never used from crypto.subtle)                  *
     * ------------------------------------------------------------------ */

    function randomBytes(n) {
      var out = new Uint8Array(n);
      var webCrypto = root && root.crypto;
      if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
        /* Available on plain-http origins too (unlike crypto.subtle). */
        webCrypto.getRandomValues(out);
        return out;
      }
      if (typeof require === 'function') {
        var nodeCrypto = null;
        try { nodeCrypto = require('crypto'); } catch (e1) { /* next */ }
        if (!nodeCrypto) {
          try { nodeCrypto = require('node:crypto'); } catch (e2) { nodeCrypto = null; }
        }
        if (nodeCrypto && typeof nodeCrypto.randomBytes === 'function') {
          var buf = nodeCrypto.randomBytes(n);
          return new Uint8Array(buf);
        }
      }
      throw makeError('ABBA_NO_RNG',
        'No secure random source available: crypto.getRandomValues is missing. ' +
        'A secure random IV cannot be generated, refusing to encrypt.');
    }

    /* ------------------------------------------------------------------ *
     * Byte / WordArray / base64 / UTF-8 conversions                       *
     * (realm-safe: uses Object.prototype.toString + internal slots, so   *
     * byte containers coming from another JS realm are still accepted)    *
     * ------------------------------------------------------------------ */

    var toTag = Object.prototype.toString;

    function isArrayBufferLike(x) {
      return toTag.call(x) === '[object ArrayBuffer]';
    }

    function toUint8Array(input, what) {
      if (input === null || input === undefined) {
        throw badInput(what + ' must be a Uint8Array or ArrayBuffer');
      }
      var tag = toTag.call(input);
      if (tag === '[object Uint8Array]' || tag === '[object Uint8ClampedArray]') {
        return new Uint8Array(input); // copy; also accepts Node Buffer
      }
      if (isArrayBufferLike(input)) {
        return new Uint8Array(new Uint8Array(input)); // copy foreign buffer
      }
      if (typeof ArrayBuffer !== 'undefined' && typeof ArrayBuffer.isView === 'function' &&
        ArrayBuffer.isView(input)) {
        return new Uint8Array(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
      }
      if (Array.isArray(input)) {
        var arr = new Uint8Array(input.length);
        for (var i = 0; i < input.length; i++) {
          var b = input[i];
          if (typeof b !== 'number' || b < 0 || b > 255 || b !== (b | 0)) {
            throw badInput(what + ' array must contain integers 0..255');
          }
          arr[i] = b;
        }
        return arr;
      }
      throw badInput(what + ' must be a Uint8Array or ArrayBuffer');
    }

    function bytesToWordArray(C, bytes) {
      var words = [];
      for (var i = 0; i < bytes.length; i++) {
        var w = i >>> 2;
        words[w] = (words[w] | 0) | ((bytes[i] & 0xff) << (24 - (i % 4) * 8));
      }
      return C.lib.WordArray.create(words, bytes.length);
    }

    function wordArrayToBytes(wa) {
      var n = (wa && wa.sigBytes) | 0;
      var bytes = new Uint8Array(n);
      var words = (wa && wa.words) || [];
      for (var i = 0; i < n; i++) {
        bytes[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
      }
      return bytes;
    }

    function concatBytes(a, b) {
      var out = new Uint8Array(a.length + b.length);
      out.set(a, 0);
      out.set(b, a.length);
      return out;
    }

    function base64Encode(C, bytes) {
      return C.enc.Base64.stringify(bytesToWordArray(C, bytes));
    }

    function base64Decode(C, str, fieldName) {
      if (typeof str !== 'string' || !BASE64_RE.test(str)) {
        throw badPayload('field "' + fieldName + '" must be strict base64 (RFC 4648)');
      }
      return wordArrayToBytes(C.enc.Base64.parse(str));
    }

    function utf8Encode(C, text) {
      try {
        return wordArrayToBytes(C.enc.Utf8.parse(text));
      } catch (e) {
        throw badInput('text is not valid UTF-8/UTF-16 (lone surrogates are not allowed)');
      }
    }

    function utf8Decode(C, bytes) {
      try {
        return C.enc.Utf8.stringify(bytesToWordArray(C, bytes));
      } catch (e) {
        throw makeError('ABBA_DECRYPT_FAILED',
          'authenticated plaintext is not valid UTF-8 text', e);
      }
    }

    function dataURLToBytes(C, dataURL) {
      if (typeof dataURL !== 'string') {
        throw badInput('dataURL must be a string like "data:image/jpeg;base64,...."');
      }
      var m = DATA_URL_RE.exec(dataURL);
      if (!m || m[1].slice(0, 6) !== 'image/') {
        throw badInput('dataURL must be a base64 image data URL ("data:image/...;base64,...")');
      }
      var bytes = base64Decode(C, m[2], 'dataURL');
      if (bytes.length === 0) { throw badInput('dataURL contains no image bytes'); }
      return bytes;
    }

    function bytesToDataURL(bytes, mime) {
      var C = getCryptoJS();
      var data = toUint8Array(bytes, 'bytes');
      return 'data:' + (mime || 'image/jpeg') + ';base64,' + base64Encode(C, data);
    }

    /* ------------------------------------------------------------------ *
     * Constant-time MAC comparison                                       *
     * ------------------------------------------------------------------ */

    function constantTimeEquals(a, b) {
      if (a.length !== b.length) { return false; }
      var diff = 0;
      for (var i = 0; i < a.length; i++) { diff |= a[i] ^ b[i]; }
      return diff === 0;
    }

    /* ------------------------------------------------------------------ *
     * Keys                                                               *
     * ------------------------------------------------------------------ */

    var HEX64_RE = /^[0-9a-f]{64}$/;

    function isWordArrayLike(x) {
      return !!(x && typeof x === 'object' && Array.isArray(x.words) &&
        typeof x.sigBytes === 'number');
    }

    function assertKey(key, name) {
      if (!isWordArrayLike(key)) {
        throw makeError('ABBA_BAD_KEY',
          name + ' must be a crypto-js WordArray returned by AbbaCrypto.deriveKeys()');
      }
      if ((key.sigBytes | 0) !== KEY_BYTES) {
        throw makeError('ABBA_BAD_KEY', name + ' must be exactly ' + KEY_BYTES + ' bytes');
      }
    }

    function sha256Hex(C, text) {
      try {
        return C.SHA256(C.enc.Utf8.parse(text)).toString(C.enc.Hex);
      } catch (e) {
        throw badInput('password must be a string encodable as UTF-8');
      }
    }

    function assertPassword(password, name) {
      if (typeof password !== 'string') {
        throw badInput(name + ' must be a string');
      }
      if (password.length === 0) {
        throw badInput(name + ' must not be empty');
      }
    }

    function deriveKeys(passwordA, passwordB) {
      var C = getCryptoJS();
      assertPassword(passwordA, 'passwordA');
      assertPassword(passwordB, 'passwordB');

      /* Password hashes stay local; only pairKey ever leaves this function. */
      var hA = sha256Hex(C, passwordA);
      var hB = sha256Hex(C, passwordB);
      if (!HEX64_RE.test(hA) || !HEX64_RE.test(hB)) {
        throw makeError('ABBA_DERIVE_FAILED', 'unexpected SHA256 output format');
      }

      /* Fill-in-reverse equivalence: sort lexicographically, so (A,B) and (B,A)
       * derive the exact same keys. */
      var hx = hA <= hB ? hA : hB;
      var hy = hA <= hB ? hB : hA;

      var pairKey = sha256Hex(C, hx + '|' + hy);
      var encPass = hx + '|' + hy;

      var pbkdf2Cfg = {
        keySize: KEY_BYTES / 4, // crypto-js counts 32-bit words
        iterations: PBKDF2_ITERATIONS,
        hasher: C.algo.SHA256
      };

      var encKey = C.PBKDF2(
        C.enc.Utf8.parse(encPass),
        C.enc.Utf8.parse(SALT_ENC),
        pbkdf2Cfg
      );
      var macKey = C.PBKDF2(
        C.enc.Utf8.parse(encPass),
        C.enc.Utf8.parse(SALT_MAC),
        pbkdf2Cfg
      );

      if ((encKey.sigBytes | 0) !== KEY_BYTES || (macKey.sigBytes | 0) !== KEY_BYTES) {
        throw makeError('ABBA_DERIVE_FAILED', 'PBKDF2 returned an unexpected key size');
      }

      return { pairKey: pairKey, encKey: encKey, macKey: macKey };
    }

    /* ------------------------------------------------------------------ *
     * Plaintext normalization (text | compressed image bytes)             *
     * ------------------------------------------------------------------ */

    function normalizePlaintext(payload) {
      var C = getCryptoJS();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw badInput('encrypt() payload must be an object: ' +
          '{k:"text", text} or {k:"image", bytes}');
      }

      var kind = payload.k;
      if (kind === undefined || kind === null || kind === '') {
        if (typeof payload.text === 'string') {
          kind = 'text';
        } else if (payload.bytes !== undefined || payload.data !== undefined ||
          typeof payload.dataURL === 'string') {
          kind = 'image';
        } else {
          throw badInput('cannot infer payload kind: text payload needs a "text" string, ' +
            'image payload needs "bytes" (Uint8Array|ArrayBuffer)');
        }
      }
      if (kind !== 'text' && kind !== 'image') {
        throw badInput('payload.k must be "text" or "image"');
      }
      if (payload.v !== undefined && payload.v !== PAYLOAD_VERSION) {
        throw badInput('payload.v must be ' + PAYLOAD_VERSION);
      }

      var bytes;
      if (kind === 'text') {
        if (typeof payload.text !== 'string') {
          throw badInput('text payload must carry a string field "text"');
        }
        bytes = utf8Encode(C, payload.text);
      } else {
        var raw = payload.bytes !== undefined ? payload.bytes
          : (payload.data !== undefined ? payload.data : undefined);
        if (raw !== undefined && raw !== null) {
          bytes = toUint8Array(raw, 'image "bytes"');
        } else if (typeof payload.dataURL === 'string') {
          bytes = dataURLToBytes(C, payload.dataURL);
        } else {
          throw badInput('image payload must carry "bytes" (Uint8Array|ArrayBuffer) ' +
            'or "dataURL" (data:image/...;base64,...)');
        }
        if (bytes.length === 0) {
          throw badInput('image payload is empty');
        }
      }

      if (bytes.length > MAX_PLAINTEXT_BYTES) {
        throw makeError('ABBA_TOO_LARGE',
          'plaintext is ' + bytes.length + ' bytes; the limit is ' + MAX_PLAINTEXT_BYTES +
          ' bytes (keep compressed images <= 600 KB)');
      }
      return { k: kind, bytes: bytes };
    }

    /* ------------------------------------------------------------------ *
     * encrypt: AES-256-CBC/PKCS7 -> HMAC-SHA256(macKey, iv || ct)        *
     * ------------------------------------------------------------------ */

    function encrypt(payload, encKey, macKey) {
      var C = getCryptoJS();
      assertKey(encKey, 'encKey');
      assertKey(macKey, 'macKey');

      var normalized = normalizePlaintext(payload);
      var iv = randomBytes(IV_BYTES);
      var ivWA = bytesToWordArray(C, iv);

      var ciphertext;
      var mac;
      try {
        var encrypted = C.AES.encrypt(bytesToWordArray(C, normalized.bytes), encKey, {
          iv: ivWA,
          mode: C.mode.CBC,
          padding: C.pad.Pkcs7
        });
        ciphertext = wordArrayToBytes(encrypted.ciphertext);
        mac = wordArrayToBytes(C.HmacSHA256(bytesToWordArray(C, concatBytes(iv, ciphertext)), macKey));
      } catch (e) {
        if (e && e.code) { throw e; }
        throw makeError('ABBA_ENCRYPT_FAILED', 'AES/HMAC encryption failed', e);
      }

      var json = JSON.stringify({
        k: normalized.k,
        v: PAYLOAD_VERSION,
        iv: base64Encode(C, iv),
        ct: base64Encode(C, ciphertext),
        mac: base64Encode(C, mac)
      });
      /* ASCII-only JSON, so string length == byte length. */
      if (json.length > MAX_WIRE_BYTES) {
        throw makeError('ABBA_TOO_LARGE',
          'encrypted payload is ' + json.length + ' bytes, over the server\'s 2.5 MiB cap');
      }
      return json;
    }

    /* ------------------------------------------------------------------ *
     * decrypt: verify MAC first (constant time), then AES-256-CBC        *
     * ------------------------------------------------------------------ */

    function decrypt(payloadString, encKey, macKey) {
      var C = getCryptoJS();
      assertKey(encKey, 'encKey');
      assertKey(macKey, 'macKey');

      if (typeof payloadString !== 'string') {
        throw badPayload('encrypted payload must be a JSON string');
      }
      var raw;
      try {
        raw = JSON.parse(payloadString);
      } catch (e) {
        throw makeError('ABBA_BAD_PAYLOAD', 'encrypted payload is not valid JSON');
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw badPayload('encrypted payload must be a JSON object');
      }
      if (raw.v !== PAYLOAD_VERSION) {
        throw badPayload('unsupported payload version: ' + String(raw.v));
      }
      if (!KINDS[raw.k]) {
        throw badPayload('unsupported payload kind: ' + String(raw.k));
      }

      var iv = base64Decode(C, raw.iv, 'iv');
      var ciphertext = base64Decode(C, raw.ct, 'ct');
      var mac = base64Decode(C, raw.mac, 'mac');

      if (iv.length !== IV_BYTES) {
        throw badPayload('iv must decode to exactly ' + IV_BYTES + ' bytes');
      }
      if (mac.length !== MAC_BYTES) {
        throw badPayload('mac must decode to exactly ' + MAC_BYTES + ' bytes');
      }
      if (ciphertext.length === 0 || ciphertext.length % BLOCK_BYTES !== 0) {
        throw badPayload('ct must be a non-empty multiple of ' + BLOCK_BYTES + ' bytes');
      }

      /* encrypt-then-MAC: authenticate BEFORE touching ciphertext. */
      var expectedMac;
      try {
        expectedMac = wordArrayToBytes(
          C.HmacSHA256(bytesToWordArray(C, concatBytes(iv, ciphertext)), macKey)
        );
      } catch (e) {
        if (e && e.code) { throw e; }
        throw makeError('ABBA_DECRYPT_FAILED', 'HMAC verification could not be computed', e);
      }
      if (!constantTimeEquals(expectedMac, mac)) {
        throw makeError('ABBA_MAC_INVALID',
          'MAC verification failed: wrong pair of passwords, or the payload was tampered with');
      }

      var plaintext;
      try {
        var decrypted = C.AES.decrypt(
          C.lib.CipherParams.create({ ciphertext: bytesToWordArray(C, ciphertext) }),
          encKey,
          { iv: bytesToWordArray(C, iv), mode: C.mode.CBC, padding: C.pad.Pkcs7 }
        );
        plaintext = wordArrayToBytes(decrypted);
      } catch (e) {
        if (e && e.code) { throw e; }
        throw makeError('ABBA_DECRYPT_FAILED', 'AES decryption failed', e);
      }

      if (raw.k === 'text') {
        return { k: 'text', v: PAYLOAD_VERSION, text: utf8Decode(C, plaintext) };
      }
      /* Image: compressed JPEG bytes; the page decides how to render them.
       * "dataURL" is a convenience for <img>.src (use bytes + ObjectURL if the
       * extra base64 copy matters). */
      return {
        k: 'image',
        v: PAYLOAD_VERSION,
        bytes: plaintext,
        dataURL: 'data:image/jpeg;base64,' + base64Encode(C, plaintext)
      };
    }

    /* ------------------------------------------------------------------ *
     * Public API                                                          *
     * ------------------------------------------------------------------ */

    return {
      VERSION: API_VERSION,
      PROTOCOL_VERSION: PAYLOAD_VERSION,
      ALGORITHM: 'AES-256-CBC/PKCS7 + HMAC-SHA256(iv||ct), PBKDF2-HMAC-SHA256 10000x',
      MAX_PLAINTEXT_BYTES: MAX_PLAINTEXT_BYTES,
      deriveKeys: deriveKeys,
      encrypt: encrypt,
      decrypt: decrypt,
      bytesToDataURL: bytesToDataURL,
      dataURLToBytes: function (dataURL) {
        return dataURLToBytes(getCryptoJS(), dataURL);
      },
      isReady: function () {
        try { return !!getCryptoJS(); } catch (e) { return false; }
      }
    };
  }
));
