/**  联机：对手的提问由对手自己答（本地只等） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, api, check } from './harness.mjs';

console.log('\n 联机：对手的提问由对手自己答（本地只等）');

// 界面能不能分流，全靠请求自己写清「归哪一侧答」。
// 漏写一个，那一问就变成「谁都能点」 联机里等于替对手做决定。
check('引擎的每个交互请求都写了 side（归哪一侧答）', () => {
  const files = ['engine/src/actions.js', 'engine/src/targets.js', 'engine/src/combat.js', 'engine/src/choices.js'];
  let n = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/type: '(choose\w+|combatTarget)'/g)) {
      n++;
      const seg = src.slice(m.index, m.index + 260);
      if (!/\bside[,:]/.test(seg)) throw new Error(f + ' 里的 ' + m[1] + ' 请求没写 side，界面就分不清该谁答');
    }
  }
  if (n < 6) throw new Error('只扫到 ' + n + ' 个交互请求，源码结构可能变了');
});

check('联机：对手打出的牌要选效果时，本地不能替他选（只显示等待）', () => {
  const r = api.__demoLanChoice({ mySide: 0, owner: 'foe' });
  if (r.error) throw new Error('现场没造出来：' + r.error);
  if (!r.pending) throw new Error('对手打出需要抉择的牌之后没有挂起请求');
  if (r.requestSide !== 1) throw new Error('请求没写清归对手（side=1），实际 requestSide=' + r.requestSide);
  if (r.clickable) throw new Error('本地渲染出了可点的选项  等于让本地替对手做决定');
  if (!r.waiting) throw new Error('没有显示「等待对手选择」');
  if (r.sentAfterClick.length) throw new Error('本地点下去把答案发出去了：' + JSON.stringify(r.sentAfterClick));
  if (!r.pendingAfterClick) throw new Error('本地点了一下居然把挂起推进了');
});

check('联机：自己打出的牌需要选择时，本地照常点（对照）', () => {
  const r = api.__demoLanChoice({ mySide: 0, owner: 'me' });
  if (r.error) throw new Error('现场没造出来：' + r.error);
  if (!r.pending) throw new Error('自己打出需要抉择的牌之后没有挂起请求');
  if (r.requestSide !== 0) throw new Error('请求该归我（side=0），实际 requestSide=' + r.requestSide);
  if (!r.clickable) throw new Error('自己的提问没有渲染成可点选项');
  if (r.sentAfterClick.length !== 1) throw new Error('点了没发出去（应恰好 1 条 {k:c}）：' + JSON.stringify(r.sentAfterClick));
  if (r.sentAfterClick[0].k !== 'c') throw new Error('点下去发的不是 {k:c}：' + JSON.stringify(r.sentAfterClick[0]));
  if (!r.sentAfterClick[0].v || r.sentAfterClick[0].v.index !== 0) throw new Error('答案内容不对：' + JSON.stringify(r.sentAfterClick[0]));
});

check('联机：客人那一侧同样按 side 分流（对照）', () => {
  const foe = api.__demoLanChoice({ mySide: 1, owner: 'foe' }); // 主机打出的牌 -> 归 side 0
  if (foe.error) throw new Error('现场没造出来：' + foe.error);
  if (foe.requestSide !== 0) throw new Error('客人侧：请求该归主机（side=0），实际 ' + foe.requestSide);
  if (foe.clickable) throw new Error('客人错把主机的提问渲染成可点选项');
  if (!foe.waiting) throw new Error('客人侧没有显示「等待对手选择」');
  if (foe.sentAfterClick.length) throw new Error('客人替主机把答案发出去了：' + JSON.stringify(foe.sentAfterClick));
  const mine = api.__demoLanChoice({ mySide: 1, owner: 'me' }); // 客人自己的牌 -> 归 side 1
  if (mine.error) throw new Error('现场没造出来：' + mine.error);
  if (mine.requestSide !== 1) throw new Error('客人侧：自己的请求该是 side=1，实际 ' + mine.requestSide);
  if (!mine.clickable) throw new Error('客人自己的提问没有渲染成可点选项');
  if (mine.sentAfterClick.length !== 1) throw new Error('客人点自己的提问没发出去：' + JSON.stringify(mine.sentAfterClick));
});

// 复原现场：这一组把会话/局面换来换去，别把后面的检查带进联机状态
api.__go('home');
api.__newGame();
