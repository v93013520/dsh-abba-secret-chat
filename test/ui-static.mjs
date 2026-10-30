/**
 * ui-static.mjs — assets/index.html 的静态契约检查（v0.2.0，本机开发工具，不随插件发布）。
 *
 * 覆盖 CONTRACT-V2 §1/§3 中可静态验证的部分：
 *   - 只发 pairKey（绝不发密码）到 /api/enter；页面自身不碰 crypto-js；
 *   - 不写 Cookie / localStorage / sessionStorage / IndexedDB；
 *   - 引用 /crypto.js 与 /vendor/crypto-js.js；
 *   - 小标签「我 / 你」逻辑、我/你标签与左右气泡；
 *   - 文字加密 payload（k:'text'）、图片 payload（k:'image'）、SSE 解密与失败提示；
 *   - 图片选文件 / 粘贴 / 拖拽 / 压缩参数（1600 / 0.82 / 600KB）/ 预览与取消；
 *   - 截屏按钮与 getDisplayMedia、权限被拒/取消中文提示；
 *   - 结束清理函数（关 EventSource、清空 #msgs、密钥/状态置 null、清空预览、回开始页）；
 *   - 消息长度 2000；内联脚本语法可解析（new Function）。
 *
 * 用法：node test/ui-static.mjs
 * 退出码 0 = 全部通过；1 = 有断言失败。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const htmlPath = fileURLToPath(new URL('../assets/index.html', import.meta.url))
const html = readFileSync(htmlPath, 'utf8')

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? '  OK  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function failHint(cond, detail) {
  return cond ? '' : detail
}

// ---------- 基础结构 ----------
check('页面文件存在且非空', html.length > 20000, `${html.length} bytes`)
check('标题含「密码碰头」（/abba 探活标记）', html.includes('<h1>密码碰头</h1>'))
check('保留 A/B 两个密码框', /id="pwd-a"/.test(html) && /id="pwd-b"/.test(html))
check('密码框限制 4–128（maxlength=128 + JS 长度校验）', /id="pwd-a"[^>]*maxlength="128"/.test(html) && html.includes('pa.length < 4 || pa.length > 128'))
check('保留开始页视觉基线（A/B 徽章与渐变按钮）', html.includes('badge-a') && html.includes('badge-b') && html.includes('linear-gradient(135deg,var(--accent),var(--accent2))'))

// ---------- 脚本加载 ----------
check('加载 /vendor/crypto-js.js', html.includes('<script src="/vendor/crypto-js.js"'))
check('加载 /crypto.js', html.includes('<script src="/crypto.js"'))
check('页面不直接使用 crypto-js 全局对象（一律走 AbbaCrypto）', !/\bCryptoJS\s*[.(]/.test(html) && !/\bwindow\.CryptoJS\b/.test(html))
check('使用 AbbaCrypto.deriveKeys / encrypt / decrypt', html.includes('AbbaCrypto.deriveKeys(') && html.includes('AbbaCrypto.encrypt(') && html.includes('AbbaCrypto.decrypt('))

// ---------- 安全模型：只发 pairKey ----------
check('不含 passwordA / passwordB 字段', !/passwordA|passwordB/.test(html))
check('不含 password 字段提交', !/["']password["']\s*:/.test(html))
const enterCalls = html.match(/api\('\/api\/enter',\s*\{[^}]*\}\)/g) || []
check('/api/enter 只提交 cid + pairKey', enterCalls.length === 1 && /cid:\s*cid/.test(enterCalls[0]) && /pairKey/.test(enterCalls[0]) && !/password/i.test(enterCalls[0]))
check('server 侧残留 v1 密码逻辑未出现在页面', !html.includes('passwordA') && !html.includes('passwordB'))
check('发送前对文字调用 encrypt({k:\'text\'...})', /encrypt\(\{\s*k:\s*'text'/.test(html))
check('接收解密密文 payload 后渲染', /receivePayload/.test(html) && /AbbaCrypto\.decrypt\(s,\s*encKey,\s*macKey\)/.test(html))
check('解密失败提示「这条消息无法解密」', html.includes('这条消息无法解密'))
check('文本用 textContent 渲染（防注入）', html.includes('body.textContent = text') && html.includes('d.textContent = text'))

// ---------- 无持久化 / 无 Cookie ----------
check('不使用 localStorage', !/localStorage/.test(html))
check('不使用 sessionStorage', !/sessionStorage/.test(html))
check('不使用 IndexedDB', !/indexedDB/i.test(html))
check('不读写 document.cookie', !/document\.cookie/.test(html))
check('不引用任何 Cookie 相关 API', !/cookie/i.test(html))
check('页面无存储写入（无 setItem / indexedDB.open）', !/setItem\s*\(/.test(html) && !/indexedDB\.open/.test(html))

// ---------- 我 / 你 标签 ----------
check('定义「我」标签常量', /var TAG_SELF = '我'/.test(html))
check('定义「你」标签常量', /var TAG_PEER = '你'/.test(html))
check('按发送方取标签（self=我, peer=你）', /who === 'self' \? TAG_SELF : TAG_PEER/.test(html))
check('气泡标签有 .tag 样式与渲染', /\.msg \.tag\{/.test(html) && html.includes("tag.className = 'tag'"))
check('保留左右/渐变气泡样式', html.includes('.msg.self{') && html.includes('.msg.peer{') && html.includes('border-bottom-right-radius:5px'))
check('聊天页不出现任何名字（无 A/B 姓名标签）', !/class="name"/.test(html) && !html.includes('对方的名字'))

// ---------- 文字发送 ----------
check('消息长度上限 2000（输入 maxlength）', /id="text"[^>]*maxlength="2000"/.test(html))
check('消息长度上限 2000（JS 常量）', /var MAX_TEXT_LEN = 2000/.test(html))
check('回车发送（keydown Enter）', /keydown/.test(html) && /e\.key === 'Enter'/.test(html))
check('发送表单提交按钮存在', /id="send-form"/.test(html) && /type="submit">发送</.test(html))
check('文字经 /api/send 提交 {cid,roomId,payload}', /api\('\/api\/send',\s*\{\s*cid:\s*cid,\s*roomId:\s*roomId,\s*payload:\s*payload\s*\}\)/.test(html))
check('加密返回的 JSON 字符串解析为 payload 对象再提交（CONTRACT-V2 §1 形状）', /payload = JSON\.parse\(sealed\)/.test(html) && /JSON\.stringify\(payload\)\.length > MAX_PAYLOAD_LEN/.test(html))
check('图片加密走后同样解析为 payload 对象', (html.match(/payload = JSON\.parse\(sealed\)/g) || []).length === 2)

// ---------- 图片 ----------
check('图片按钮存在', /id="btn-image"/.test(html))
check('隐藏文件选择框 accept=image/*', /id="file-input"[^>]*accept="image\/\*"/.test(html))
check('支持粘贴图片（paste 监听）', /addEventListener\('paste'/.test(html))
check('支持拖拽图片（dragover/drop 监听）', /addEventListener\('drop'/.test(html) && /addEventListener\('dragover'/.test(html))
check('canvas 压缩：最长边 1600', /MAX_IMAGE_EDGE = 1600/.test(html) && html.includes('MAX_IMAGE_EDGE / Math.max(sw, sh)'))
check('canvas 压缩：JPEG 质量 0.82', /JPEG_QUALITY = 0\.82/.test(html) && html.includes("'image/jpeg'"))
check('压缩目标 ≤600KB（且有二次降质/缩边）', /MAX_IMAGE_BYTES = 600 \* 1024/.test(html) && html.includes('quality > 0.5') && html.includes('w * 0.78'))
check('图片先预览（预览区 + 图片 + 元信息）', /id="preview"/.test(html) && /id="preview-img"/.test(html) && /id="preview-meta"/.test(html))
check('预览可取消（取消按钮）', /id="btn-preview-cancel"/.test(html))
check('预览确认后加密发送（按钮 + k:image payload）', /id="btn-preview-send"/.test(html) && /k: 'image'/.test(html) && /makeImagePlain/.test(html))
check('图片 payload 使用 bytes 字段（与 AbbaCrypto 约定一致）', /return \{ k: 'image', bytes: bytes \}/.test(html))
check('接收图片按 image/* data URL 校验后渲染 <img>', /data:image\\\//.test(html) && html.includes("img.className = 'pic'"))
check('图片点击可放大查看', html.includes('img.addEventListener(\'click\', function () { openImageView(dataUrl); })') && /id="img-view"/.test(html))

// ---------- 截屏 ----------
check('截屏按钮存在', /id="btn-shot"/.test(html) && html.includes('>截屏</button>'))
check('使用 getDisplayMedia({video:true})', /getDisplayMedia\(\{\s*video:\s*true/.test(html))
check('截屏取一帧后压缩并预览', /compressDrawable\(video, sw, sh\)/.test(html))
check('截图权限被拒/取消给中文提示', html.includes('截屏权限被拒绝或已取消'))
check('提示 iframe 场景：在浏览器打开后再试', html.includes('在浏览器打开'))
check('不支持 getDisplayMedia 时有中文兜底提示', html.includes('当前环境不支持截屏'))
check('截屏无人为未捕获异常：全链路 catch + finally 式收尾', /\.catch\(function \(err\) \{/.test(html) && html.includes('stopActiveStream()'))

// ---------- 结束清理 ----------
check('清理函数存在（finish / resetToStart）', /function finish\(reason\)/.test(html) && /function resetToStart\(notice\)/.test(html))
check('关闭 EventSource（es.close）', /es\.close\(\)/.test(html) && /function closeEvents\(\)/.test(html))
check('清空 #msgs DOM', /wipeMessages/.test(html) && /msgsBox\.innerHTML = ''/.test(html))
check('密钥置 null（encKey/macKey/pairKey）', /encKey = null/.test(html) && /macKey = null/.test(html) && /pairKey = null/.test(html))
check('状态/房间置 null 并回开始页', /roomId = null/.test(html) && /state = 'idle'/.test(html) && /show\('start'\)/.test(html))
check('清空预览与图片引用（preview=null + 移除 img src）', /preview = null/.test(html) && /removeAttribute\('src'\)/.test(html))
check('重置表单与预览区', /pwd-a'\)\.value = ''/.test(html) && /\$\('text'\)\.value = ''/.test(html) && /classList\.add\('hidden'\)/.test(html))
check('断线结束也走清理（连接断开→finish）', html.includes('连接已断开，会话已结束。') && /m\.type === 'end'/.test(html))
check('结束后丢弃旧 cid（新会话新标识）', /cid = rnd\(\)/.test(html))
check('页面不写任何持久化数据（无 fetch 之外的存储 API）', !/navigator\.storage/.test(html))
check('innerHTML 仅用于清空（无用户数据注入）', (html.match(/\.innerHTML\s*=(?!=)\s*[^;]+/g) || []).every((m) => /=\s*(''|"")\s*$/.test(m.trim())))

// ---------- 内联脚本语法 ----------
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
const inline = scripts.find((s) => s.includes("'use strict'")) || ''
check('存在内联脚本', inline.length > 1000, `${inline.length} chars`)
let syntaxOk = true
let syntaxErr = ''
try {
  // 只做语法解析，不执行；函数体里可以有 async/await
  // eslint-disable-next-line no-new-func
  new Function(inline)
} catch (err) {
  syntaxOk = false
  syntaxErr = err.message
}
check('内联脚本语法可解析', syntaxOk, syntaxErr)

const tagCount = (html.match(/class="msg /g) || []).length
check('消息气泡样式体系完整（sys/self/peer）', /\.msg\.sys\{/.test(html) && /\.msg\.self\{/.test(html) && /\.msg\.peer\{/.test(html))

const failed = checks.filter((c) => !c.ok)
console.log(`\n===== ${checks.length - failed.length}/${checks.length} UI static checks passed =====`)
if (failed.length) {
  for (const f of failed) console.log(`FAIL: ${f.name} — ${f.detail}`)
  process.exit(1)
}
console.log('ALL UI STATIC CHECKS PASSED')
