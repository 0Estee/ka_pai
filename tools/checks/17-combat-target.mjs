/**
 * 集成测试：「拟定目标攻击」（强化士兵 U396）在**真实界面路径**上的表现。
 *
 * 为什么单独测界面这一环：这个功能的价值全在「玩家点得到、点完打对」。
 *   · 引擎在轮到它出手时挂起 → 界面渲染成面板 → 玩家点一下 → 接着结算
 * 少任何一环，表现都是「轮到它了但什么都不发生」——作者报的正是这个。
 *
 * 这里走的是和玩家完全相同的入口：__newGame 开一局 + __nav('end') 结束阶段，
 * 而不是直接调引擎函数。__nav 走的是 main.js 里那张 data-act 路由表。
 */

import { api, check, elements } from './harness.mjs';

/**
 * 摆一只单位到指定位置（模拟「它已经在场上了」）。
 *
 * 通过界面自己开的口子 `window.__place`，而不是去摸打包作用域里的 `G` ——
 * 打包器把引擎命名空间生成成 `const G = {...}`，它不是 window 的属性，
 * 测试里根本取不到（这一点踩过）。
 */
function put(state, side, cardId, lane, row = 'front') {
  const info = api.__place(side, cardId, lane, row);
  if (!info) throw new Error(`没摆上 ${cardId}（${lane}-${row}）`);
  // 必须取**棋盘上的活体引用**：__place 返回的是快照，用它断言会看不出后续变化
  return state.board[lane].units[side][row];
}

/** 推进到开战（最多推几步；到挂起或进 COMBAT 就停） */
function toCombat(state) {
  for (let i = 0; i < 6; i++) {
    if (state.pending || state.winner !== null) return;
    if (state.phase === 'COMBAT') return;
    api.__advance();
  }
}

/** 摆一个「强化士兵 vs 5/6 挡路者 + 别路 1/1」的场面，并停在最后一个行动阶段 */
function scene() {
  // 用 __newGameFirst：先手固定为 0 号，场面才可复现（真实开局先手是随机的）
  const state = api.__newGameFirst();
  // ⚠ 必须先暂停：开局时如果轮到 AI，tick() 会留下 view.busy = true 和一个待跑的
  //   自动推进计时器，而「结束阶段」在 view.busy 时是直接 return 的 ——
  //   不暂停的话这里的操作会静默什么都不做（所有 __demo* 钩子都先 __pause）。
  api.__pause(true);
  // 显式声明「0 号是真人」：引擎就是按这个决定要不要挂起等人选目标
  state.humanSide = 0;
  const beast = put(state, 1, 'W04', 'mountain', 'front');   // 5/6，打不死
  const scout = put(state, 1, 'E01', 'plainR', 'front');     // 1/1，一击可杀
  const soldier = put(state, 0, 'U396', 'mountain', 'front');
  // 停在「最后一个行动阶段」：它的下一步就是开战
  state.phase = state.firstPlayer === 0 ? 'SPELL_FIRST' : 'SPELL_SECOND';
  api.__go('game');
  return { state, beast, scout, soldier };
}

/** 摆好场面并走到「引擎挂起等你选目标」那一刻 */
function sceneAtAsk() {
  const s = scene();
  toCombat(s.state);
  if (!s.state.pending) {
    throw new Error(`没走到选目标那一步（phase=${s.state.phase} turn=${s.state.turn} pending=null）`);
  }
  return s;
}

check('界面：强化士兵轮到出手时弹出选目标面板（含敌方单位与国王）', () => {
  const { state, beast, scout } = sceneAtAsk();
  void beast; void scout;

  const html = elements.get('stage').innerHTML;
  if (!html.includes('choice-mask')) {
    throw new Error(`开战时没有弹出选目标面板（pending=${!!state.pending} phase=${state.phase} 面板=${html.includes('choice-box')}）`);
  }
  if (!html.includes('强化士兵')) throw new Error('面板标题里应该写明是哪只单位在问');
  if (!html.includes('data-act="choose-option"')) throw new Error('面板里没有可点的选项');
  if (!html.includes('白板巨兽')) throw new Error('选项里缺少敌方单位');
  if (!html.includes('斥候')) throw new Error('选项里缺少另一个线路的敌方单位（要能跨线路打）');
  if (!html.includes('敌方国王')) throw new Error('选项里缺少「打脸」的国王选项');

  if (state.pending.request.type !== 'combatTarget') {
    throw new Error(`挂起的请求类型不对：${state.pending.request.type}`);
  }
  const b = state.board.mountain.units[1].front;
  const s = state.board.plainR.units[1].front;
  if (b.hp !== 6 || s.removed) throw new Error('还没点选项就已经打出去了');
});

check('界面：点选那个 1/1 之后，真的只打它（对面 5/6 不掉血）', () => {
  const state = api.__game();
  const req = state.pending && state.pending.request;
  if (!req) throw new Error('没有挂起的请求（上一条测试应该已经挂起了）');

  const beast = state.board.mountain.units[1].front;
  const scout = state.board.plainR.units[1].front;
  if (!beast || !scout) throw new Error('场上的单位不见了');

  const idx = req.options.findIndex((o) => o.uid === scout.uid);
  if (idx < 0) throw new Error('选项里找不到那只 1/1');

  // 和玩家点面板按钮完全同一条路
  api.__nav('choose-option', { idx: String(idx) });

  if (!scout.removed) throw new Error('被指定的 1/1 应该被打死');
  if (beast.hp !== 6) throw new Error(`没被指定的 5/6 不该掉血（现在是 ${beast.hp}）`);
  if (state.pending) throw new Error('答完之后不该还挂着请求');
});

check('界面：面板挂起期间再点「结束阶段」，回合不会被推过去', () => {
  const { state } = sceneAtAsk();

  const phaseAtAsk = state.phase;
  const turnAtAsk = state.turn;
  api.__nav('end', {});   // 再点一次，必须什么都不发生

  if (state.turn !== turnAtAsk) throw new Error('挂起期间不该推进回合');
  if (state.phase !== phaseAtAsk) throw new Error('挂起期间不该改变阶段');
  if (!state.pending) throw new Error('挂起请求不该被点掉');
  if (state.pending.request.type !== 'combatTarget') throw new Error('挂起的应该是选目标请求');
});

check('界面：战报里记下了「谁选了谁」（挂起时还没记，答完才记）', () => {
  const state = api.__game();
  const req = state.pending && state.pending.request;
  if (!req) throw new Error('应该正挂着选目标请求');

  // 挂起这一刻，挂起请求本身会出现在**选项目标**里，但战报里还不该有记录
  if (state.log.some((e) => e.type === 'combat-target')) {
    throw new Error('还没答就把选择记进战报了（应该答完才记）');
  }

  const idx = req.options.findIndex((o) => o.uid != null);
  if (idx < 0) throw new Error('选项里没有「打单位」这一项');
  api.__nav('choose-option', { idx: String(idx) });

  const entry = state.log.find((e) => e.type === 'combat-target');
  if (!entry) throw new Error('答完之后战报里还是没有 combat-target 条目');
  if (!entry.name) throw new Error('战报条目里缺单位名');
  if (entry.king) throw new Error('这条应该是「打单位」，不是打脸');
  if (!entry.targetName) throw new Error('战报条目里缺目标名');
});

check('界面：AI 那侧（humanSide = -1）不挂起，自己挑并记进战报', () => {
  const state = api.__newGameFirst();
  api.__pause(true);
  state.humanSide = -1;                    // 两侧都不是真人 → 引擎自己决策
  const put = (side, id, lane, row = 'front') => {
    api.__place(side, id, lane, row);
    return state.board[lane].units[side][row];
  };
  put(1, 'U396', 'mountain', 'front');     // AI 的强化士兵 2/3
  const myBlocker = put(0, 'W04', 'mountain', 'front');   // 5/6，2 点打不死
  const mySmall = put(0, 'E01', 'plainR', 'front');       // 1/1，2 点刚好打死
  state.phase = 'SPELL_FIRST';
  api.__go('game');
  toCombat(state);

  if (state.pending) throw new Error('没有真人时不该挂起等选目标');
  if (!mySmall.removed) throw new Error('AI 应该挑那个 2 点就能打死的 1/1');
  if (myBlocker.hp !== 6) throw new Error('打不死的 5/6 不该被碰');
  const entry = state.log.find((e) => e.type === 'combat-target');
  if (!entry) throw new Error('AI 的选择也要记进战报');
  if (entry.targetUid !== mySmall.uid) throw new Error('战报里记的目标和实际打的不一致');
});
