/** § 回放录制与播放 */
import { api, elements, check } from './harness.mjs';
import { N } from './05-integrated-game.mjs';

console.log('\n§ 回放录制与播放');

check(`${N} 局全部存进了回放档案`, () => {
  const rs = api.__replays();
  if (rs.length !== N) throw new Error(`应有 ${N} 条回放，实际 ${rs.length}`);
  for (const r of rs) {
    if (!Array.isArray(r.actions) || r.actions.length === 0) throw new Error('有回放没有记录到操作');
    if (!r.id) throw new Error('回放缺少 id');
  }
});

check('回放能从头精确重放到同一个终局', () => {
  const rs = api.__replays();
  // 全部验证太重，抽查前 6 条足够覆盖不同局面
  for (let i = 0; i < Math.min(6, rs.length); i++) {
    const v = api.__replayVerify(i);
    if (v.error) throw new Error(`第 ${i + 1} 条回放出错: ${v.error}`);
    if (!v.ok) {
      throw new Error(`第 ${i + 1} 条回放复现不一致：录的是 winner=${v.expectWinner}/turn=${v.expectTurn}，`
        + `重放出来是 winner=${v.winner}/turn=${v.turn}`);
    }
  }
});

check('回放播放器能步进并渲染出棋盘', () => {
  const d = api.__replayDemo(0, 20);
  if (d.error) throw new Error(d.error);
  if (d.screen !== 'replay') throw new Error(`应停在 replay 屏幕，实际 ${d.screen}`);
  if (d.index <= 0) throw new Error('步进后 index 仍然为 0');
  if (d.htmlLength < 1200) throw new Error(`回放界面渲染体积仅 ${d.htmlLength}`);
});

check('冷启动（内存里还没有对局）也能打开回放', () => {
  // 真实场景：打开 App → 直接点「回放对局」→ 点「回放」。
  // 这时 state 是 null，而 refresh() 的回放分支曾经会去读它（computePlayable）
  // → TypeError，refresh() 中断在中间，界面停在回放列表 ——
  // 玩家看到的就是「点回放没反应」。
  const rec = api.__replays()[0];
  if (!rec) throw new Error('没有可用的回放记录');

  api.__dropLiveGame();
  if (api.__game()) throw new Error('__dropLiveGame 没有把内存里的对局丢掉');

  api.__go('replays');
  if (api.__screen() !== 'replays') throw new Error('进不了回放列表');
  api.__nav('replay-open', { id: rec.id });
  if (api.__screen() !== 'replay') throw new Error(`应进 replay，实际 ${api.__screen()}`);

  const html = elements.get('stage').innerHTML;
  if (html.length < 1200) throw new Error(`回放界面只渲染了 ${html.length} 字节，疑似中途抛异常`);
  if (!html.includes('data-act="replay-toggle"')) throw new Error('回放控制条没渲染出来');
  if (html.includes('data-act="replay-open"')) throw new Error('还停在回放列表上，说明 refresh() 没走到回放分支');

  // 冷启动下也要真的能往后播
  api.__nav('replay-next');
  if (elements.get('stage').innerHTML.length < 1200) throw new Error('冷启动下步进回放失败');

  // 还原现场：后面的测试依赖内存里有一局
  api.__go('home');
  api.__newGame();
});

check('回放可以写备注', () => {
  // 写到第 2 条上：下面要删第 1 条来验证删除，别把带备注的删掉
  const r = api.__replayNote(1, '测试备注');
  if (!r) throw new Error('写备注失败');
  if (r.note !== '测试备注') throw new Error(`备注没写进去，实际 ${JSON.stringify(r.note)}`);
});

check('回放可以删除', () => {
  const before = api.__replays().length;
  const after = api.__replayDelete(0);
  if (after !== before - 1) throw new Error(`删除后应剩 ${before - 1} 条，实际 ${after}`);
});

check('回放会写进原生存档通道（首页 file:// 与联机页 http:// 共用同一份）', () => {
  // 作者反馈「每局打完不会生成回放」的根因：
  // localStorage 是**按来源隔离**的，首页来自 file:///android_asset/index.html，
  // 联机页来自 http://主机:8765  在联机页打完的那局回放回首页就看不到；
  // 而且 file:// 来源在部分设备上连 localStorage 都拿不到（只能退化到内存）。
  // 所以回放必须和玩家档案一样走 SharedPreferences（KapaiNative）。
  const before = api.__replays().length;
  let written = null;
  const had = api.KapaiNative;
  api.KapaiNative = {
    readProfile: () => '',
    writeProfile: () => 'true',
    readReplays: () => '',
    writeReplays: (s) => { written = s; return 'true'; },
  };
  let run = null;
  try {
    api.__go('home');
    run = api.__autoPlay();
  } finally {
    if (had === undefined) delete api.KapaiNative; else api.KapaiNative = had;
  }
  if (run && run.error) throw new Error('跑完整局失败：' + run.error);
  if (written === null) throw new Error('有 KapaiNative 时回放没有走原生通道（还是塞进 localStorage 了）');
  let arr = null;
  try { arr = JSON.parse(written); } catch { throw new Error('原生通道收到的不是合法 JSON'); }
  if (!Array.isArray(arr)) throw new Error('原生通道收到的不是数组');
  if (arr.length !== before + 1) throw new Error('原生通道收到的条数不对：' + arr.length + '，应为 ' + (before + 1));
  if (!arr[0] || !Array.isArray(arr[0].actions) || arr[0].actions.length === 0) throw new Error('写进去的那局没有记录到操作');
  if (api.__replays().length !== before + 1) throw new Error('内存里的回放列表没跟着更新');
  // 还原现场：后面的分组依赖内存里有一局
  api.__go('home');
  api.__newGame();
});

check('回放列表能渲染（含备注与删除按钮）', () => {
  api.__go('replays');
  const html = elements.get('stage').innerHTML;
  if (!html.includes('data-act="replay-open"')) throw new Error('缺少回放入口');
  if (!html.includes('data-act="replay-del"')) throw new Error('缺少删除按钮');
  if (!html.includes('data-act="replay-note"')) throw new Error('缺少备注按钮');
  if (!html.includes('测试备注')) throw new Error('备注没有显示出来');
});
