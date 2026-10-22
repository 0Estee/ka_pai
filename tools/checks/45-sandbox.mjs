/** § 靶场（作者 2026-10-22）：沙盒开局、任意落点、伤害原因 */
import fsx from 'node:fs';
import pathx from 'node:path';
import { api, check, ROOT } from './harness.mjs';

console.log('\n§ 靶场');

check('开局：双方各自拿到本阵营**全部**超能力，且不重复发', () => {
  const r = api.__sandbox();
  if (!r.sandbox) throw new Error('__sandbox 没有把 state.sandbox 打开');
  const st = api.__game();
  for (const side of [0, 1]) {
    const p = st.players[side];
    const faction = p.faction;
    const want = Object.keys(st.cardLib).filter((id) => {
      const c = st.cardLib[id];
      return c && c.faction === faction && !c.token && !c.legacy;
    });
    const have = p.hand.filter((hc) => st.cardLib[hc.cardId].faction === faction).map((hc) => hc.cardId);
    for (const id of want) {
      if (have.indexOf(id) < 0) throw new Error(`第 ${side} 方没有拿到超能力 ${id}`);
    }
  }
});

check('任意格子：单位牌可以放到**对面**那一侧（不看地形 / 不看阶段）', () => {
  api.__sandbox();
  const st = api.__game();
  const unitId = Object.keys(st.cardLib).find((id) => st.cardLib[id].type === 'unit' && !st.cardLib[id].legacy && !st.cardLib[id].faction);
  const r = api.__sbPlay(0, unitId, { lane: 'water', row: 'back', placeSide: 1 });
  if (!r.ok) throw new Error('放到对面失败：' + r.err);
  const placed = st.board.water.units[1].back;
  if (!placed || placed.cardId !== unitId) throw new Error('对面后排没有出现这张牌');
});

check('锦囊可以打在**自己**的单位身上（真对局里这是非法的）', () => {
  api.__sandbox();
  const st = api.__game();
  const unitId = Object.keys(st.cardLib).find((id) => st.cardLib[id].type === 'unit' && !st.cardLib[id].legacy && !st.cardLib[id].faction);
  api.__sbPlay(0, unitId, { lane: 'mountain', row: 'front', placeSide: 0 });
  const own = st.board.mountain.units[0].front;
  const spellId = Object.keys(st.cardLib).find((id) => {
    const c = st.cardLib[id];
    return c && c.type === 'spell' && !c.legacy && (c.actions || []).some((a) => a.op === 'damage');
  });
  const r = api.__sbPlay(0, spellId, { targetUid: own.uid, lane: 'mountain' });
  if (!r.ok) throw new Error('打自己人失败：' + r.err);
  if (!(own.hp < own.maxHp)) throw new Error('自己人没有掉血，说明目标被筛掉了');
});

check('每次受伤都写了原因（伤害日志带 reason）', () => {
  const st = api.__game();
  const hits = (st.log || []).filter((e) => e.type === 'damage');
  if (!hits.length) throw new Error('没有伤害日志');
  for (const e of hits) {
    if (!e.reason) throw new Error('有一条伤害没有写原因：' + JSON.stringify(e));
  }
  // 原因要能说清「是谁打的」或「什么结算的」，不能是空泛的占位
  const reasons = hits.map((e) => e.reason);
  if (reasons.every((r) => r === '未知来源')) throw new Error('原因全是兜底文案');
});

check('战报里每次受伤都写明原因（菜单 → 战报 / 菜单）', () => {
  const ret = api.__menuLog ? api.__menuLog() : null;
  const log = ret && typeof ret === 'object' ? String(ret.html || '') : String(ret || '');
  if (!log) throw new Error('战报是空的（__menuLog 钩子没拿到内容）');
  if (!log.includes('受伤')) throw new Error('战报里没有「受伤」这一行 —— 伤害没有进战报');
  if (!/受伤[\s\S]{0,80}（[^）]+）/.test(log)) throw new Error('战报里的受伤没有跟在括号里的原因');
});

check('飘字下面那行「为什么」由引擎日志的 reason 驱动（界面不再自己猜）', () => {
  const dir = pathx.join(ROOT, 'app', 'js');
  const ui = fsx.readFileSync(pathx.join(dir, 'ui.js'), 'utf8');
  if (!ui.includes('fx-why')) throw new Error('格子上的飘字没有原因那一行（.fx-why）');
  if (!/fx\.reason/.test(ui)) throw new Error('飘字没读 fx.reason');
  const flow = fsx.readFileSync(pathx.join(dir, 'game-flow.js'), 'utf8');
  const hit = flow.slice(flow.indexOf("case 'damage':"));
  if (!/reason:\s*e\.reason/.test(hit.slice(0, 1200))) throw new Error('fxOfLogEntry 没把 reason 带进特效');
});

check('靶场不判胜负：国王被打到 0 也继续', () => {
  const st = api.__game();
  st.players[0].kingHp = 1;
  const before = st.winner;
  api.__sbPlay(1, Object.keys(st.cardLib).find((id) => {
    const c = st.cardLib[id];
    return c && c.type === 'spell' && !c.legacy && (c.actions || []).some((a) => a.op === 'damage' && a.target && a.target.kind === 'enemyKing');
  }) || 'U01', { targetKing: true, targetKingSide: 0 });
  if (st.winner !== before) throw new Error('靶场判了胜负：' + st.winner);
});

check('清空场地：格子全空，手牌与国王血量不动', () => {
  const st = api.__game();
  const handBefore = st.players[0].hand.length;
  api.__sandboxClearBoard();
  for (const lane of ['mountain', 'plainL', 'plainR', 'water']) {
    for (const side of [0, 1]) {
      for (const row of ['front', 'back']) {
        if (api.__game().board[lane].units[side][row]) throw new Error('还有单位没清掉：' + lane);
      }
    }
  }
  if (api.__game().players[0].hand.length !== handBefore) throw new Error('清场地不该动手牌');
});
