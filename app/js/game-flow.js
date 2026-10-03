/**
 * 对局流程：建局、引擎操作通道（锁步）、回合驱动、结算与录制。
 *
 * 与 app/js 其它模块共享同一个打包作用域（见 tools/build-web.mjs）：
 * screen/state/view/session/recording/replays/profile/difficulty/paused/
 * bannerTimer/autoAdvanceTimer/autoAdvancing 等共享状态直接按裸名字读写，
 * 以及 refresh/showBanner/fillMenuLog 等同作用域函数，
 * 都不需要 import。
 */

import * as G from '../../engine/src/engine.js';
import * as Store from './store.js';
import * as Eco from './economy.js';
import * as RP from './replay.js';
import { TEST_CARD_LIB, buildTestDeck } from '../../engine/cards/test-cards.js';
import { aiTakeTurn, difficultyByKey, applyDifficultyBonus, installAiTargetPicker } from './ai.js';

// 回合循环排出去的定时器句柄。新对局必须把它们全部取消（见 newGame()），
// 否则上一局的回调会在新局里醒来、往新局上多推一次。
let autoPhaseTimer = null;
let aiTurnTimer = null;
let aiAdvanceTimer = null;

/** 开始一局新对局（首页「开始游戏」与「再来一局」都走这里） */
function startNewGame() {
  // ⚠ 顺序要紧：newGame() 内部会调 tick()，而 tick() 开头有
  //   `if (screen !== 'game') return;`
  // 所以必须先切屏再建局。反过来的话 tick() 会在守卫处直接返回，
  // 整个回合循环根本不启动 —— 如果开局时 AI 是先手，就会卡死在
  // 「不是你的阶段、AI 也不动」：既出不了牌也结束不了回合。
  // （这个 bug「有时」才出现，因为先手是随机的。）
  screen = 'game';
  newGame();
  // 开场提示：棋盘格子放不下卡面文字，得让玩家知道能点开看
  view.hint = '点场上的卡牌可以查看它的效果';
  refresh();
}

// ══════════════════════════════════════════════════════════
// 建局
// ══════════════════════════════════════════════════════════

function newGame() {
  clearTimeout(bannerTimer);
  clearTimeout(autoAdvanceTimer);
  // 旧对局排出去的回合循环定时器也要取消：它们捕获的是旧 state，
  // 醒来后会往新对局上推一次；autoAdvancing 同理必须复位，
  // 否则自动阶段会永久停在防重入那一步。
  clearTimeout(autoPhaseTimer);
  clearTimeout(aiTurnTimer);
  clearTimeout(aiAdvanceTimer);
  autoAdvancing = false;

  const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  // 共享牌库 80 张（作者裁决：卡池已超过 80 张，改为「从全部卡里随机抽 80 张」）。
  // 必须把当局种子传进去 —— 同一局永远同一副牌，回放与联机的确定性靠这个。
  const deck = buildTestDeck(80, seed);

  /**
   * 本局阵营（作者 2026-10-03 的「超能力」规则）：对局开始前自选，本局可用该阵营的超能力。
   * 现在只有一个阵营，AI 就先和玩家同阵营（镜像对局）。以后加阵营时这里改成让 AI 自己选。
   * 必须和建局参数、录制都对齐：重放时要靠它重建「谁抽得到哪些超能力」。
   */
  const factions = [myFaction, myFaction];

  state = G.createGame({
    seed,
    firstPlayer: seed % 2,        // 随机决定先后手（规则书 §4）
    deck,
    cardLib: TEST_CARD_LIB,
    factions,
  });
  /**
   * 记下**开局发牌之前**的牌库与 rng。
   *
   * 为什么要这一步：`G.startGame` 会发起手牌（先手 5 张、后手 4 张），
   * 于是 `state.rng.state` 也被推进了一截。而重放是**照这份录制从零重建**的
   * ——如果只存种子让重建方自己洗牌、自己读 rng，它拿到的 rng 状态和当年
   * 发牌前的那一刻就对不上（`deck` 是洗过的、rng 却是没动过的），
   * 从第一步起抽牌顺序就歪了，对拍时报出一堆查不出原因的「分叉」。
   *
   * 存下这两个值，重放方就能把「发牌前的一刻」原样复原，再照原样发牌。
   * 旧记录（回放格式 v3 及以前）没有这个字段，回落到「照种子自己洗」。
   */
  const opening = { deck: state.deck.slice(), rngState: state.rng.state >>> 0 };
  G.startGame(state);
  state.autoResolveChoices = true; // AI 与自动结算用；玩家侧由我们显式传目标
  // 战斗可视化的游标/队列是跨局保留的，开新局必须清一次（否则会带着上一局的残留）
  resetCombatFx();

  // ── 告诉引擎「本地玩家是哪一方」
  //    开战结算到「拟定目标攻击」（强化士兵）出手时会中途停下来问目标：
  //    真人那一侧挂起等人点，AI 那一侧用下面的策略自己挑。
  //    联机时客人是 1 号，所以这必须是 me() 而不是常量 HUMAN。
  state.humanSide = me();
  installAiTargetPicker(state);

  // 难度给 AI 的额外优势（困难：每回合多 1 费；噩梦：再加起手多 2 张、国王 +4 上限）。
  // 普通/简单这里是空操作。
  const aiBonus = difficultyByKey(difficulty).bonus;
  applyDifficultyBonus(state, AI, difficulty);

  // ── 开始录制。种子 + 牌库 + 之后每一步操作 = 可完整复现这一局。
  // ⚠ 额外优势**必须一起存**：那局里 AI 正是靠多出来的费用才打得出某些牌，
  //   重放时不加回去就会在中途报「费用不足」。（回放格式 v2 加的字段）
  recording = RP.newRecording({
    seed,
    firstPlayer: state.firstPlayer,
    deck,
    cardSet: RP.cardSetId(TEST_CARD_LIB),
    bonuses: aiBonus ? [{ side: AI, ...aiBonus }] : [],
    // 哪一方是真人：回放时靠它决定「哪些提问要挂起等人答」。
    // 写死成 -1 的话，真人那一侧录下来的答案会找不到挂起的请求
    //（回放格式 v3 加的字段，见 replay.js 的 build()）。
    humanSide: state.humanSide,
    factions,
    // 开局发牌前的一刻（牌库 + rng），重放时靠它把起点复原（见上面 `opening` 的说明）
    opening,
  });
  /**
   * 让引擎把**它自己代答的每一问**也记进录制（见 `engine/src/choices.js` 的 `takeChoice`）。
   *
   * 少这一步，「出牌带选择」的回放会在引擎代答的那一问上分叉：`{k:'c'}` 只记真人点的
   * 那一下，AI 侧的 `chooseEnemyTarget`、被自动代答的 `chooseOption` 都不在流里，
   * 回放里同一问只能自己乱选。
   */
  state.choiceLog = recording.choiceLog;

  view = makeView();

  fillMenuLog();
  tick();
}

/**
 * 所有引擎操作的**唯一通道**。
 *
 *   单机：直接应用到本地引擎，并记进回放。
 *   联机：交给会话 —— 它会本地应用一次、再广播给对方；
 *         对方的操作到达时也走同一条路，所以两端执行顺序完全一致。
 *
 * 这就是「锁步」：不传棋盘，只传操作。
 */
function doAction(action) {
  if (session) return session.submit(action);
  applyLocalAction(action, false);
  return true;
}

function applyLocalAction(action, fromRemote) {
  // 出牌前先把卡牌定义抓下来（打出后这张牌就离开手牌了）
  const playedDef = action.k === 'p'
    ? state.cardLib[((state.players[action.s].hand.find((c) => c.iid === action.i)) || {}).cardId]
    : null;
  try {
    if (action.k === 'a') G.advance(state);
    else if (action.k === 'p') G.playCard(state, action.s, action.i, action.o || {});
    else if (action.k === 'c') G.resolveChoice(state, action.v);
    else if (action.k === 'x') G.sacrificeUnit(state, action.s, action.u);
  } catch (err) {
    console.error('执行操作失败', action, err);
    return false;
  }
  RP.recAction(recording, action);
  /**
   * 「放大展示」（作者 2026-10 口径）：所有**锦囊**被使用时放大展示给双方、持续 2 秒；
   * **陷阱触发**时同样放大展示（陷阱的「使用」是埋伏，不展示）。
   * 用现成的 banner 机制（大字卡名 + 效果文本），2 秒后自动收起。
   */
  flashPlayPresentation(playedDef, action);
  pumpCombatFx();
  return true;
}

/** 引擎推进的唯一入口 —— 顺手记进回放 / 广播给对手 */
function advanceGame() {
  doAction({ k: 'a' });
}

/** 打出一张牌（玩家或 AI）—— 单机记回放，联机广播 */
function playCardAction(side, iid, opts) {
  return doAction({ k: 'p', s: side, i: iid, o: opts || {} });
}

// ══════════════════════════════════════════════════════════
// 回合驱动
// ══════════════════════════════════════════════════════════

function tick() {
  // 只有在对局屏幕上才驱动回合（首页/设置/回放列表不该有计时器在跑）
  if (screen !== 'game') return;
  pumpCombatFx();
  presentSuperpowers();
  if (paused) { refresh(); return; }

  /**
   * 「开战演出没播完，不要进下一回合」（作者 2026-10 要求）。
   * 开战一瞬间可能产生十几条特效，不等它播完就推进，玩家根本看不清发生了什么。
   * 播完由 stepCombatFx 的收尾回调重新调 tick() 接回来。
   */
  if (view.fx || view.fxTimer || (view.fxQueue && view.fxQueue.length)) {
    refresh();
    return;
  }

  if (state.winner !== null) {
    view.busy = false;
    view.hint = '';
    settleIfNeeded();
    refresh();
    fillMenuLog();
    return;
  }

  const actor = G.getActor(state);

  // ── 自动阶段（回合开始 / 开战 / 回合结束）
  if (actor === null) {
    // 联机时**只有主机**推进自动阶段，并把 {k:'a'} 广播出去。
    // 客人如果也推进，两端会各推一次，回合数直接翻倍。
    if (session && !session.isHost) {
      view.busy = true;
      view.busyText = '等待对手…';
      refresh();
      return;
    }

    const leaving = state.phase;

    /**
     * 「拟定目标攻击」（卡牌「强化士兵」）现在是**引擎在开战结算中途**自己停下来问的
     * （见 engine/src/combat.js 的 pickCombatTarget）：轮到它出手时挂起，
     * `state.pending` 被设上，界面渲染出选项，玩家点完由 resolveChoice 接着算。
     * 所以这里不再需要「开战前拦一下」的应用层待办（原来的 view.pendingPlan）。
     *
     * 万一还是带着挂起请求走到这里（例如联机对手的操作先到），
     * 直接返回等界面把它答完 —— 推进会被 engine.advance 里的
     * 「存在待处理的交互请求，无法推进」拦下并抛错。
     */
    /**
     * 万一还是带着挂起请求走到这里（例如联机对手的操作先到），
     * 直接返回等界面把它答完 —— 推进会被 engine.advance 里的
     * 「存在待处理的交互请求，无法推进」拦下并抛错。
     */
    if (state.pending) {
      view.busy = false;
      refresh();
      return;
    }

    view.busy = true;    view.busyText = leaving === 'COMBAT' ? '开战中…' : (leaving === 'TURN_START' ? '回合开始…' : '结算中…');
    refresh();

    // ⚠️ 防重入：联机时 advanceGame() 是**异步**的（要走 session.submit 广播给对方），
    //    如果不等它落地就再跑 tick()，会因为「state 还没变、看着还是同一个自动阶段」
    //    而**再排一次推进** —— 结果是同一个阶段推进两次，中间那个阶段（往往正是
    //    玩家的行动阶段）被整个跳过。表现就是「偶尔自动跳过回合」。
    //    单机不会踩到，因为 applyLocalAction 是同步的。
    if (autoAdvancing) return;
    autoAdvancing = true;

    const logFrom = state.log.length;
    const delay = leaving === 'COMBAT' ? 750 : 260;

    autoPhaseTimer = setTimeout(() => {
      Promise.resolve(advanceGame())
        .then(() => {
          if (leaving === 'COMBAT') {
            const summary = summarizeLog(logFrom);
            if (summary) showBanner(summary, 2600);
          }
        })
        .catch((err) => { console.error('推进自动阶段失败', err); })
        .then(() => {
          autoAdvancing = false;
          tick();
        });
    }, delay);
    return;
  }

  // ── AI 阶段（联机时两边都是真人，不会走到这里）
  // 判断用 me() 而不是常量 AI：常量只在单机成立，!session 万一为假/为真搞反，
  // 就会把**客人自己**当成 AI 自动替他打牌。
  if (!session && actor !== me()) {
    view.busy = true;
    view.busyText = 'AI 思考中…';
    refresh();

    aiTurnTimer = setTimeout(() => {
      try {
        const r = aiTakeTurn(state, foe(), { difficulty });
        // AI 已经把牌打出去了，这里只补记账（回放），不能再 apply 一次
        for (const a of (r && r.actions) || []) {
          RP.recAction(recording, { k: 'p', s: foe(), i: a.iid, o: a.opts });
        }
        // AI 打出的锦囊也要放大展示（作者 2026-10 报的「敌方使用锦囊时没有提示」）
        presentCasts();
      } catch (err) {
        console.error('AI 出错', err);
      }
      refresh();
      aiAdvanceTimer = setTimeout(() => {
        if (state.winner === null && !state.pending) advanceGame();
        tick();
      }, 260);
    }, 420);
    return;
  }

  // ── 玩家阶段
  // 联机时对手的回合也会走到这里（actor 不是 me()）。必须区分：
  // 不是我的回合就只是显示，绝不能去算「我没有可出的牌 → 自动结束阶段」。
  const myTurn = actor === me();
  view.busy = false;
  view.busyText = '';
  refresh();
  if (!myTurn) return;

  // 没有任何合法出牌 → 短暂提示后自动结束阶段，避免玩家干等
  const plays = G.getLegalPlays(state, me());
  if (plays.length === 0) {
    const p = state.players[me()];
    const hasCard = p.hand.length > 0;
    view.hint = hasCard ? '没有可用的牌（费用不足或无合法位置）' : '手牌已空';
    refresh();
    autoAdvanceTimer = setTimeout(() => {
      if (state.winner === null && !state.pending && G.getActor(state) === me()) {
        advanceGame();
        tick();
      }
    }, 900);
  }
}

// ══════════════════════════════════════════════════════════
// 对局结束：发金币 + 存回放
// ══════════════════════════════════════════════════════════

/**
 * 一局只结算一次（用 recording.settled 当闸门）。
 * tick() 会反复跑到这里，所以幂等很重要。
 */
function settleIfNeeded() {
  if (!recording || recording.settled) return;

  const record = RP.finishRecording(recording, state);
  const humanKingHp = state.players[me()].kingHp;

  // ── 金币结算
  const r = Eco.applyResult(profile, {
    winner: state.winner,
    humanSide: me(),
    turn: state.turn,
    humanKingHp,
    // 联机是真人对手，走 pvp 系数（economy.js 的 MODE_MULTIPLIER）
    mode: session ? 'pvp' : 'ai',
  });
  profile = r.profile;
  Store.saveProfile(profile);

  // ── 存档：写入回放（放在金币之后，配额满也不影响金币）
  const entry = {
    ...record,
    id: RP.makeReplayId(),
    note: '',
    humanSide: me(),
  };
  const list = [entry, ...replays];
  const ok = Store.saveReplays(list);
  if (ok) {
    replays = list;
  } else {
    // 配额满：退一步，丢掉最旧的一半再试一次，至少把新的一局留下来
    const trimmed = [entry, ...replays.slice(0, Math.max(0, Math.floor(replays.length / 2)))];
    if (Store.saveReplays(trimmed)) {
      replays = trimmed;
      view.hint = '本地空间不足，已自动清理较早的回放';
    } else {
      view.hint = '本地空间不足，这局的回放没能保存（金币已结算）';
    }
  }

  lastSettle = {
    reward: r.reward,
    leveledUp: r.leveledUp,
    levelBefore: r.levelBefore,
    levelAfter: r.levelAfter,
    gold: profile.gold,
  };
  view.settle = lastSettle;
}

/** 从日志区间生成一句战报 */
function summarizeLog(from) {
  const entries = state.log.slice(from);
  let myKing = 0;
  let foeKing = 0;
  let myLoss = 0;
  let foeLoss = 0;

  for (const e of entries) {
    if (e.type === 'king-damage') {
      if (e.side === me()) myKing += e.amount;
      else foeKing += e.amount;
    } else if (e.type === 'destroy') {
      if (e.side === me()) myLoss += 1;
      else foeLoss += 1;
    }
  }

  const parts = [];
  if (foeKing) parts.push(`AI 国王 -${foeKing}`);
  if (myKing) parts.push(`你的国王 -${myKing}`);
  if (foeLoss) parts.push(`AI 损失 ${foeLoss} 个单位`);
  if (myLoss) parts.push(`你损失 ${myLoss} 个单位`);
  return parts.length ? `开战：${parts.join('，')}` : '';
}

export {
  startNewGame, newGame, doAction, applyLocalAction, advanceGame,
  playCardAction, tick, settleIfNeeded, summarizeLog,
};
/**
 * 「放大展示」（作者 2026-10 口径）：
 *    所有**锦囊**被使用时  放大展示给双方，持续 2 秒；
 *    **陷阱**达成触发条件时  同样放大展示（陷阱的「使用」是埋伏，不展示）。
 * 复用现成的 showBanner（大字 + 卡名 + 效果文本），2 秒后自动收起。
 * 陷阱触发从引擎日志里认（damage.js 会记一条 trap-triggered）。
 */
function flashPlayPresentation(playedDef, action) {
  if (!state) return;
  // 陷阱触发优先：它才是「达成触发条件」的那一刻
  // 用游标只认**新出现**的那条：以前是回看最后 4 条日志，只要那条 trap-triggered
  // 还在窗口里，之后每一次出牌/推进都会再弹一次同一个横幅
  //（作者 2026-10 报的「锦囊提示会多次出现」）。
  const logs = state.log || [];
  if (view.trapCursor === undefined || view.trapCursor > logs.length) view.trapCursor = logs.length;
  for (let i = view.trapCursor; i < logs.length; i++) {
    const e = logs[i];
    if (e && e.type === 'trap-triggered') {
      const def = state.cardLib[e.cardId];
      view.trapCursor = i + 1;
      showBanner('陷阱触发', 2000, def ? def.name : e.cardId);
      return;
    }
  }
  view.trapCursor = logs.length;
  // 陷阱：它的「使用」是**埋伏**，按作者口径**不能给对手看**  只给埋的人自己一个提示
  if (action && action.k === 'p' && playedDef && isTrapCard(playedDef)) {
    if (typeof me === 'function' && action.s === me()) {
      showBanner(playedDef.name, 2000, '已埋伏');
    }
    return;
  }
  // 锦囊：放大展示给双方，持续 2 秒
  if (action && action.k === 'p' && playedDef && playedDef.type === 'spell') {
    showBanner(playedDef.name, 2000, playedDef.text || '');
  }
}
// 
// 战斗可视化：把 state.log 里新出现的事件排成小队特效，逐条播
//
// 为什么这么做：引擎是「瞬间算完」，界面上什么过程都看不到。而 state.log
// 里其实**每一条伤害都记着**（lane-combat / damage / king-damage / crit /
// thorns / poison-tick ），所以只要按「日志游标」把新事件翻成特效、按
// 150ms 一条放出去，每一次攻击就能看得见。纯展示，不碰任何游戏状态。
// 

/**
 * 抽到超能力时的提示（作者 2026-10-03 的超能力规则）。
 *
 * 扫日志而不是由调用方触发：开局那第一张是 startGame 里抽的，没有对应的「出牌」时刻，
 * 用游标认新出现的 superpower-draw 条目才不会漏。
 * 开局那张只写提示行  横幅要留给「使用锦囊」的放大展示，两条抢同一个位置时
 * 玩家看到的就是「敌方用了锦囊却没提示」（作者报过的那类问题）。
 * 之后国王掉血触发的抽取才用横幅。
 */
function presentSuperpowers() {
  if (!state || !view) return;
  const logs = state.log || [];
  if (view.spCursor === undefined || view.spCursor > logs.length) view.spCursor = 0;
  for (let i = view.spCursor; i < logs.length; i++) {
    const e = logs[i];
    if (!e || e.type !== 'superpower-draw') continue;
    const def = state.cardLib[e.cardId] || {};
    const mine = typeof me === 'function' && e.side === me();
    if (!mine) continue;   // 只提示自己抽到的：对手那张只会挤掉真正的出牌提示
    // 开局那张不弹横幅：手牌上有持久高亮（ui.js 的 is-superpower / 超能力角标），
    // 横幅要留给「使用锦囊」的放大展示  两条抢同一个位置时玩家看到的是
    // 「敌方用了锦囊却没有提示」。
    if (e.starting) continue;
    queueBanner('抽到超能力：' + (def.name || e.cardId), 2600, def.text || '');
  }
  view.spCursor = logs.length;
}

/**
 * AI 打出的锦囊也要放大展示（作者 2026-10：敌方使用锦囊时没有任何提示）。
 *
 * 为什么不在 AI 出牌那一瞬间弹：aiTakeTurn 一次可能连出好几张（最多 8 张），
 * 连着调 showBanner 只会看到最后一张。这里从日志里按游标取**新出现**的 cast
 * 条目，交给 queueBanner 排队，一张一张各播满 2 秒。
 */
function presentCasts() {
  if (!state || !view) return;
  const logs = state.log || [];
  if (view.castCursor === undefined || view.castCursor > logs.length) view.castCursor = 0;
  for (let i = view.castCursor; i < logs.length; i++) {
    const e = logs[i];
    if (!e || e.type !== 'cast') continue;
    // 自己的锦囊在 commitPlay / applyLocalAction 里已经展示过，别弹第二遍
    if (typeof me === 'function' && e.side === me()) continue;
    const def = state.cardLib[e.cardId];
    if (!def || def.type !== 'spell' || isTrapCard(def)) continue;
    queueBanner(def.name, 2000, def.text || '');
  }
  view.castCursor = logs.length;
}

/** 一条日志 -> 一个特效；返回 null 表示这条不值得演 */
function fxOfLogEntry(e) {
  if (!e || !e.type) return null;
  switch (e.type) {
    case 'lane-combat':
      return { kind: 'attack', lane: e.lane, uids: e.attackers || [] };
    case 'damage':
      if (e.uid === undefined) return null;
      return {
        kind: 'hit', uid: e.uid, lane: e.lane, side: e.side, row: e.row,
        text: (e.hp !== undefined && e.hp <= 0) ? '消灭' : '-' + e.amount,
      };
    case 'king-damage':
      return { kind: 'hit', kingSide: e.side, text: '-' + e.amount };
    case 'crit':
      return { kind: 'hit', uid: e.uid, text: '暴击 +' + e.x };
    case 'thorns':
      return { kind: 'hit', uid: e.uid, text: '荆棘 ' + e.x };
    case 'poison-tick':
      // 国王中毒的日志没有 uid，只有 kingSide（见 engine/src/turns.js 的 resolveMarks）
      if (e.kingSide !== undefined) return { kind: 'hit', kingSide: e.kingSide, text: '中毒 ' + e.x };
      return { kind: 'hit', uid: e.uid, text: '中毒 ' + e.x };
    case 'untargetable-block':
      return { kind: 'hit', uid: e.uid, text: '无法选中' };
    default:
      return null;
  }
}

/** 扫一遍新日志，排进特效队列；没有在播就开始播 */
function pumpCombatFx() {
  if (!state) return;
  const logs = state.log || [];
  if (view.fxCursor === undefined || view.fxCursor > logs.length) view.fxCursor = 0;
  if (!view.fxQueue) view.fxQueue = [];
  if (!view.deadUnits) view.deadUnits = [];
  for (const e of logs.slice(view.fxCursor)) {
    // 阵亡残影：这一步只登记，什么时候不再画由 ui.js 的 slotHTML 判（这一路演完就撤）
    if (e && e.type === 'destroy' && e.lane !== undefined && view.deadUnits.length < 20) {
      view.deadUnits.push({ uid: e.uid, cardId: e.cardId, lane: e.lane, side: e.side, row: e.row });
    }
    const fx = fxOfLogEntry(e);
    if (fx && view.fxQueue.length < 14) view.fxQueue.push(fx);   // 上限：别让大战役拖成幻灯片
  }
  view.fxCursor = logs.length;
  if (!view.fxTimer && view.fxQueue.length) stepCombatFx();
  // 没有要播的特效就别留着残影（否则下一次别的线路开战时会把旧残影画出来）
  else if (!view.fxTimer) view.deadUnits = [];
}

/** 播一条；播完延时再播下一条，最后收尾清空 */
/**
 * 每条特效停留多久（毫秒）**调手感就改这一处**。
 *
 *  作者 2026-10 反馈「太快了，还没看清楚就结束了」。根因不是动画做得短，
 *   而是 refresh() 会**整块替换 #stage 的 innerHTML**  下一步一渲染，
 *   上一条的 CSS 动画就被打断（旧的 150ms 对上 0.9s 的飘字，等于只播了 1/6）。
 *   所以这个值必须 ** style.css 里最长的那条动画**（现在最长是 0.80s），
 *   再留一点喘气的时间。
 */
const FX_STEP_MS = 820;

function stepCombatFx() {
  view.fx = view.fxQueue.shift() || null;
  // 飘字只播一次：refresh() 整块重建 #stage，之后任何一次重渲染都会让同一个
  // .fx-float 重启动画（作者看到的就是「飘字反复触发」）。第一条渲染允许播动画，
  // 渲染完立刻把标记关掉，之后渲染出来的就是同一段静止文字（.fx-float-rest）。
  if (view.fx) view.fx.animateFloat = true;
  refresh();
  if (view.fx) view.fx.animateFloat = false;
  view.fxTimer = setTimeout(() => {
    view.fxTimer = null;
    if (view.fxQueue.length) stepCombatFx();
    else {
      view.fx = null;
      view.deadUnits = [];
      refresh();
      // 演出播完了，把回合循环接回去（上面那道闸放行）
      tick();
    }
  }, FX_STEP_MS);
}

/** 换局/换屏时把特效与游标清干净 */
function resetCombatFx() {
  clearTimeout(view.fxTimer);
  view.fxTimer = null;
  view.fx = null;
  view.fxQueue = [];
  view.deadUnits = [];
  view.trapCursor = state && state.log ? state.log.length : 0;
  view.castCursor = state && state.log ? state.log.length : 0;
  view.fxCursor = state && state.log ? state.log.length : 0;
}