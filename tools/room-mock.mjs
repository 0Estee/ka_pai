#!/usr/bin/env node
// 联机房间假服务器（联机自检用）。
// 只实现 docs/联机协议.md 里客户端真正会调的那几个接口，语义照 cloudflare/src/room.js：
//   POST /api/send?who=&room=&name=    body = 消息 JSON   -> {ok:true,seq}
//   GET  /api/poll?since=&timeout=                        -> {ok:true,now,msgs,watchers}
//   POST /api/start?who=host                              -> {ok:true}
//   POST /api/leave                                       -> {ok:true}
//   GET  /api/room                                        -> {ok:true,room,players,watchers,started}
//   GET  /api/health                                      -> {ok:true}
// 用法： node tools/room-mock.mjs --port 8798
import http from 'node:http'

const argv = process.argv.slice(2)
const portArg = argv.indexOf('--port')
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 8798

/** room -> { players:{host:{name,lastSeen},guest:{...}}, msgs:[{seq,from,name,msg}], seq, started, watchers, waiters:[] } */
const rooms = new Map()

function room(code) {
  const key = String(code || '').toUpperCase()
  if (!key) return null
  let r = rooms.get(key)
  if (!r) {
    r = { code: key, players: {}, msgs: [], seq: 0, started: false, waiters: [] }
    rooms.set(key, r)
  }
  return r
}

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => (buf += c))
    req.on('end', () => resolve(buf))
  })
}

function flushWaiters(r) {
  const list = r.waiters
  r.waiters = []
  for (const w of list) w()
}

function pollPayload(r, since) {
  return {
    ok: true,
    now: r.seq,
    msgs: r.msgs.filter((m) => m.seq > since),
    watchers: Object.keys(r.players).filter((k) => k === 'watch').length,
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const who = url.searchParams.get('who') || ''
  const code = url.searchParams.get('room') || ''
  const name = url.searchParams.get('name') || ''
  const r = room(code)

  if (url.pathname === '/api/health') return json(res, 200, { ok: true, version: 1, online: true, rooms: rooms.size })

  if (!r) return json(res, 200, { ok: false, error: 'no-room', message: '房间号不对' })

  if (url.pathname === '/api/send' && req.method === 'POST') {
    const raw = await readBody(req)
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return json(res, 200, { ok: false, error: 'bad-json', message: '消息格式不对' })
    }
    if (who === 'host' || who === 'guest') {
      r.players[who] = { name: name || who, lastSeen: Date.now() }
    } else if (who === 'watch') {
      r.players.watch = { name: name || 'watch', lastSeen: Date.now() }
    }
    r.seq += 1
    r.msgs.push({ seq: r.seq, from: who, name: name || who, msg })
    if (r.msgs.length > 2000) r.msgs = r.msgs.slice(-1500)
    flushWaiters(r)
    return json(res, 200, { ok: true, seq: r.seq })
  }

  if (url.pathname === '/api/poll') {
    const since = Number(url.searchParams.get('since') || 0)
    const timeout = Math.min(25000, Number(url.searchParams.get('timeout') || 20000))
    if (who === 'host' || who === 'guest') r.players[who] = { name: name || who, lastSeen: Date.now() }
    // 对端离开：房主走了，客人立刻知道；客人走了，房主也知道（协议 §7）
    const other = who === 'host' ? 'guest' : who === 'guest' ? 'host' : null
    if (other && r.left && r.left[other] && !r.left[who]) {
      return json(res, 200, { ok: false, error: 'peer-left', message: '对手已经离开' })
    }
    if (r.msgs.some((m) => m.seq > since)) return json(res, 200, pollPayload(r, since))
    let done = false
    const wake = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      json(res, 200, pollPayload(r, since))
    }
    const timer = setTimeout(wake, timeout)
    r.waiters.push(wake)
    // 注意：req 的 'close' 在 GET 请求体读完就会触发（Node 的坑），要听 res 的
    res.on('close', () => {
      if (done) return
      done = true
      clearTimeout(timer)
      r.waiters = r.waiters.filter((w) => w !== wake)
    })
    return
  }

  if (url.pathname === '/api/start' && req.method === 'POST') {
    r.started = true
    flushWaiters(r)
    return json(res, 200, { ok: true })
  }

  if (url.pathname === '/api/leave' && req.method === 'POST') {
    r.left = r.left || {}
    r.left[who] = true
    if (who === 'host') {
      // 主机关房 = 房间消失
      rooms.delete(r.code)
    } else {
      flushWaiters(r)
    }
    return json(res, 200, { ok: true })
  }

  if (url.pathname === '/api/room') {
    return json(res, 200, {
      ok: true,
      room: r.code,
      players: Object.keys(r.players).filter((k) => k !== 'watch').length,
      watchers: Object.keys(r.players).filter((k) => k === 'watch').length,
      started: r.started,
    })
  }

  return json(res, 404, { ok: false, error: 'not-found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('[room-mock] listening on http://127.0.0.1:' + PORT)
})
