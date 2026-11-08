#!/usr/bin/env node
/**
 * 云存档协议的本地假服务器（只给测试用，不参与构建）。
 *
 *   node tools/cloud-mock.mjs --port 8799
 *
 * 实现 docs/云存档协议.md 里手机端会用到的那几条：注册 / 登录 / me / 登出 /
 * 改密码 / GET PUT /api/save。数据全在内存里，进程退出即清空。
 */
import http from 'node:http';

const argv = process.argv.slice(2);
const port = Number((argv[argv.indexOf('--port') + 1] || 8799));

const users = new Map();     // username -> { password, role, token, save }
let seq = 0;

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function tokenOf(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer (.+)$/.exec(h);
  return m ? m[1] : '';
}

function userByToken(token) {
  if (!token) return null;
  for (const [name, u] of users) if (u.token === token) return { name, ...u };
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    if (raw) {
      try { body = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: 'bad-json' }); }
    }
    if (path === '/api/health') return json(res, 200, { ok: true, version: 1, online: true, mock: true });

    if (path === '/api/auth/register') {
      const name = String(body.username || '').trim();
      const pass = String(body.password || '');
      if (name.length < 2 || pass.length < 6) return json(res, 400, { ok: false, error: 'bad-args', message: '用户名至少 2 字，密码至少 6 位' });
      if (users.has(name)) return json(res, 409, { ok: false, error: 'exists', message: '用户名已存在' });
      const token = 't' + (++seq);
      users.set(name, { password: pass, role: name === 'admin' ? 'admin' : 'user', token, save: null, version: 0 });
      return json(res, 200, { ok: true, token, user: { username: name, role: name === 'admin' ? 'admin' : 'user' } });
    }

    if (path === '/api/auth/login') {
      const name = String(body.username || '').trim();
      const u = users.get(name);
      if (!u || u.password !== String(body.password || '')) return json(res, 401, { ok: false, error: 'bad-login', message: '用户名或密码不对' });
      u.token = 't' + (++seq);
      return json(res, 200, { ok: true, token: u.token, user: { username: name, role: u.role } });
    }

    const me = userByToken(tokenOf(req));
    if (path === '/api/auth/me') {
      if (!me) return json(res, 401, { ok: false, error: 'unauthorized', message: '请先登录' });
      return json(res, 200, { ok: true, user: { username: me.name, role: me.role, createdAt: 0, lastLoginAt: 0 } });
    }
    if (path === '/api/auth/logout') return json(res, 200, { ok: true });
    if (path === '/api/auth/password') {
      if (!me) return json(res, 401, { ok: false, error: 'unauthorized', message: '请先登录' });
      if (me.password !== String(body.currentPassword || '')) return json(res, 401, { ok: false, error: 'bad-password', message: '原密码不对' });
      const u = users.get(me.name);
      u.password = String(body.newPassword || '');
      u.token = 't' + (++seq);
      return json(res, 200, { ok: true, token: u.token });
    }

    if (path === '/api/save') {
      if (!me) return json(res, 401, { ok: false, error: 'unauthorized', message: '请先登录' });
      const u = users.get(me.name);
      if (req.method === 'GET') {
        return json(res, 200, { ok: true, save: u.save ? { data: u.save, version: u.version, updatedAt: Date.now() } : null });
      }
      if (req.method === 'PUT') {
        const base = Number(body.baseVersion || 0);
        if (base !== u.version) {
          return json(res, 409, { ok: false, error: 'conflict', message: '存档版本冲突', save: { data: u.save, version: u.version, updatedAt: Date.now() } });
        }
        const text = JSON.stringify(body.data || {});
        if (Buffer.byteLength(text) > 64 * 1024) return json(res, 413, { ok: false, error: 'too-large', message: '存档过大' });
        u.save = body.data || {};
        u.version += 1;
        return json(res, 200, { ok: true, save: { version: u.version, updatedAt: Date.now() } });
      }
    }

    json(res, 404, { ok: false, error: 'not-found' });
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log('[cloud-mock] listening on http://127.0.0.1:' + port);
});
