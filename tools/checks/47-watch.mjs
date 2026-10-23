/** § 观战（作者 2026-10-23）：只读的第三条连接 */
import fsx from 'node:fs';
import pathx from 'node:path';
import { api, acheck, check, timers, ROOT } from './harness.mjs';

console.log('\n§ 观战');

/** 全局只跑一次：真的 Session × 2（房主 + 观战者），结果留给下面几条断言 */
let probe = null;
await acheck('观战者用真 Session 跑同一局：收到 start 能自己建局，且逐步与房主一致', async () => {
  if (!api.__watchProbe) throw new Error('缺少 __watchProbe 自检钩子');
  probe = await api.__watchProbe();
  if (!probe.watcherBuilt) throw new Error('观战者没有建出对局（start 没被接受）');
  if (!probe.sameHashAtStart) throw new Error('开局那一刻两边状态就不一致');
  if (!probe.sameHashAfter2) throw new Error('跑两步之后两边状态不一致：' + JSON.stringify(probe.steps));
  if (probe.steps.host !== probe.steps.watch) throw new Error('步数不一致：' + JSON.stringify(probe.steps));
  timers.clear();
});

check('观战者是只读的：submit 不被接受，transport.send 也发不出去', () => {
  if (!probe) throw new Error('前一条用例没跑成');
  if (probe.submitAccepted !== false) throw new Error('观战者居然提交成功了');
  if (!probe.sendResult || probe.sendResult.ok !== false || probe.sendResult.error !== 'read-only') {
    throw new Error('观战者的 send 没有被挡住：' + JSON.stringify(probe.sendResult));
  }
  if (probe.logGrewByWatcher !== 0) throw new Error('观战者往消息流里写了 ' + probe.logGrewByWatcher + ' 条');
});

check('缺一条 act 时观战者不去要 need（只读连接发不出请求），也不硬执行', () => {
  if (!probe) throw new Error('前一条用例没跑成');
  if (!probe.gapIgnored) throw new Error('缺步时观战者硬执行了那条 act —— 状态会永久错位');
  if (probe.needSent) throw new Error('观战者发了 need：它是只读连接，服务端会 403');
});

check('服务端契约（源码级）：观战者发消息 403、两端都走才算 peer-left、观战人数可查', () => {
  const doSrc = fsx.readFileSync(pathx.join(ROOT, 'cloudflare', 'src', 'room.js'), 'utf8');
  if (!doSrc.includes("whoRaw === 'watch'")) throw new Error('Cloudflare 房间不认 who=watch');
  if (!doSrc.includes("error: 'read-only'")) throw new Error('Cloudflare 没有拒绝观战者发消息');
  if (!/this\.left\.host && this\.left\.guest/.test(doSrc)) {
    throw new Error('观战者的结束条件不是「两端都走了」：一个人退出就会把观战者踢掉');
  }
  if (!doSrc.includes('watchCount()')) throw new Error('房间信息里没有观战人数');
  const javaSrc = fsx.readFileSync(pathx.join(ROOT, 'android', 'app', 'java', 'com', 'kaipai', 'prototype', 'net', 'HttpGameServer.java'), 'utf8');
  if (!javaSrc.includes('WHO_WATCH')) throw new Error('局域网服务端不认观战者（who=watch）');
  if (!javaSrc.includes('read-only')) throw new Error('局域网服务端没有拒绝观战者发消息');
});

check('界面：观战入口在联机菜单里，观战屏不显示重开 / 认输', () => {
  const screens = fsx.readFileSync(pathx.join(ROOT, 'app', 'js', 'screens.js'), 'utf8');
  if (!screens.includes("data-act=\"watch-join\"")) throw new Error('联机对决菜单里没有观战入口');
  if (!screens.includes('export function watchJoinHTML')) throw new Error('缺少观战入口页');
  if (!screens.includes('export function watchingHTML')) throw new Error('缺少观战等待页');
  const ui = fsx.readFileSync(pathx.join(ROOT, 'app', 'js', 'ui.js'), 'utf8');
  if (!ui.includes('hand-watch')) throw new Error('观战者的手牌区没有「不公开」那一版');
  if (!/view\.watcher === true/.test(ui)) throw new Error('界面没有区分观战者');
  const render = fsx.readFileSync(pathx.join(ROOT, 'app', 'js', 'render.js'), 'utf8');
  if (!/view\.watcher\s*\?/.test(render)) throw new Error('战报菜单没有按观战者分支（会露出「认输」）');
  const input = fsx.readFileSync(pathx.join(ROOT, 'app', 'js', 'play-input.js'), 'utf8');
  if (!input.includes('function isWatching')) throw new Error('输入层没有观战者闸门');
});

check('观战者不结算金币、不驱动回合循环（game-flow 里的两处闸）', () => {
  const flow = fsx.readFileSync(pathx.join(ROOT, 'app', 'js', 'game-flow.js'), 'utf8');
  const tick = flow.slice(flow.indexOf('function tick()'), flow.indexOf('function tick()') + 700);
  if (!/session\.isWatcher/.test(tick)) throw new Error('tick() 没有给观战者短路：它会自己推进回合，画面会和玩家那边错开');
  const settle = flow.slice(flow.indexOf('function settleIfNeeded()'), flow.indexOf('function settleIfNeeded()') + 500);
  if (!/session\.isWatcher/.test(settle)) throw new Error('settleIfNeeded() 没有挡住观战者：看棋的人会拿到金币');
});
