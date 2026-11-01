/** § AI 那一侧的提问 / 平手的可选性（作者 2026-11-01 报的五条） */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, api, check, elements } from './harness.mjs';

console.log('\n§ AI 侧提问 / 平手可选（作者 2026-11-01）');

/** 读源码用（源码级断言：界面有没有把「哪几方是 AI」交给引擎） */
function src(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

/** 当前渲染出来的舞台 HTML（和 __demoChoice 用的是同一个元素） */
function stageHtml() {
  const el = elements.get('stage');
  return el ? el.innerHTML : '';
}

check('建局时把「哪几方是 AI」交给引擎：单机 = 对手，靶场 = 非控制方，联机 = 一个都没有', () => {
  const flow = src('app/js/game-flow.js');
  if (!/state\.aiSides\s*=\s*\[AI\]/.test(flow)) {
    throw new Error('game-flow.js 的单机建局没有写 state.aiSides = [AI] —— 引擎会以为对手也是真人');
  }
  if (!/state\.aiSides\s*=\s*\[1\s*-\s*me\(\)\]/.test(flow)) {
    throw new Error('game-flow.js 的靶场建局没有写 state.aiSides = [1 - me()]');
  }
  const mp = src('app/js/multiplayer.js');
  if (!/this\.state\.aiSides\s*=\s*\[\s*\]/.test(mp)) {
    throw new Error('multiplayer.js 的联机开局必须把 aiSides 清空（联机两边都是真人）');
  }
  const input = src('app/js/play-input.js');
  if (!/state\.aiSides\s*=\s*\[1\s*-\s*me\(\)\]/.test(input)) {
    throw new Error('play-input.js 的靶场换边没有同步 aiSides');
  }
});

check('引擎把「归 AI 的代答」排在「必须等人答」之前（否则 AI 的提问照样会弹给玩家）', () => {
  const ch = src('engine/src/choices.js');
  const ai = ch.indexOf('answeredByAi(state, request)');
  const noAuto = ch.indexOf('if (request.noAuto) return holdHang()');
  if (ai < 0) throw new Error('choices.js 里找不到 answeredByAi 的代答分支');
  if (noAuto < 0) throw new Error('choices.js 里找不到 noAuto 的挂起分支');
  if (ai > noAuto) throw new Error('AI 代答必须排在 noAuto 挂起之前');
});

check('AI 那一侧的触发式选择不弹给玩家（靶场：下界之风打掉对面的红火蚁）', () => {
  api.__sandbox({ place: [[1, 'U72', 'mountain', 'front']] });
  const st = api.__game();
  if (!st) throw new Error('靶场没有建起来');
  if (!Array.isArray(st.aiSides) || st.aiSides.indexOf(1) < 0) {
    throw new Error('靶场里没控制的那一侧应当被标成 AI，实际 ' + JSON.stringify(st.aiSides));
  }
  st.autoResolveChoices = false;   // 玩家正在出牌：这就是报 bug 时的现场
  const r = api.__sbPlay(0, 'U398', {});      // 对敌方所有单位 2 点（没有别的提问）
  if (!r.ok) throw new Error('打出下界之风失败：' + r.err);
  if (st.pending) {
    throw new Error('AI 那边的红火蚁把「选一个目标」挂起给了玩家：' + st.pending.request.type);
  }
  if (stageHtml().includes('choice-mask')) {
    throw new Error('归 AI 的提问不该渲染出选择面板');
  }
  st.autoResolveChoices = true;
});

check('鲸鲨消灭♥最低的敌人：并列时可以自己选（不再是引擎替你挑）', () => {
  // 靶场只收「作者卡」（白板演示卡有 legacy 标记，加不进手牌）→ 用两张假人模特（4♥）
  api.__sandbox({ place: [[1, 'U71', 'mountain', 'front'], [1, 'U71', 'plainL', 'front']] });
  const st = api.__game();
  const a = st.board.mountain.units[1].front;
  const b = st.board.plainL.units[1].front;
  if (!a || !b) throw new Error('两个并列的敌人没摆上');
  if (a.hp !== b.hp) throw new Error('要先造出「生命并列最低」的局面');
  const r = api.__sbPlay(0, 'U205', { lane: 'water', row: 'front' });  // 鲸鲨（水生）
  if (!r.ok) throw new Error('打出鲸鲨失败：' + r.err);
  const rq = st.pending && st.pending.request;
  if (!rq) throw new Error('两个 ♥ 并列最低，却没有挂起让人选');
  if (rq.type !== 'chooseUnit') throw new Error('挂起的应该是「选单位」，实际 ' + rq.type);
  if (rq.noAuto !== true) throw new Error('真人这一侧不许被自动代答（noAuto）');
  if ((rq.options || []).length !== 2) throw new Error('并列的两个都该在选项里，实际 ' + (rq.options || []).length + ' 个');
  if (!stageHtml().includes('choice-mask')) throw new Error('挂起了，但界面上没有渲染选择面板');

  api.__resolveChoice(0);          // 选项按 uid 升序 → 先落地的那个
  if (st.pending) throw new Error('答完仍然挂起');
  if (!a.removed) throw new Error('选中的那个没有被消灭');
  if (b.removed) throw new Error('没选的那个不该被消灭');
  if (stageHtml().includes('choice-mask')) throw new Error('答完之后面板没有收起来');
});

check('鲸鲨：唯一 ♥ 最低时不多弹面板', () => {
  api.__sandbox({ place: [[1, 'U71', 'mountain', 'front']] });
  const st = api.__game();
  const only = st.board.mountain.units[1].front;
  const r = api.__sbPlay(0, 'U205', { lane: 'water', row: 'front' });
  if (!r.ok) throw new Error('打出鲸鲨失败：' + r.err);
  if (st.pending) throw new Error('只有一个候选却又弹了一次面板：' + st.pending.request.type);
  if (!only.removed) throw new Error('唯一 ♥ 最低的敌人应当被消灭');
});
