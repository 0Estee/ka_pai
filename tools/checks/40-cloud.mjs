/** § 云存档：首页入口、账户页、登录/同步、管理员页的界面契约（不连真服务端） */
import fs from 'node:fs';
import path from 'node:path';
import { api, elements, check, ROOT, sandbox } from './harness.mjs';

console.log('\n§ 云存档');

const stageHTML = () => (elements.get('stage') ? elements.get('stage').innerHTML : '') || '';
const readSource = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 假 fetch：只实现云存档用到的几个路由，用来验证客户端状态机 */
function makeCloudFetch() {
  const state = { save: null, users: [], loginUser: null };
  const reply = (obj, status) => ({
    ok: (status || 200) >= 200 && (status || 200) < 300,
    status: status || 200,
    text: async () => JSON.stringify(obj),
  });
  const fetchFn = async (url, init) => {
    const u = new URL(String(url));
    const method = String((init && init.method) || 'GET').toUpperCase();
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = null; }
    if (u.pathname === '/api/auth/login' || u.pathname === '/api/auth/register') {
      const username = body && body.username ? body.username : 'alice';
      const user = state.loginUser || { username, role: 'user' };
      return reply({ ok: true, token: 'tok-' + user.username, user });
    }
    if (u.pathname === '/api/auth/me') {
      const user = state.loginUser || { username: 'alice', role: 'user' };
      return reply({ ok: true, user });
    }
    if (u.pathname === '/api/auth/logout') return reply({ ok: true });
    if (u.pathname === '/api/save' && method === 'GET') return reply({ ok: true, save: state.save });
    if (u.pathname === '/api/save' && method === 'PUT') {
      const version = (state.save && state.save.version ? state.save.version : 0) + 1;
      state.save = { data: body ? body.data : null, version, updatedAt: new Date().toISOString() };
      return reply({ ok: true, save: { version, updatedAt: state.save.updatedAt } });
    }
    if (u.pathname === '/api/admin/users') return reply({ ok: true, users: state.users });
    return reply({ ok: false, error: 'not-found', message: '没有这个接口' }, 404);
  };
  return { fetchFn, state };
}

const cloudFetch = makeCloudFetch();
sandbox.fetch = cloudFetch.fetchFn;
sandbox.URL = URL;

check('首页出现云存档入口（未登录写登录 / 注册）', () => {
  api.__go('home');
  const html = stageHTML();
  for (const marker of ['data-act="open-account"', '云存档', '登录 / 注册']) {
    if (!html.includes(marker)) throw new Error('首页缺少 ' + marker);
  }
});

check('未登录的账户页有用户名 / 密码输入与登录 / 注册按钮', () => {
  api.__go('account');
  const html = stageHTML();
  for (const marker of [
    'id="cloud-user"', 'id="cloud-pass"',
    'data-act="cloud-login"', 'data-act="cloud-register"',
    '云存档同步金币、等级与强化进度',
  ]) {
    if (!html.includes(marker)) throw new Error('账户页缺少 ' + marker);
  }
});

check('未登录的管理页不渲染用户表，只显示需要管理员权限', () => {
  api.__go('admin');
  const html = stageHTML();
  if (!html.includes('需要管理员权限')) throw new Error('管理页没有权限提示');
  if (html.includes('data-act="cloud-admin-delete"')) throw new Error('未登录不该渲染删号按钮');
});

check('cloud 状态初值结构正确', () => {
  const c = api.__cloud();
  if (!c || typeof c !== 'object') throw new Error('__cloud() 没有返回对象');
  if (c.user !== null) throw new Error('未登录时 user 应为 null');
  if (!c.admin || !Array.isArray(c.admin.users)) throw new Error('admin.users 应为数组');
  if (c.conflict !== null) throw new Error('初始 conflict 应为 null');
});

check('客户端源码不含管理员口令', () => {
  for (const rel of ['app/js/cloud.js', 'app/js/screens.js']) {
    if (readSource(rel).includes('1145145')) throw new Error(rel + ' 里出现了管理员口令');
  }
});

// ── 用假 fetch 走一遍登录 + 上传 + 云端恢复 + 管理员列表 ─────────────
const loginUserResult = await api.__cloudCall('login', 'alice', 'secret1');
check('登录后进入已登录态，并把本地空档上传到云端', () => {
  if (!loginUserResult || loginUserResult.ok === false) throw new Error('登录失败：' + JSON.stringify(loginUserResult));
  const c = api.__cloud();
  if (!c.user || c.user.username !== 'alice') throw new Error('登录后 user 不对');
  if (c.lastVersion !== 1) throw new Error('上传后云端版本应为 1，实际 ' + c.lastVersion);
  if (!cloudFetch.state.save) throw new Error('假服务端没有收到存档');
});

check('已登录的账户页显示同步与退出登录', () => {
  api.__go('account');
  const html = stageHTML();
  for (const marker of ['alice', 'data-act="cloud-logout"', 'data-act="cloud-push"', 'data-act="cloud-pull"']) {
    if (!html.includes(marker)) throw new Error('已登录账户页缺少 ' + marker);
  }
});

await api.__cloudCall('logout');
check('退出登录后回到未登录态', () => {
  const c = api.__cloud();
  if (c.user !== null) throw new Error('退出后 user 仍存在');
});

// 云端有进度、本地也有进度：登录必须进入冲突态，不能自动覆盖任何一边
cloudFetch.state.save = {
  data: { v: 2, gold: 999, dust: 7, perf: 10, games: 5, wins: 3, losses: 2, draws: 0, forge: { v: 1, cards: {} } },
  version: 3,
  updatedAt: new Date().toISOString(),
};
cloudFetch.state.loginUser = { username: 'bob', role: 'user' };
const loginBobResult = await api.__cloudCall('login', 'bob', 'secret2');
check('两边都有进度时进入冲突态，不自动覆盖', () => {
  if (!loginBobResult || loginBobResult.ok === false) throw new Error('登录失败：' + JSON.stringify(loginBobResult));
  const c = api.__cloud();
  if (!c.conflict) throw new Error('本地已有进度，登录后应进入冲突态');
  if (c.lastVersion !== 3) throw new Error('云端版本应为 3');
  if (api.__profile().gold === 999) throw new Error('冲突时不该自动采用云端');
});

await api.__cloudCall('useCloud');
check('冲突里选「用云端」后本地档案被云端覆盖', () => {
  const p = api.__profile();
  if (!p || p.gold !== 999 || p.games !== 5) throw new Error('没有采用云端存档：' + JSON.stringify({ gold: p && p.gold, games: p && p.games }));
  if (api.__cloud().conflict) throw new Error('采用云端后冲突态没有清掉');
});

await api.__cloudCall('logout');
// 管理员：列表、重置、删号按钮
cloudFetch.state.loginUser = { username: '123', role: 'admin' };
cloudFetch.state.users = [
  { username: 'alice', role: 'user', createdAt: new Date().toISOString(), updatedAt: '', lastLoginAt: '',
    save: { version: 1, updatedAt: new Date().toISOString(), bytes: 120, summary: { games: 2, wins: 1, perf: 4, gold: 120 } } },
  { username: '123', role: 'admin', createdAt: new Date().toISOString(), updatedAt: '', lastLoginAt: '', save: null },
];
const loginAdminResult = await api.__cloudCall('login', '123', 'whatever');
await api.__cloudCall('loadAdminUsers');
check('管理员登录后能看到用户表和重置 / 删除按钮', () => {
  if (!loginAdminResult || loginAdminResult.ok === false) throw new Error('管理员登录失败');
  api.__go('admin');
  const html = stageHTML();
  for (const marker of ['alice', 'data-act="cloud-admin-delete"', 'data-user="alice"',
    'data-act="cloud-admin-reset"', 'id="cloud-admin-pass"', 'data-act="cloud-admin-refresh"']) {
    if (!html.includes(marker)) throw new Error('管理页缺少 ' + marker);
  }
  if (!html.includes('对局 2')) throw new Error('管理页没有显示存档摘要');
});

check('账户页对管理员显示用户管理入口', () => {
  api.__go('account');
  if (!stageHTML().includes('data-act="cloud-admin-open"')) throw new Error('管理员账户页缺少用户管理入口');
});
