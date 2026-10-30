# Third-Party Notices

This package (`dsh-abba-secret-chat`, MIT) vendors the following third-party
component. It is **not** an npm dependency: the file is checked into the package
and loaded by the browser page as a plain `<script>`, so the plugin keeps zero
runtime npm dependencies.

## Vendored component

| Field | Value |
|---|---|
| Package | `crypto-js` |
| Version | `4.2.0` |
| License | MIT (see full text below) |
| Upstream | https://github.com/brix/crypto-js |
| Package source (registry tarball) | https://registry.npmjs.org/crypto-js/-/crypto-js-4.2.0.tgz |
| Vendored file | `assets/crypto-js.min.js` |
| Original file in tarball | `package/crypto-js.js` (single-file browser build, unminified) |
| Purpose | AES-256-CBC/PKCS7, SHA256, HMAC-SHA256 and PBKDF2-HMAC-SHA256 for the end-to-end encryption layer (`assets/abba-crypto.js`). Used in the browser only; no network access, no other library dependencies. |
| Vendored on | 2026-10-30 |
| Modifications | License banner comment prepended (the npm bundle ships without a license header). The bytes after the banner are **unmodified** upstream `crypto-js.js`. |

### Why the file is named `crypto-js.min.js` although it is not minified

The `crypto-js@4.2.0` npm tarball does **not** ship a minified bundle (it dropped
the `crypto-js.min.js` build). The only single-file browser build in the tarball
is the unminified `crypto-js.js`, so that build was vendored under the path
`assets/crypto-js.min.js` fixed by `CONTRACT-V2.md` §3 (served as
`GET /vendor/crypto-js.js`). This file is a verbatim copy plus the banner.

### Integrity

| Artifact | SHA-256 |
|---|---|
| `crypto-js-4.2.0.tgz` (npm tarball, `shasum 4d931639ecdfd12ff80e8186dba6af2c2e856631`) | `2d288a658b3eae000d7fadfdfdf5fe2bec3952cb19212360db8c7686c2b6ce09` |
| `package/crypto-js.js` (upstream browser bundle, before banner) | `ee02257ffbaf0a9b481c7039b0f3bb20c360c9674fe4be8b38ae709b2ea59bbe` |
| `assets/crypto-js.min.js` (as vendored, banner + upstream bytes) | `85803d90a4c594d7eab77f6d689b609a23dc946c0cfd6c08d88179cc47b54701` |
| `package/LICENSE` (upstream license file) | `f729d14b7e1bf8adca0dcc38b93b929d14d53fcd5db56c3d1c9b2daa7aa69396` |

`assets/crypto-js.min.js` size: 219 723 bytes (631-byte banner + 219 092 upstream bytes).

## License of the vendored component

The MIT License (MIT)

Copyright (c) 2009-2013 Jeff Mott
Copyright (c) 2013-2016 Evan Vosberg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

---

# 第三方组件声明（中文摘要）

本插件（`dsh-abba-secret-chat`，MIT）内嵌 vendored 组件 **crypto-js 4.2.0**（MIT 许可，
上游 <https://github.com/brix/crypto-js>，取自 npm registry 官方 tarball
<https://registry.npmjs.org/crypto-js/-/crypto-js-4.2.0.tgz>），用于浏览器端
AES-256-CBC/PKCS7、SHA256、HMAC-SHA256、PBKDF2-HMAC-SHA256 端到端加密原语。

- 文件：`assets/crypto-js.min.js`。4.2.0 的 npm 包不再提供 `.min.js` 构建，故 vendored 的是
  tarball 中唯一的单文件浏览器构建 `crypto-js.js`（未压缩），按契约固定路径命名。
- 唯一改动：在文件开头添加注释形式的 MIT 许可头（上游该文件本身无许可头），其后内容与上游逐字节一致。
- 该组件不是运行时 npm 依赖，插件仍保持零依赖（`package.json` 无 dependencies）。

本项目的其它代码（`lib/**`、`assets/index.html`、`assets/abba-crypto.js`、`client/**`）均为 MIT，
版权与许可见仓库根目录 `LICENSE`。
