/** § 管理后台：改玩家数据（0.69.0）—— 真渲染 + 真请求体，不抢其它分组的假 fetch */
import fsx from 'node:fs';
import pathx from 'node:path';
import { api, acheck, check, elements, ROOT } from './harness.mjs';

console.log('\n§ 管理后台：改玩家数据');

const stageHTML = () => (elements.get('stage') ? elements.get('stage').innerHTML : '') || '';
const readSource = (rel) => fsx.readFileSync(pathx.join(ROOT, rel), 'utf8');
const flush = () => new Promise((r) => setImmediate(r));
/** 最近的请求里最后一条打到 path 的（后台刷新列表会插进别的请求，不能只看最后一条） */
const lastReqTo = (frag, method) => {
  const list = api.__cloudRequests() || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (!r) continue;
    if (method && r.method !== method) continue;
    if (String(r.path).includes(frag)) return r;
  }
  return null;
};
/**
 * 取输入框桩。必须走 api.document.getElementById（它会按需创建），
 * 不能用 harness 导出的 elements.get —— 那个 Map 里只有「应用真的查过」的 id。
 */
const input = (id) => api.document.getElementById(id);

/** 一份「读出来的」云端存档，数值故意不整齐，方便确认表单是不是真的照它填的 */
const SAVE = {
  data: {
    v: 2, gold: 120, dust: 30, perf: 640, games: 12, wins: 7, losses: 5, draws: 0,
    forge: { v: 1, cards: { U01: { lvl: 9, masteries: ['w_atk'] }, U02: { lvl: 3, masteries: [] } } },
  },
  version: 4,
  updatedAt: '2026-10-22T21:10:00.000Z',
  bytes: 186,
  summary: { games: 12, wins: 7, perf: 640, gold: 120 },
};

/*
 * ⚠ 这里**不替换 globalThis.fetch**。
 *   40-cloud.mjs 的云存档检查是异步跑的，抢掉 fetch 会让它后面几条读到 404
 *   （踩过一次：一换 fetch，§ 云存档 里五条检查连环失败）。
 *   所以：渲染分支用 __adminDemo / __adminEditShow 直接摆状态，
 *        「点了保存到底发了什么」用 cloud.lastCloudRequest() 看 —— 请求体在真正
 *        fetch 之前就记下来了，没有网络也能断言。
 */

check('管理员后台：用户卡片上有「改数据」入口，但没点之前不画表单', () => {
  api.__adminDemo();
  api.__go('admin');
  const html = stageHTML();
  if (!html.includes('data-act="cloud-admin-edit"')) throw new Error('用户卡片上没有「改数据」按钮');
  if (!html.includes('data-user="alice"')) throw new Error('「改数据」按钮没有带上用户名');
  if (html.includes('id="admin-gold"')) throw new Error('没点「改数据」就把表单画出来了');
  if (!html.includes('最近的管理操作')) throw new Error('没有「最近的管理操作」这一块');
  if (!html.includes('123 改了 alice 的')) throw new Error('审计日志那一行没有渲染出来');
});

check('点「改数据」：表单里是这个人的真实数值（不是 0，也不是别人的）', () => {
  api.__adminEditShow('alice', SAVE);
  api.__go('admin');
  const html = stageHTML();
  for (const marker of ['id="admin-gold"', 'id="admin-dust"', 'id="admin-perf"', 'id="admin-games"',
    'id="admin-wins"', 'id="admin-losses"', 'id="admin-draws"',
    'data-act="cloud-admin-save"', 'data-act="cloud-admin-clear-forge"',
    'data-act="cloud-admin-raw"', 'data-act="cloud-admin-edit-close"']) {
    if (!html.includes(marker)) throw new Error('改数据面板缺少 ' + marker);
  }
  for (const [id, v] of [['admin-gold', 120], ['admin-dust', 30], ['admin-perf', 640], ['admin-games', 12], ['admin-wins', 7]]) {
    const re = new RegExp('id="' + id + '"[^>]*value="' + v + '"');
    if (!re.test(html)) throw new Error('表单里 ' + id + ' 不是 ' + v + '：' + (html.match(new RegExp('id="' + id + '"[^>]*')) || ['?'])[0]);
  }
  if (!html.includes('云端 v4')) throw new Error('没有显示当前云端版本');
  if (!html.includes('2 张牌有强化')) throw new Error('没有告诉管理员这个人有多少张强化过的牌');
  // 表现分旁边要顺手写「这是几级」
  if (!html.includes('Lv.')) throw new Error('表现分那一格没有推算出的等级');
  // 别人（bob / 123）的卡片里不能长出这块面板
  const bobBlock = html.slice(html.indexOf('bob'), html.indexOf('bob') + 400);
  if (bobBlock.includes('admin-gold')) throw new Error('面板长到了别人的卡片里');
});

await acheck('保存数值：点下去真的发了一条 patch（字段与表单一致）', async () => {
  api.__adminEditShow('alice', SAVE);
  api.__go('admin');
  input('admin-gold').value = '700';
  input('admin-dust').value = '90';
  input('admin-perf').value = '1200';
  input('admin-games').value = '20';
  const before = (api.__cloudRequests() || []).length;
  api.__nav('cloud-admin-save', {});
  await flush();
  await flush();
  const req = lastReqTo('/api/admin/save', 'POST');
  const after = (api.__cloudRequests() || []).length;
  if (!req || after <= before) throw new Error('点保存后没有发出任何请求');
  if (req.method !== 'POST' || !String(req.path).includes('/api/admin/save')) {
    throw new Error('保存没有打到 /api/admin/save：' + JSON.stringify({ m: req.method, p: req.path }));
  }
  if (!req.body || req.body.username !== 'alice') throw new Error('请求里没有 username：' + JSON.stringify(req.body));
  const p = req.body.patch;
  if (!p) throw new Error('数值保存应该走 patch，而不是整份替换');
  if (p.gold !== 700 || p.dust !== 90 || p.perf !== 1200 || p.games !== 20) {
    throw new Error('提交的数和输入框不一致：' + JSON.stringify(p));
  }
  if (req.body.data) throw new Error('数值保存不该同时带 data');
  // 收尾：把状态摆回「刚写完」的样子，后面的用例才有确定画面
  api.__adminEditState({ form: { gold: 700, dust: 90, perf: 1200, games: 20, wins: 7, losses: 5, draws: 0 }, version: 5, saving: false, error: '' });
});

check('保存成功后的面板：一句「已写入云端」+ 版本号 + 新值', () => {
  // 重新摆一遍面板再叠「刚写完」的状态：上一条用例的保存打到了假服务端（404），
  // 这里要的是**成功分支**的画面，不依赖上一条的结果。
  api.__adminDemo();
  api.__adminEditShow('alice', SAVE);
  api.__adminEditState({
    form: { gold: 700, dust: 90, perf: 1200, games: 20, wins: 7, losses: 5, draws: 0 },
    hint: '已写入云端 v5。玩家下次同步时选「用云端」即可生效。',
    version: 5,
    saving: false,
    error: '',
  });
  api.__go('admin');
  const html = stageHTML();
  if (!html.includes('已写入云端')) throw new Error('保存成功后没有回一句「已写入云端」');
  if (!html.includes('云端 v5')) throw new Error('保存后版本号没有刷成 v5');
  if (!html.includes('value="700"')) throw new Error('保存后表单没有刷成新值（金币 700）');
});

await acheck('「清空强化」：发出去的 patch.forge 是空表', async () => {
  api.__adminEditShow('alice', SAVE);
  api.__go('admin');
  const before = (api.__cloudRequests() || []).length;
  api.__nav('cloud-admin-clear-forge', {});
  await flush();
  await flush();
  const req = lastReqTo('/api/admin/save', 'POST');
  if (!req || (api.__cloudRequests() || []).length <= before) throw new Error('没有发出清空强化的请求');
  const f = req.body && req.body.patch && req.body.patch.forge;
  if (!f) throw new Error('清空强化发的不是 patch.forge：' + JSON.stringify(req.body));
  if (Object.keys(f.cards || {}).length !== 0) throw new Error('forge.cards 不是空表：' + JSON.stringify(f));
  if (req.body.data) throw new Error('清空强化不该整份替换');
});

await acheck('出错与未登录的分支：说明白，不放行', async () => {
  api.__adminEditState({ error: '读取该玩家的存档失败，请稍后重试', hint: '' });
  api.__go('admin');
  if (!stageHTML().includes('读取该玩家的存档失败')) throw new Error('错误提示没有渲染出来');
  await api.__cloudCall('logout');
  const res = await api.__cloudCall('adminEditOpen', 'alice');
  if (!res || res.ok !== false) throw new Error('没登录也能打开改数据面板');
  api.__go('admin');
  if (stageHTML().includes('id="admin-gold"')) throw new Error('没登录还画出了改数据表单');
});

await acheck('高级：JSON 分支 —— 格式错不发请求、格式对才整份替换', async () => {
  api.__adminDemo();
  api.__adminEditShow('alice', SAVE);
  api.__adminEditState({ rawOpen: true });
  api.__go('admin');
  if (!stageHTML().includes('id="admin-raw"')) throw new Error('展开高级编辑后没有 JSON 输入框');

  const beforeBad = api.__cloudLastRequest();
  input('admin-raw').value = '{ 这不是 JSON';
  api.__nav('cloud-admin-save-raw', {});
  await flush();
  await flush();
  if (api.__cloudLastRequest() !== beforeBad) throw new Error('JSON 都解析不了还发了请求');
  api.__go('admin');
  if (!stageHTML().includes('JSON 格式不对')) throw new Error('JSON 解析失败没有给出提示');

  input('admin-raw').value = JSON.stringify({ gold: 33, perf: 888, forge: { v: 1, cards: {} } });
  api.__nav('cloud-admin-save-raw', {});
  await flush();
  await flush();
  const req = api.__cloudLastRequest();
  if (!req || req === beforeBad) throw new Error('格式正确却没发请求');
  if (!req.body || !req.body.data || req.body.data.gold !== 33) throw new Error('整份替换没走 data：' + JSON.stringify(req.body));
  if (req.body.patch) throw new Error('整份替换不该同时带 patch');
});

check('界面契约（源码级）：字段、动作、样式、服务端路由都在', () => {
  const screens = readSource('app/js/screens.js');
  for (const act of ['cloud-admin-edit', 'cloud-admin-save', 'cloud-admin-clear-forge',
    'cloud-admin-raw', 'cloud-admin-save-raw', 'cloud-admin-edit-close']) {
    if (!screens.includes('data-act="' + act + '"')) throw new Error('screens.js 缺少 ' + act + ' 按钮');
  }
  const input = readSource('app/js/play-input.js');
  if (!input.includes("inputValue('admin-' + field)")) throw new Error('保存时没有从输入框读值');
  if (!input.includes('adminEditSetField')) throw new Error('保存前没有把输入值落进状态（重绘会冲掉刚敲的数）');
  const css = readSource('app/screens.css');
  for (const cls of ['.cloud-admin-edit', '.cloud-edit-grid', '.cloud-edit-input', '.cloud-raw', '.cloud-log-list']) {
    if (!css.includes(cls)) throw new Error('screens.css 缺少 ' + cls);
  }
  const server = readSource('cloudflare/src/users.js');
  for (const bit of ['ADMIN_NUMBER_LIMITS', 'cleanForge', '/api/admin/save', '/api/admin/log', 'appendAudit']) {
    if (!server.includes(bit)) throw new Error('服务端缺少 ' + bit);
  }
  // 普通用户不能改别人：服务端必须要求管理员
  const saveHandler = server.slice(server.indexOf('handleAdminSetSave'), server.indexOf('handleAdminSetSave') + 400);
  if (!saveHandler.includes('requireAdmin')) throw new Error('改数据接口没有要求管理员权限');
});
