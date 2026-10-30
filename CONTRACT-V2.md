# CONTRACT v2 — AB-BA 秘密对话 0.2.0（端到端加密 + 图片/截屏 + 我/你 + 彻底清理）

> 本文是 0.2.0 的实现契约，覆盖 v1 的 CONTRACT.md 中冲突的部分。先读本文件，再读现有代码与 `password-chat/`（行为基线，只读）。
> 环境：DSH 已升级到 **0.2.1-rc.5**（`resources\app.asar\package.json`）。CLI 正确用法见 CONTRACT.md §4（`dsh --profile X ...`，不要 `dsh web --profile X`）。

## 0. 用户新增需求（原话归纳）

1. 实时聊天的保密性：**网络传输中被截取也看不懂**；聊天内容只能由同时知道 A、B 两个密码的两人解开（密码 = 唯一秘密）。
2. 结束后内容**完全清理**。
3. 聊天框不标任何名字；每个当事人看自己=「我」、看对方=「你」。
4. 提供**截图按钮**：截取当前电脑屏幕可见内容（被遮挡的部分不需要），截图后可直接发给对方。
5. 也可传输图片（选文件/粘贴/拖拽）。
6. DSH 宿主已升到 0.2.1-rc.5，插件要兼容。

## 1. 安全模型（必须严格实现）

- **服务器永远不接触**：密码明文、两个密码的哈希、加密密钥、消息明文。
- **线上传输的只有**：`pairKey`（配对用）与密文 payload。抓包者拿到 `pairKey` 也无法解密（它只是两个哈希的再哈希）。
- 密钥推导（两端完全相同）：
  ```
  hA = hex(SHA256(utf8(passwordA)))
  hB = hex(SHA256(utf8(passwordB)))
  hx, hy = 按字典序排序后的 (hA, hB)
  pairKey = hex(SHA256(hx + "|" + hy))           // 发给服务器做配对
  encPass = hx + "|" + hy
  encKey  = PBKDF2-HMAC-SHA256(encPass, salt="dsh-abba-secret-chat/v1",       iterations=10000, 32 bytes)
  macKey  = PBKDF2-HMAC-SHA256(encPass, salt="dsh-abba-secret-chat/v1/mac",   iterations=10000, 32 bytes)
  ```
- 加密：AES-256-CBC / PKCS7，随机 16 字节 IV；**encrypt-then-MAC**：`mac = HMAC-SHA256(macKey, iv || ciphertext)`。
  线上 payload 形状（JSON）：
  ```json
  { "k": "text" | "image", "v": 1, "iv": "<base64>", "ct": "<base64>", "mac": "<base64>" }
  ```
- 图片同样走该 payload（`k:"image"`，`ct` 是压缩后图片字节的密文）；图片在加密前压缩：最长边 ≤ 1600px、JPEG 质量 0.82、目标 ≤ 600KB。
- 明文密码**绝不出现在任何请求里**；`/api/enter` 只收 `pairKey`。

## 2. 服务端协议 v2（`lib/server.js` + `lib/index.js` 的 /abba/info 不变）

保持 v1 的双人/填反等价/10 分钟等待/离开即毁语义，只改数据面：

| 接口 | v2 请求 | 响应 |
|---|---|---|
| `POST /api/enter` | `{cid, pairKey}`（pairKey = 64 hex） | 同 v1：`{ok, status:'waiting'\|'connected', roomId}` 或 409/400 |
| `POST /api/send` | `{cid, roomId, payload}`，payload 见 §1（服务端只做形状/大小校验，不解密、不改写） | `{ok:true}` |
| `POST /api/leave` | 同 v1 | 同 v1 |
| `GET /events?cid=` | SSE：`{type:'connected'}` / `{type:'msg', payload}` / `{type:'end', reason}` / `{type:'bound', roomId}` | 同 v1 |

- 大小限制：`MAX_BODY_BYTES` 提到 **3 MiB**；payload 序列化后 ≤ 2.5 MiB；`ct`/`mac` 必须是合法 base64，`iv` 解 base64 后必须 16 字节；`k` ∈ {text,image}；`v` 必须 1。不符合 → 400（不转发）。
- 服务端不读 `ct` 内容；日志里不出现 payload。
- **彻底清理**：`endRoom` 要额外清空相关 client 的 `queue`；房间销毁后不得残留 roomId 索引；“离开/刷新/断网/结束”任一路径都要走同一个销毁流程。新增 `stopChatServer` 保证端口释放（已有，保留）。
- 静态文件路由新增（供页面加载，见 §3）：`GET /crypto.js` → `assets/abba-crypto.js`，`GET /vendor/crypto-js.js` → `assets/crypto-js.min.js`；`GET /` / `/index.html` 仍返回 `assets/index.html`。

## 3. 页面与前端模块（`assets/index.html` + 新增文件）

- `assets/crypto-js.min.js`：**vendored** 第三方库（crypto-js，MIT）。必须带原始 LICENSE 头/许可证文件，并在 `THIRD_PARTY_NOTICES.md` 里注明。
- `assets/abba-crypto.js`：本项目的薄封装（UMD：浏览器挂 `window.AbbaCrypto`，Node 下 `module.exports`），API 固定：
  ```js
  deriveKeys(passwordA, passwordB) -> { pairKey: string, encKey: WordArray, macKey: WordArray }
  encrypt(payloadObj, encKey, macKey) -> string        // 返回 JSON 字符串（§1 形状）
  decrypt(payloadString, encKey, macKey) -> payloadObj // 校验 MAC；失败抛错
  ```
  （WordArray 是 crypto-js 类型；页面不直接用 crypto-js，一律走 AbbaCrypto。）
- `assets/index.html`：
  - 开始页：A/B 两个密码框（保留原文案与校验：4–128 字符，填反等价由 pairKey 保证）。
  - 聊天页：**不显示任何名字**；每条消息气泡带小标签：自己 =「我」，对方 =「你」。系统提示仍可显示（如“碰头成功”）。
  - 发送：文字（回车/按钮）、图片（选文件 / 粘贴 / 拖拽，先压缩再预览→发送）、**截图**按钮（系统屏幕捕获，取一帧→压缩→预览→发送；用户取消或权限被拒时给友好提示，不抛未捕获错误）。
  - 接收：解密失败（密钥不匹配/被篡改）显示为一条系统提示“这条消息无法解密”，不崩页面。
  - **结束清理**：点击结束/取消/断线结束时，关闭 EventSource、清空消息 DOM、把 encKey/macKey/状态引用置 null、清空输入与预览；返回开始页。刷新/关闭页面天然清空（页面不使用存储）。
  - 页面必须 `Cache-Control: no-store`（服务端已设），不写 Cookie/localStorage/sessionStorage/IndexedDB。

## 4. DSH 插件壳（`client/client.js`，Lead 负责）

- tab body 的 `<iframe>` 增加 `allow="display-capture"`（否则右侧栏里的截屏按钮会被浏览器拦），并保留 `allow="clipboard-write"`（复制链接已有）。其余注册逻辑不变。
- 0.2.1-rc.5 兼容：在 rc5 上实测 boot 图、入口按钮、右侧栏 tab、iframe 加载、面板内收发。

## 5. 验收（全部必须实测）

1. `node test/crypto-unit.mjs`：封装自测——roundtrip、错误密码无法解密、篡改 MAC 报错、与 Node `crypto`（AES-256-CBC/HMAC-SHA256）互通验证、pairKey 对填反等价。
2. `node test/host-e2e-v2.mjs`：服务端语义（pairKey 配对/填反/第三人/离开清空/等待超时）+ payload 校验（坏 base64/超长/坏 k 被 400 拒绝）+ 结束清理（房间、队列、pairIndex 无残留；端口释放）。
3. 真实浏览器 E2E（升级 `test/browser-e2e.mjs` 为 v2）：
   - 双人配对（填反）、文字双向收发、图片发送（用 CDP 往 `<input type=file>` 塞一张小 PNG）、结束清空、第三人被拒；
   - 校验“线上无明文”：在测试中抓 `/api/enter` 与 `/api/send` 的请求体，断言不含 password 明文、不含消息明文；
   - 截图按钮：至少验证按钮存在 + 权限被拒/取消时页面给出提示不崩（真实屏幕捕获由用户手动验一次）。
4. 在 **rc5** 隔离实例（临时 profile + 独立端口）里跑完 §5.3，并确认桌面端插件仍正常（`/abba/info`）。
5. `npm pack` 产物包含新增文件；版本 **0.2.0**；README/README.zh 更新（加密、图片、截图、清理、我/你）；截图重拍。

## 6. 文件所有权

| 路径 | 所有者 |
|---|---|
| `assets/crypto-js.min.js`、`assets/abba-crypto.js`、`test/crypto-unit.mjs`、`THIRD_PARTY_NOTICES.md` | crypto-dev |
| `lib/server.js`、`test/host-e2e-v2.mjs`（可从 host-e2e.mjs 复制改造） | server-dev |
| `assets/index.html` | ui-dev（依赖 crypto-dev 的 API 与 server-dev 的协议，二者按本文冻结） |
| `client/client.js` 的 iframe `allow`、`package.json`/版本/README/截图/集成 E2E/发布 | Lead |

三方接口以本文为准，**不得单方面改动**；需要改先告知 Lead。
