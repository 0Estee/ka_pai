// Web 端（React + PixiJS）无头浏览器冒烟：起静态服务 + headless Chrome/CDP，
// 真点一遍「首页 → 工坊强化 → 开始对局 → 长按看详情 → 出牌 → 推回合」，截图存到 shots/。
//
//   node web/e2e/smoke.mjs            # 用 web/dist（先 node node_modules/vite/bin/vite.js build）
//   FRESH=1 node web/e2e/smoke.mjs    # 先清 localStorage，从新档开始
//
// 依赖：本机 Chrome（C:/Program Files/Google/Chrome/Application/chrome.exe）、已构建的 web/dist。
// 说明：window.__KP_EXPOSE=true 是 GameScreen 里的观察窗，注入后 window.__kp 即 GameController。

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = path.join(ROOT, 'web/dist')
const SHOTS = path.join(ROOT, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0])
  let file = path.join(DIST, p === '/' ? 'index.html' : p)
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(4173, '127.0.0.1', r))

const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--remote-debugging-port=9333', '--user-data-dir=' + path.join(HERE, '.chrome-profile'),
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
  '--window-size=430,932', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let version = null
for (let i = 0; i < 80; i++) {
  try { version = await (await fetch('http://127.0.0.1:9333/json/version')).json(); break } catch { await sleep(300) }
}
if (!version) { console.log('CHROME_FAIL'); process.exit(2) }

const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))

let seq = 0
const waiters = new Map()
const logs = []
ws.addEventListener('message', (evt) => {
  const msg = JSON.parse(evt.data)
  if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); return }
  if (msg.method === 'Runtime.consoleAPICalled') logs.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
  if (msg.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text))
})
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq
  waiters.set(id, (msg) => (msg.error ? rej(new Error(method + ': ' + JSON.stringify(msg.error))) : res(msg.result)))
  ws.send(JSON.stringify({ id, method, params }))
})

await send('Runtime.enable')
await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__KP_EXPOSE = true;' })
await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true })

const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}
const waitFor = async (expr, ms = 12000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true } catch {} await sleep(120) }
  return false
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'))
}
const clickText = async (text) => ev('(() => { const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim().includes(' + JSON.stringify(text) + ')); if (!b) return false; b.click(); return true })()')
const handLen = () => ev('document.querySelectorAll(".hand-scroll .card").length')

const out = {}
await send('Page.navigate', { url: 'http://127.0.0.1:4173/' })
out.home = await waitFor('!!document.querySelector(".home h1")')
if (process.env.FRESH) {
  await ev('localStorage.clear()')
  await send('Page.reload', {})
  await waitFor('!!document.querySelector(".home h1")')
}
out.wallet = await ev('document.querySelector(".wallet") ? document.querySelector(".wallet").textContent : ""')
await shot('web-home.png')

out.openWorkshop = await clickText('强化工坊')
out.workshop = await waitFor('!!document.querySelector(".workshop")')
out.wsCards = await ev('document.querySelectorAll(".ws-card").length')
out.wsGroups = await ev('[...document.querySelectorAll(".workshop .panel h2")].slice(0, 4).map(h => h.textContent)')
out.profileBefore = await ev('JSON.parse(localStorage.getItem("kp.web.profile.v1") || "null")')
out.enhancedCard = await ev('(() => { const rows = [...document.querySelectorAll(".ws-card")]; for (const row of rows) { const b = row.querySelectorAll(".ws-btn")[0]; if (b && !b.disabled) { const n = row.querySelector(".ws-card-name").textContent; b.click(); return n } } return null })()')
await sleep(600)
out.profileAfter = await ev('JSON.parse(localStorage.getItem("kp.web.profile.v1") || "null")')
out.wsFirstRow = await ev('(() => { const r = document.querySelector(".ws-card"); return r ? r.textContent : null })()')
await shot('web-workshop.png')
out.backHome = await clickText('返回大厅')
await sleep(300)

out.startGame = await clickText('开始对局')
out.game = await waitFor('!!document.querySelector(".game")')
await sleep(1500)
out.hud = await ev('document.querySelector(".hud") ? document.querySelector(".hud").innerText.replace(/\\n+/g, " | ") : ""')
out.kingBars = await ev('[...document.querySelectorAll(".king-hp")].map(e => e.textContent)')
out.handCount = await handLen()
out.playable = await ev('document.querySelectorAll(".hand-scroll .card.playable").length')
out.enhanceFed = await ev('(() => { const s = window.__kp && window.__kp.state; if (!s) return null; const e = s.enhance; if (!e) return "none"; return Array.isArray(e) ? e.map(x => Object.keys(x || {}).length) : Object.keys(e).length })()')
await shot('web-game-start.png')

out.fxHook = await ev('(() => { const k = window.__kp; if (!k) return false; const orig = k.drainFx.bind(k); window.__fx = []; k.drainFx = function () { const b = orig(); window.__fx.push(...b); return b }; return true })()')

out.longPressDetail = await ev('(async () => { const card = document.querySelector(".hand-scroll .card"); if (!card) return false; const r = card.getBoundingClientRect(); const o = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, pointerType: "touch", isPrimary: true }; card.dispatchEvent(new PointerEvent("pointerdown", o)); await new Promise(x => setTimeout(x, 620)); card.dispatchEvent(new PointerEvent("pointerup", o)); await new Promise(x => setTimeout(x, 200)); return !!document.querySelector(".detail-panel") })()')
out.detailText = await ev('document.querySelector(".detail-panel") ? document.querySelector(".detail-panel").innerText.replace(/\\n+/g, " | ").slice(0, 240) : ""')
await shot('web-card-detail.png')
out.closeDetail = await clickText('知道了')
await sleep(250)

let canvasRect = await ev('(() => { const c = document.querySelector("canvas"); if (!c) return null; const r = c.getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height } })()')
out.canvas = canvasRect

const cellPoint = (lane, row) => {
  const padX = Math.max(10, canvasRect.w * 0.03)
  const padY = Math.max(10, canvasRect.h * 0.03)
  const headerH = 26
  const colW = (canvasRect.w - 2 * padX) / 4
  const rowH = (canvasRect.h - 2 * padY - headerH) / 4
  return { x: canvasRect.left + padX + colW * (lane + 0.5), y: canvasRect.top + padY + headerH + rowH * (row + 0.5) }
}
const mouseClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await sleep(40)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

const clickEnd = () => ev('(() => { const b = [...document.querySelectorAll(".actions button")].find(x => x.textContent.includes("结束阶段")); if (!b || b.disabled) return false; b.click(); return true })()')
for (let r = 0; r < 5; r++) {
  const n = await ev('document.querySelectorAll(".hand-scroll .card.playable").length')
  if (n > 0) break
  await clickEnd()
  await sleep(1600)
  if (await ev('!!document.querySelector(".choice-panel")')) {
    await ev('(() => { const b = document.querySelector(".choice-btn"); if (b) b.click(); return !!b })()')
    await sleep(400)
  }
}
out.playableAfterWait = await ev('document.querySelectorAll(".hand-scroll .card.playable").length')

const plays = []
for (let i = 0; i < 6; i++) {
  const before = await handLen()
  const info = await ev('(async () => { const cards = [...document.querySelectorAll(".hand-scroll .card.playable")]; if (!cards.length) return null; const card = cards[0]; const name = card.querySelector(".card-name") ? card.querySelector(".card-name").textContent : ""; const isSpell = !card.querySelector(".card-stats .atk"); card.click(); await new Promise(r => setTimeout(r, 150)); return { name, isSpell } })()')
  if (!info) break
  if (!info.isSpell) {
    let placed = false
    const rect2 = await ev('(() => { const c = document.querySelector("canvas"); const r = c.getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height } })()')
    canvasRect = rect2
    for (const pair of [[0, 2], [1, 2], [2, 2], [3, 2], [0, 3], [1, 3], [2, 3], [3, 3]]) {
      const pt = cellPoint(pair[0], pair[1])
      await mouseClick(pt.x, pt.y)
      await sleep(240)
      if ((await handLen()) < before) { placed = true; break }
    }
    plays.push({ name: info.name, isSpell: false, placed })
  } else {
    await sleep(300)
    plays.push({ name: info.name, isSpell: true, placed: true })
  }
  if (await ev('!!document.querySelector(".choice-panel")')) {
    await ev('(() => { const b = document.querySelector(".choice-btn"); if (b) b.click(); return !!b })()')
    await sleep(350)
  }
}
out.plays = plays
out.fxEventsEarly = await ev('(() => { const a = window.__fx || []; const kinds = {}; for (const e of a) kinds[e.kind] = (kinds[e.kind] || 0) + 1; return { total: a.length, kinds, sample: a.slice(0, 8) } })()')
out.turnNow = await ev('(() => { const k = window.__kp; return k ? k.state.turn : null })()')
out.handNow = await handLen()
out.kingNow = await ev('[...document.querySelectorAll(".king-hp")].map(e => e.textContent)')
await shot('web-game-played.png')

for (let i = 0; i < 6; i++) {
  const clicked = await ev('(() => { const b = [...document.querySelectorAll(".actions button")].find(x => x.textContent.includes("结束阶段")); if (!b || b.disabled) return false; b.click(); return true })()')
  if (clicked) await sleep(800)
  if (await ev('!!document.querySelector(".choice-panel")')) {
    await ev('(() => { const b = document.querySelector(".choice-btn"); if (b) b.click(); return !!b })()')
    await sleep(300)
  }
}
await sleep(1500)
out.turnAfterEnd = await ev('(() => { const k = window.__kp; return k ? k.state.turn : null })()')
out.actorAfter = await ev('(() => { const k = window.__kp; return k ? k.state.actor : null })()')
out.winner = await ev('(() => { const k = window.__kp; return k ? (k.state.winner === undefined ? null : k.state.winner) : null })()')
out.fxQueuedEnd = await ev('(() => { const k = window.__kp; return k ? (k.fxQueue ? k.fxQueue.length : -2) : null })()')
await shot('web-game-turn2.png')

out.fxEventsAfter = await ev('(() => { const a = window.__fx || []; const kinds = {}; for (const e of a) kinds[e.kind] = (kinds[e.kind] || 0) + 1; return { total: a.length, kinds, sample: a.slice(0, 10) } })()')
out.consoleErrors = logs.filter((l) => l.indexOf('error') === 0 || l.indexOf('EXCEPTION') === 0).slice(0, 12)
out.consoleSample = logs.slice(0, 12)

console.log(JSON.stringify(out, null, 1))
ws.close()
chrome.kill()
server.close()
process.exit(0)
