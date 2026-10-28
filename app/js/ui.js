/**
 * 界面渲染层：把 GameState 渲染成 DOM。
 *
 * 采用「整块重绘 + 事件委托」：
 * 棋盘规模很小（4 路 × 5 排 + 手牌），整块重绘的开销远低于维护差量更新的复杂度。
 */

import { LANES, LANE_NAME, ROWS, SIDE_NAME } from '../../engine/src/constants.js';
import { KEYWORD_DEFS } from '../../engine/src/keywords.js';
import { effectiveAtk, hasRooted } from '../../engine/src/auras.js';
import * as G from '../../engine/src/engine.js';
import { visibleMana, allUnits } from '../../engine/src/board.js';

const PHASE_LABEL = {
  TURN_START: '回合开始',
  DEPLOY_FIRST: '先手 · 放置单位',
  DEPLOY_SECOND: '后手 · 放置单位',
  SPELL_FIRST: '先手 · 打出锦囊',
  SPELL_SECOND: '后手 · 打出锦囊',
  COMBAT: '开战结算',
  TURN_END: '回合结束',
};

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 词条 → 卡面短标签（带参数时显示 装甲1） */
function keywordLabels(state, unit) {
  const out = (unit.keywords || []).map((k) => {
    const def = KEYWORD_DEFS[k.id];
    const name = def ? def.name : k.id;
    return k.x ? `${name}${k.x}` : name;
  });
  // 光环授予的「扎根」（拷问官）不在 keywords 里，单独补一个标签
  if (state && hasRooted(state, unit) && !out.includes('扎根')) out.push('扎根*');
  return out;
}

/** 标记图标 */
function markLabels(unit) {
  const out = [];
  for (const m of unit.marks || []) {
    if (m.type === 'poison') out.push(`毒${m.x}`);
    else if (m.type === 'disease') out.push('疫');
  }
  return out;
}

/**
 * 属性徽记：蓝四角星 = 攻击力，红盾 = 生命（作者 2026-10 选定的方案 A：内联 SVG）。
 *
 * 为什么不用「CSS 背景图 + span 数字」：数字压在宝石高光上，高光处对比度天然不足，
 * 浅色主题里橙字挤在亮底上几乎读不出来。内联 SVG 才能给文字做真描边
 * （paint-order: stroke，外深内亮两层），而且是矢量，22 / 28 / 40px 任何尺寸都清晰。
 * 形状本身携带语义（星 = 攻击、盾 = 生命），色盲也能分辨。
 */
function statBadge(kind, value, max) {
  const file = kind === 'atk' ? 'badge-atk.png' : 'badge-hp.png';
  const label = kind === 'atk' ? '攻击力' : '生命';
  const num = Number(value) || 0;
  const cap = Number(max);
  const showMax = Number.isFinite(cap) && cap > num;
  const aria = showMax ? label + " " + num + " / " + cap : label + " " + num;
  return `<span class="stat-badge sb-${kind}" data-kind="${kind}" data-value="${num}" title="${label}" aria-label="${aria}">`
    + '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">'
    + `<image href="img/${file}" xlink:href="img/${file}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet"></image>`
    + `<text class="b-num" x="50" y="62">${num}</text>`
    + (showMax ? `<text class="b-max" x="50" y="88">/${cap}</text>` : '')
    + '</svg></span>';
}

/**
 * 这一格正在挨的那一下（作者 2026-10：血量变化要等动画演完再显示）。
 *
 * 引擎是瞬间算完整场的，所以 state 里的 hp 早就扣完了 —— 直接照着画，
 * 玩家会看到「数字先掉、掉字后飘」。这里把当前正在播的那一条受击特效
 * 找出来，用它带来的 hpBefore 反推出「演到这里时本来该是多少血」。
 *
 * 同一条命可能挨好几下：每一击的 hpBefore 就是那一击之前的值，
 * 所以特效一条条播过去，数字会一下一下往下走，正好是想要的节奏。
 */
function hitDefer(view, uid) {
  const fx = view && view.fx;
  if (!fx || fx.kind !== 'hit') return null;
  if (fx.uid === undefined || fx.uid !== uid) return null;
  if (!Number.isFinite(fx.hpBefore)) return null;
  return fx;
}

function unitHTML(state, unit, view) {
  if (!unit) return '';
  const kws = keywordLabels(state, unit);
  const marks = markLabels(unit);
  const isTarget = view.legalUnitTargets.includes(unit.uid);
  /**
   * 被控制（心驭，作者 2026-10-24）：卡面加 .charmed（粉红纹路，见 style.css），
   * 名字下面再挂一颗「被控制」的小胶囊 —— 光靠纹路在缩略图里看不清，
   * 而「这张牌现在是敌是友」是玩家做决策时最需要一眼确认的事。
   */
  const charmed = !!unit.charmed;
  const classes = [
    'unit',
    unit.row === 'front' ? 'in-front' : 'in-back',
    isTarget ? 'targetable' : '',
    charmed ? 'charmed' : '',
  ].filter(Boolean).join(' ');

  // 显示有效攻击力（含光环），否则玩家看到的数字和实际打出的伤害对不上
  const atk = state ? effectiveAtk(state, unit) : unit.atk;

  // 这一下还没演完就按「挨打之前」的血量画（见 hitDefer 的注释）
  const dfx = hitDefer(view, unit.uid);
  const hpShown = dfx ? dfx.hpBefore : unit.hp;

  // 「会被谁打、打多少」—— 只给我方单位算，让玩家在开战前就能预判
  const preview = state ? attackPreview(state, unit) : null;

  // 卡面分层：名字 / 词条 / 标记 / 属性徽记 / 预览 / 血条，最多六层，同一屏要摆 40 张。
  // 空词条行原来是照渲染一个空盒子的（不占高，但每张牌都多一个空节点）；
  // 没有词条就不输出这一层 —— 大多数普通单位本来就没有词条。
  return `
    <div class="${classes}" data-uid="${unit.uid}">
      <div class="u-name">${esc(unit.name)}</div>
      ${charmed ? '<div class="u-charm">被控制</div>' : ''}
      ${kws.length ? `<div class="u-kw">${esc(kws.join(' · '))}</div>` : ''}
      ${marks.length ? `<div class="u-marks">${esc(marks.join(' '))}</div>` : ''}
      <div class="u-bottom">
        ${statBadge('atk', atk)}
        ${statBadge('hp', hpShown, unit.maxHp)}
      </div>
      ${preview ? `<div class="u-preview" title="开战时这一击会打向谁">${esc(preview)}</div>` : ''}
      ${hpShown < unit.maxHp ? `<div class="u-hpbar"><i style="width:${Math.max(0, (hpShown / unit.maxHp) * 100)}%"></i></div>` : ''}
    </div>`;
}

/**
 * 开战时这一击会打向谁 —— 只算攻击力 > 0 的单位。
 *
 * 交战优先级是 前排 → 后排 → 国王（裁决 D17），所以这里跟
 * engine 的 enemyCombatTarget 保持同一套判断。
 *
 * 卡面上这一行只在「前排空着」时才画（作者 2026-10 的「对战界面不要太杂」）：
 * 前排有单位时，它就在自家前排正上方那一格，谁挨这一下抬眼可见，
 * 再叠一行 9px 箭头只是把棋盘已经讲清的事再说一遍；同屏 40 张牌，重复的成本是
 * 「每一张都多一层文字」。真正说不清的是前排空着的那两种情形（打后排 / 直接打国王），
 * 那才是这一行存在的理由。
 */
function attackPreview(state, unit) {
  if (unit.side !== 0 && unit.side !== 1) return '';
  if (effectiveAtk(state, unit) <= 0) return '';
  const foe = 1 - unit.side;
  // 贴脸前排占着这一路：目标不言自明，这一行不画（见函数头的说明）
  if (state.board[unit.lane].units[foe].front) return '';
  const target = state.board[unit.lane].units[foe].back;
  const dmg = effectiveAtk(state, unit);
  if (target) return `→ ${target.name} ${dmg}`;
  return `→ 国王 ${dmg}`;
}

/**
 * 场上单位详情面板。
 *
 * 棋盘格子太小，塞不下卡面文字 —— 于是「这张牌在场上到底干什么」在界面上
 * 完全看不见（作者原话：看不到在场卡牌的攻击效果）。
 * 点一下场上的卡牌就弹这块面板：攻击力（含光环）、生命、词条全文、
 * 卡面效果文字，以及开战时这一击会打向谁。
 */
function unitInfoHTML(state, unit, view) {
  const def = state.cardLib[unit.cardId] || {};
  const atk = effectiveAtk(state, unit);
  const foeSide = 1 - unit.side;
  const target = state.board[unit.lane].units[foeSide].front
    || state.board[unit.lane].units[foeSide].back;

  const atkLine = atk === unit.atk
    ? `<b>${atk}</b>`
    : `<b>${atk}</b> <i class="ui-base">(卡面 ${unit.atk}${atk > unit.atk ? ` +${atk - unit.atk}` : ` ${atk - unit.atk}`} 光环)</i>`;

  const kwRows = (unit.keywords || []).map((k) => {
    const d = KEYWORD_DEFS[k.id] || {};
    const label = d.name ? `${d.name}${k.x || ''}` : k.id;
    return `<li><b>${esc(label)}</b>${d.note ? `<span>${esc(d.note)}</span>` : ''}</li>`;
  });
  if (hasRooted(state, unit) && !(unit.keywords || []).some((k) => k.id === 'rooted')) {
    kwRows.push(`<li><b>扎根*</b><span>${esc(KEYWORD_DEFS.rooted?.note || '被光环效果扎根，无法攻击')}</span></li>`);
  }

  const marks = (unit.marks || []).map((m) => {
    if (m.type === 'poison') return `毒${m.x}`;
    if (m.type === 'disease') return '疫';
    return m.type;
  });

  // 卡面文字优先；单位牌的异能引擎没法自动翻译，所以只有 def.text 这一条路
  const effect = def.text
    || (def.type === 'spell' ? spellDescription(def) : '');

  const spot = `${LANE_NAME[unit.lane]}${unit.row === 'front' ? '前排' : '后排'}`;
  /**
   * 被控制的单位要在这行里说清楚**现在归谁、原来是谁的** ——
   * 卡面上只有一颗「被控制」，不说原主人的话，玩家会以为是对方投降过来的。
   */
  const charmNote = unit.charmed
    ? `（被控制 · 原属${SIDE_NAME[unit.charmOrigin === undefined ? 1 - unit.side : unit.charmOrigin]}）`
    : '';
  const who = (unit.side === view.humanSide ? '我方' : '敌方') + ' · ' + spot + charmNote;

  const strike = atk > 0
    ? `<div class="ui-line">开战打向：<b>${target ? esc(target.name) : '国王'}</b> ${atk} 点</div>`
    : '<div class="ui-line ui-dim">攻击力为 0，开战不会造成伤害</div>';

  /**
   * 这张牌最近挨的几下 + **原因**（作者 2026-10-22：每次卡牌受伤都写明原因）。
   *
   * 数据直接读对局日志里带 uid 的 damage 条目：引擎写伤害时已经把原因
   * （交战 / 锦囊名 / 中毒 / 荆棘…）一起写了进去，所以这里不用再反推一遍，
   * 也不会出现「界面说的和实际结算的不一样」。
   */
  const hits = [];
  for (const e of state.log || []) {
    if (e.type !== 'damage' || e.uid !== unit.uid) continue;
    hits.push({ amount: e.amount, reason: e.reason || '未知来源' });
  }
  const hitRows = hits.slice(-4).reverse()
    .map((h) => `<li><b>−${h.amount}</b>${esc(h.reason)}</li>`).join('');

  return `
    <div class="unit-info">
      <div class="ui-backdrop" data-act="close-info"></div>
      <div class="ui-card">
        <div class="ui-head">
          <b class="ui-name">${esc(unit.name)}</b>
          <span class="ui-where">${esc(who)}</span>
        </div>
        <div class="ui-stats">
          <span class="ui-atk">⚔ ${atkLine}</span>
          <span class="ui-hp">♥ ${unit.hp}<i class="ui-base">/${unit.maxHp}</i></span>
          ${marks.length ? `<span class="ui-marks">${esc(marks.join(' '))}</span>` : ''}
        </div>
        ${kwRows.length ? `<ul class="ui-kws">${kwRows.join('')}</ul>` : ''}
        ${effect ? `<div class="ui-effect"><span class="ui-label">卡面</span>${esc(effect)}</div>`
          : '<div class="ui-effect ui-dim">这张牌没有额外效果</div>'}
        ${strike}
        ${hitRows ? `<div class="ui-hits"><span class="ui-label">最近受伤</span><ul>${hitRows}</ul></div>` : ''}
        <button class="ui-close" data-act="close-info">关闭</button>
      </div>
    </div>`;
}

function slotHTML(state, view, lane, side, row) {
  const unit = state.board[lane].units[side][row];
  const mine = side === view.humanSide;
  /**
   * 高亮合法落点。
   * 真对局：只有**自己**这一侧的格子会亮（否则对手的同名格会跟着一起亮）。
   * 靶场（作者 2026-10-23 第 3 条）：两边都亮 —— 点对面那一侧就是放到对面。
   */
  const sandboxBoard = state.sandbox === true;
  const isLegal = (mine || sandboxBoard)
    && view.legalSlots.some((p) => p.lane === lane && p.row === row
      && (!sandboxBoard || p.side === undefined || p.side === side));
  // 召唤落点：挂起等玩家点格子时，合法格借「可放置」那套发光样式亮起来
  const isSummonCell = mine && (view.legalSummonCells || []).some((c) => c.lane === lane && c.row === row);
  const isLaneTarget = mine && row === 'front' && view.legalLanes.includes(lane) && !unit;
  const interactive = isLegal || isLaneTarget || isSummonCell;
  /**
   * 手牌正飞向这一格：飞行播完之前先不画格子里的牌（作者 2026-10-07）。
   * 标记存在 render.js 的 view.flyPending 里，所以飞行途中重绘也不会提前露出。
   */
  const flyPendingKey = lane + '-' + side + '-' + row;
  const flyHidden = !!(view.flyPending && view.flyPending[flyPendingKey]);
  /**
   * 两步放置的第二步（作者 2026-10）：点过一下、还没确认的落点画成金色，
   * 和「能放但还没选」的绿色区分开，否则玩家不知道刚才那一下算不算数。
   */
  const picked = view.pickedSlot;
  const isPicked = mine && !!picked && picked.lane === lane && picked.row === row;
  // 长按拖动时手指压着的那一格
  const dragOver = view.dragOver;
  const isDragOver = mine && !!dragOver && dragOver.lane === lane && dragOver.row === row;
  const classes = [
    'slot',
    mine ? 'mine' : 'foe',
    `row-${row}`,
    flyHidden ? 'fly-pending' : '',
    interactive ? 'legal' : '',
    isPicked ? 'picked' : '',
    isDragOver ? 'drag-over' : '',
    unit ? 'occupied' : 'empty',
  ].filter(Boolean).join(' ');

  /**
   * 战斗可视化的特效（见 game-flow.js 的 pumpCombatFx）：
   *    fx-lunge ：这个单位正在出手（朝敌方前冲一下）
   *    fx-hit   ：这个格子挨了这一下（抖动 + 掉字）
   * 掉字挂在**格子**上而不是单位上  单位被打死之后就已经不在棋盘上了。
   */
  const fx = view.fx;
  const laneHot = !!(fx && fx.kind === 'attack' && fx.lane === lane);
  const here = !!(fx && fx.kind === 'hit'
    && ((fx.lane !== undefined && fx.lane === lane && fx.side === side && fx.row === row)
      || (fx.uid !== undefined && unit && unit.uid === fx.uid)));
  const lunge = !!(laneHot && unit && (fx.uids || []).includes(unit.uid));
  const fxClasses = [lunge ? 'fx-lunge' : '', here ? 'fx-hit' : ''].filter(Boolean);
  const fxRest = (fx && fx.animateFloat === false) ? ' fx-float-rest' : '';
  /**
   * 飘字下面挂一行「为什么」（作者 2026-10-22：每次卡牌受伤都写明原因）。
   * 原因由引擎写进日志（见 engine/src/damage.js 的 damageReason）：
   * 「火炮 交战」「毒镖」「中毒」「荆棘反弹（刺猬）」……没写就不画这一行。
   */
  const why = here && fx.reason ? `<i class="fx-why">${esc(fx.reason)}</i>` : '';
  const fxHTML = (here && fx.text) ? `<span class="fx-float${fxRest}">${fx.text}${why}</span>` : '';
  // 「单位被消灭」要等它所在线路的动画演完才结算（作者 2026-10 要求）。
  // 引擎是瞬间把整场算完的，阵亡单位早就从 state 里删掉了，这里用一块「残影」
  // 把它继续画在该格子里，直到这一路没有待播的特效为止（见 game-flow.js 的 pumpCombatFx）。
  let ghost = null;
  if (!unit) {
    const lanePending = !!((fx && fx.lane === lane) || (view.fxQueue || []).some((f) => f.lane === lane));
    if (lanePending) {
      ghost = (view.deadUnits || []).find((d) => d.lane === lane && d.side === side && d.row === row) || null;
    }
  }
  const allClasses = classes + (fxClasses.length ? ' ' + fxClasses.join(' ') : '');
  return `<div class="${allClasses}" data-lane="${lane}" data-side="${side}" data-row="${row}">${unitHTML(state, unit, view)}${ghost ? ghostHTML(state, ghost, true) : ''}${fxHTML}</div>`;
}

/**
 * 阵亡残影：单位死在本线路动画演完之前，先这么画着（见 slotHTML 里的说明）
 *
 * alive=true 表示「这一路的动画还在播，它其实还没退场」（作者 2026-10：
 * 退场要排在动画结束之后）—— 那时候按正常卡面画，别一上来就是半透明灰。
 * 灰色的那支留给真正开始消散的残影用。
 */
/**
 * ⚠ 残影**故意不带 data-uid**：它只是"这一路还没演完，先把牌继续画着"的替身，
 * 在引擎里已经不存在了。带上 uid 会让「点场上单位看详情」点到一块残影 ——
 * 点不出面板，而且测试里按 uid 收集的名单会混进死人。
 * 爪印要落在它身上，走的是**格子**（.slot[data-lane][data-side][data-row]），
 * 格子在阵亡前后都在（见 render.js 的 spawnClawFx）。
 */
function ghostHTML(state, g, alive) {
  const def = state.cardLib[g.cardId];
  // 还在等这一路演完（alive）时血量画「倒下前的那一格」——画 0 会像「0 血还站着」。
  // 真开始消散的残影（alive 为假）仍然画 0，那才是「已经没了」。
  const hp = alive && g.hpWait !== undefined ? g.hpWait : 0;
  const maxHp = alive && g.hpWait !== undefined && def ? def.hp : undefined;
  return `
    <div class="unit ghost${alive ? ' ghost-wait' : ''}">
      <div class="u-name">${esc(def ? def.name : g.cardId)}</div>
      <div class="u-bottom">
        ${statBadge('atk', def ? def.atk : 0)}
        ${statBadge('hp', hp, maxHp)}
      </div>
    </div>`;
}

function statusBarHTML(state, side, view) {
  const p = state.players[side];
  const isMe = side === view.humanSide;
  const isFirst = state.firstPlayer === side;
  /**
   * 敌方视角下看不见我埋陷阱花掉的那笔钱（作者 2026-10 口径）：
   * 自己的条显示**真值**（不然自己都不知道还剩多少费），对面那条显示 visibleMana。
   */
  // 靶场：费用不参与结算（playCard 里 cost 直接按 0 算），所以画成 ∞，
  // 也不画能量珠 —— 99 颗珠子既没意义又会把状态条挤爆。
  const sandboxMana = state.sandbox === true;
  const shownMana = sandboxMana ? '∞' : (isMe ? p.mana : visibleMana(state, side));
  // 直接问引擎谁是当前行动者，不要在这里重算一遍先后手逻辑
  const active = G.getActor(state) === side;

  const manaPips = sandboxMana ? '' : Array.from({ length: Math.max(p.manaCap, 0) }, (_, i) => {
    const cls = i < p.mana ? 'pip on' : 'pip';
    return `<i class="${cls}"></i>`;
  }).join('');

  // 当前选中的牌若可以指定国王为目标，血条上的国王要高亮并可点击
  const kingTargetable = (view.legalKingTargets || []).includes(side);

  return `
    <div class="statusbar ${isMe ? 'me' : 'foe'} ${active ? 'active' : ''}">
      <span class="sb-side"><b>${esc(view.playerNames ? view.playerNames[side] : (isMe ? '你' : 'AI'))}</b><i class="sb-role">${esc(view.playerTags ? view.playerTags[side] : (isFirst ? '先手' : '后手'))}</i></span>
      <span class="sb-king ${kingTargetable ? 'targetable' : ''}${(view.fx && view.fx.kind === 'hit' && view.fx.kingSide === side) ? ' fx-hit' : ''}" data-king="${side}" title="${kingTargetable ? '点击：把国王指定为目标' : '国王生命'}">♥ ${p.kingHp}</span>${(view.fx && view.fx.kind === 'hit' && view.fx.kingSide === side && view.fx.text) ? '<span class="fx-float fx-float-king' + (view.fx.animateFloat === false ? ' fx-float-rest' : '') + '">' + view.fx.text + (view.fx.reason ? '<i class="fx-why">' + esc(view.fx.reason) + '</i>' : '') + '</span>' : ''}
      <span class="sb-mana" title="费用">${sandboxMana ? '◈ ∞' : `◈ ${shownMana}/${p.manaCap}<span class="pips">${manaPips}</span>`}</span>
      <span class="sb-hand" title="手牌">手牌 ${p.hand.length}</span>
    </div>`;
}

/**
 * 靶场工具条（作者 2026-10-22）。
 *
 * 放的是「试卡时一直要动的那几个开关」：控制哪一方、两边阵营、AI 难度与待机、
 * 加任意一张牌、清空场地、重置。都做成一行一颗的小胶囊 —— 靶场是工具，不是界面。
 */
function sandboxBarHTML(state, view) {
  const mine = state.players[view.humanSide];
  const foeP = state.players[1 - view.humanSide];
  const fname = (k) => (k && (G.FACTIONS[k] || {}).name) || '未选';
  return `
  <div class="sb-bar">
    <div class="sb-row">
      <span class="sb-brand">靶场</span>
      <button class="sb-chip" data-act="sb-side">控制 ${view.humanSide === 0 ? '玩家1' : '玩家2'}</button>
      <button class="sb-chip" data-act="sb-faction-mine">我方 ${esc(fname(mine.faction))}</button>
      <button class="sb-chip" data-act="sb-faction-foe">对方 ${esc(fname(foeP.faction))}</button>
      <button class="sb-chip" data-act="sb-difficulty">难度 ${esc(view.sandboxDifficulty || '普通')}</button>
      <button class="sb-chip${view.sandboxAI ? ' on' : ''}" data-act="sb-ai">AI ${view.sandboxAI ? '行动' : '待机'}</button>
    </div>
    <div class="sb-row">
      <button class="sb-chip" data-act="sb-add">加牌</button>
      <button class="sb-chip" data-act="sb-refill">发满超能力</button>
      <button class="sb-chip" data-act="sb-clear">清空场地</button>
      <button class="sb-chip" data-act="sb-reset">重置靶场</button>
    </div>
  </div>`;
}

/**
 * 「加牌」面板：整个卡池按阵营分组，点一张就进手牌。
 *
 * 为什么不做搜索框：手机上一边打字一边选牌很别扭，而且卡池已经按阵营分好组
 * （每组最多十几张），滚两下就能找到。工坊用的是同一套「分组 + 点选」逻辑。
 */
function sandboxPickerHTML(state, view) {
  const groups = new Map();
  for (const id of Object.keys(state.cardLib || {})) {
    const c = state.cardLib[id];
    if (!c || c.legacy) continue;
    const key = c.faction || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const label = (k) => (k ? (G.FACTIONS[k] || {}).name || k : '中立');
  const order = [...Object.keys(G.FACTIONS), ''].filter((k) => groups.has(k));
  const blocks = order.map((k) => {
    const cards = groups.get(k).slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
    return `
      <div class="sb-pick-group">
        <div class="sb-pick-head">${esc(label(k))}</div>
        <div class="sb-pick-cards">
          ${cards.map((c) => `<button class="sb-pick-card${c.type === 'unit' ? ' is-unit' : ''}"
            data-act="sb-give" data-id="${esc(c.id)}">${esc(c.name)}<i>${c.cost}${c.type === 'unit' ? ' · ' + c.atk + '/' + c.hp : ''}</i></button>`).join('')}
        </div>
      </div>`;
  }).join('');
  return `
    <div class="sb-pick">
      <div class="sb-pick-top"><b>加一张牌到手牌</b><button class="sb-chip" data-act="sb-pick-close">关闭</button></div>
      <div class="sb-pick-body">${blocks}</div>
    </div>`;
}

function handHTML(state, view) {
  // 开局铺开：手牌是最后一个槽位（0..4 是五行棋盘，见 render() 的 rows）。
  // 铺到之前渲染成不可见（data-in="0"），出场时由 render.js 直接把属性翻成 "1"。
  const reveal = view && typeof view.revealShown === 'number' ? view.revealShown : null;
  const handIn = reveal === null || reveal >= REVEAL_TOTAL ? '' : ' data-in="0"';
  const p = state.players[view.humanSide];
  /**
   * 观战者（作者 2026-10-23 第 4 条）：**不画手牌**，一个格子也不画。
   *
   * 观战位是「看棋」，不是「帮一边看牌」。手牌张数在状态条上（手牌 N），
   * 所以要看的牌看得到，不该看的牌一张也不摆出来。
   * 走到这里说明调用方漏了防护 —— 返回空串，别把谁的手牌摊在观战者面前。
   */
  if (view.watcher === true) return '';
  if (!p.hand.length) return '<div class="hand-empty">手牌已空</div>';

  return p.hand.map((hc, hi) => {
    const def = state.cardLib[hc.cardId];
    if (!def) return '';
    // 手牌实例上可能带费用修正（「-1 花费」）—— 显示与实际扣费都必须读实例值，
    // 否则会出现「看着付得起、点下去报错」或者反过来。
    const cost = G.costOf(state, hc);
    const afford = cost <= p.mana;
    const playable = view.playableIids.includes(hc.iid);
    const selected = hc.iid === view.selectedIid;
    // 阵营超能力：高亮 + 角标。开局那一张没有「出牌」时刻，写提示行又会被
    // 后面的阶段提示顶掉，所以做成手牌上的持久标记（玩家一眼能看到自己有什么）。
    const isSuperpower = !!(p.superpowers || []).includes(hc.cardId);
    // 炼金原料：不能直接打出（引擎会拒绝），只能通过「炼药」消耗（见 play-input.js 的炼药模式）。
    // 手牌上单独标出来，玩家才知道哪些牌是能用来炼的料。
    const isRaw = !!def.rawMaterial;
    const brewPicked = isRaw && Array.isArray(view.brewIids) && view.brewIids.includes(hc.iid);
    const classes = [
      'card',
      def.type === 'unit' ? 'is-unit' : `is-spell ${def.spellKind === 'item' ? 'is-item' : 'is-attack'}`,
      isSuperpower ? 'is-superpower' : '',
      isRaw ? 'is-raw' : '',
      brewPicked ? 'brew-picked' : '',
      afford ? 'afford' : 'unafford',
      playable ? 'playable' : 'unplayable',
      selected ? 'selected' : '',
      // 正被手指拖着走的那张让位（克隆卡在 #fx-layer 里跟着手指，见 render.js）
      hc.iid === view.dragIid ? 'dragging' : '',
    ].filter(Boolean).join(' ');

    const stat = def.type === 'unit' ? `<div class="c-stats"><span>${def.atk}</span>/<span>${def.hp}</span></div>` : '';
    const kws = def.type === 'unit' && def.keywords?.length
      ? `<div class="c-kw">${esc(def.keywords.map((k) => {
        if (typeof k === 'object') return (KEYWORD_DEFS[k.id]?.name || k.id) + (k.x || '');
        const [id, x] = String(k).split(':');
        return (KEYWORD_DEFS[id]?.name || id) + (x || '');
      }).join(' '))}</div>`
      : '';
    // 卡面文字：优先用卡牌定义里写的 text（和手绘卡面一致），
    // 没写才用锦囊动作自动翻译 —— 单位牌的异能没法自动翻译。
    const desc = def.text
      ? `<div class="c-desc">${esc(def.text)}</div>`
      : (def.type === 'spell' ? `<div class="c-desc">${esc(spellDescription(def))}</div>` : '');

    return `
      <div class="${classes}" data-iid="${hc.iid}"${handIn} style="--i:${hi}">
        <div class="c-cost">${cost}${hc.costDelta ? '<i class="c-cost-mod">*</i>' : ''}</div>
        <div class="c-name">${esc(def.name)}</div>
        ${isSuperpower ? '<div class="c-sp">超能力</div>' : ''}
        ${isRaw ? '<div class="c-raw">原料</div>' : ''}
        ${stat}
        ${kws}
        ${desc}
      </div>`;
  }).join('');
}

/** 把锦囊的 actions 粗略翻译成人话（只在卡牌定义没写 text 时兜底） */
function spellDescription(def) {
  const parts = [];
  for (const a of def.actions || []) {
    switch (a.op) {
      case 'damage': parts.push(`造成 ${a.amount} 点伤害`); break;
      case 'destroy': parts.push('消灭目标'); break;
      case 'draw': parts.push(a.side === 'opponent' ? `对手抽 ${a.amount} 张` : `抽 ${a.amount} 张`); break;
      case 'gainManaCap': parts.push(`费用上限 +${a.amount}`); break;
      case 'gainMana': parts.push(`获得 ${a.amount} 费用`); break;
      case 'heal':
        parts.push(a.mode === 'halfLost' ? '回复已损失生命值的一半' : `恢复 ${a.amount} 点生命`);
        break;
      case 'sacrifice': parts.push('献祭一个友方单位'); break;
      case 'buffAtk': parts.push(`攻击力 ${a.amount > 0 ? '+' : ''}${a.amount}`); break;
      case 'buffMaxHp': parts.push(`生命上限 ${a.amount > 0 ? '+' : ''}${a.amount}`); break;
      case 'modifyStats': {
        const bits = [];
        if (a.atk) bits.push(`攻击力 ${a.atk > 0 ? '+' : ''}${a.atk}`);
        if (a.maxHp) bits.push(`生命上限 ${a.maxHp > 0 ? '+' : ''}${a.maxHp}`);
        parts.push(bits.join(' '));
        break;
      }
      case 'attachKingEffect': parts.push('使自己的国王获得一个永久效果'); break;
      // 心驭（作者 2026-10-24）：控制与「与其战斗」
      case 'control':
        parts.push('控制一名敌方单位' + (a.freeze ? '并冻结它' : '')
          + (a.returnAtTurnStart ? '，下个回合开始时还回对方手牌' : ''));
        break;
      case 'duel': parts.push('指定两个单位互相战斗'); break;
      case 'summonToHand': parts.push('获得一张' + (((typeof a.cardId === 'string' && a.cardId) || '') ? '「' + a.cardId + '」' : '牌')); break;
      default: parts.push(a.op);
    }
  }
  return parts.join('，');
}

// ── 主渲染 ────────────────────────────────────────────────

export function render(root, state, view) {
  const foeSide = 1 - view.humanSide;

  /**
   * 行标签（作者 2026-10-23 第 5 条）：观战者是第三方，没有「我 / 敌」——
   * 只有「玩家1 / 玩家2」，而且名字要跟着**它正在看的那一侧**走。
   *
   * 回放同理（作者 2026-10-28：「回放增加：可以看对方视角」）：切到对手那一侧时，
   * 若还按「我 / 敌」标行，下半场会写着「我前排」而状态条写着「对手」——
   * 同一个座位两种叫法。回放一律按名字标。
   */
  const rowLabel = (own, txt) => {
    if (view.watcher !== true && view.isReplay !== true) return (own ? '我' : '敌') + txt;
    const side = own ? view.humanSide : foeSide;
    const name = (view.playerNames && view.playerNames[side]) || ('玩家' + (side + 1));
    return name + ' ' + txt;
  };

  const rows = [
    { side: foeSide, row: 'back', label: rowLabel(false, '后排'), cls: 'r-foe-back' },
    { side: foeSide, row: 'front', label: rowLabel(false, '前排'), cls: 'r-foe-front' },
    { side: null, row: 'trap', label: '陷阱', cls: 'r-trap' },
    { side: view.humanSide, row: 'front', label: rowLabel(true, '前排'), cls: 'r-my-front' },
    { side: view.humanSide, row: 'back', label: rowLabel(true, '后排'), cls: 'r-my-back' },
  ];

  // 开局铺开：进度来自 render.js 的 boardReveal；没轮到的行渲染成 data-in="0"（不可见）。
  // 渲染出来的 HTML 永远不带 data-in="1"  出场动画只由属性翻转产生，重绘不会重放。
  const reveal = view && typeof view.revealShown === 'number' ? view.revealShown : null;
  const boardHTML = rows.map((r, ri) => {
    const rowIn = reveal !== null && ri >= reveal ? ' data-in="0"' : '';
    const cells = LANES.map((lane) => {
      if (r.side === null) {
        return trapSlotHTML(state, view, lane);
      }
      return slotHTML(state, view, lane, r.side, r.row);
    }).join('');
    return `<div class="board-row ${r.cls}"${rowIn} style="--i:${ri}"><div class="row-label">${r.label}</div><div class="row-cells">${cells}</div></div>`;
  }).join('');

  const laneHead = `<div class="board-row lane-head"><div class="row-label"></div><div class="row-cells">${
    LANES.map((l) => `<div class="lane-name">${LANE_NAME[l]}</div>`).join('')
  }</div></div>`;

  const actor = G.getActor(state);

  const phaseText = PHASE_LABEL[state.phase] || state.phase;
  const statusText = view.busy
    ? view.busyText || '结算中…'
    : (actor === null
      ? '自动阶段'
      : (view.playerNames && actor !== null
        ? `${view.playerNames[actor]} 行动中`
        : (actor === view.humanSide ? '轮到你了' : 'AI 行动中')));
  /** 靶场：随时都能出牌、随时都能按「结束阶段」（引擎那边也不再校验阶段） */
  const sandbox = state.sandbox === true;
  /**
   * 观战者（作者 2026-10-23）：**任何操作按钮都不该是可点的**。
   * 它不是这一局的玩家，按下去只会走一条注定被 session.submit 挡回来的路，
   * 界面上却看起来像「按得动」—— 那是骗人。所以这里直接把 canAct 关掉。
   */
  const watchingGame = view.watcher === true;
  const canAct = watchingGame ? false : (sandbox ? !view.busy : (!view.busy && actor === view.humanSide && !state.winner));

  /**
   * 恶魔阵营的「献祭」按钮（作者 2026-10-03）：出现在结束阶段左边。
   * 条件 = 自己的阶段 + 自己场上还有单位 + 本局选了阵营（超能力系统开着）。
   * 点它进入献祭模式，再点一名自己的单位才算数（见 play-input.js）。
   */
  const myP = state.players && state.players[view.humanSide];
  const hasOwnUnit = !!allUnits(state).find((u) => u.side === view.humanSide);
  // 献祭是**恶魔阵营**专属（规则 D72）：不能只看「选过阵营」—— 别的阵营同样有 faction。
  const canSac = canAct && !view.isReplay && !!myP && myP.faction === 'demon' && hasOwnUnit;
  const sacBtn = canSac ? '<button class="btn-sac" data-act="sac">献祭</button>' : '';

  /**
   * 炼金阵营的「炼药」按钮（作者 2026-10-07）：和献祭一样排在结束阶段左边。
   * 用法 = 先在手里点原料（可多张，点一下选中、再点取消），再按这个按钮结算。
   * 手里至少两张原料才出现  一张凑不出任何组合。
   */
  const rawInHand = myP && myP.faction === 'alchemy'
    ? myP.hand.filter((c) => (state.cardLib[c.cardId] || {}).rawMaterial).length
    : 0;
  const canBrew = canAct && !view.isReplay && !!myP && myP.faction === 'alchemy' && rawInHand >= 2;
  const brewBtn = canBrew ? '<button class="btn-brew" data-act="brew">炼药</button>' : '';

  root.innerHTML = `
    <div class="topbar${sandbox ? ' topbar-sb' : ''}">
      <span class="turn">${sandbox ? '靶场 · ' : (view.watcher === true && !view.isReplay ? '观战 · ' : '')}第 ${state.turn} 回合</span>
      <span class="deck-left">牌库 ${state.deck.length}</span>
      ${myP && myP.faction === 'alchemy' ? `<span class="raw-left">原料 ${G.rawPileOf(state, view.humanSide).length}</span>` : ''}
      ${myP && myP.faction === 'flame' ? `<span class="raw-left">异火 ${G.flamePileOf(state, view.humanSide).length}</span>` : ''}
      ${(view.watcher === true || view.isReplay === true) ? `<button class="btn-watch" data-act="watch-side">视角：${esc(view.sideLabel || (view.playerNames && view.playerNames[view.humanSide]) || '玩家1')}</button>` : ''}
      <button class="btn-menu" data-act="menu">菜单</button>
    </div>
    ${sandbox ? sandboxBarHTML(state, view) + (view.pickOpen ? sandboxPickerHTML(state, view) : '') : ''}

    ${statusBarHTML(state, foeSide, view)}
    <div class="board-wrap">${laneHead}${boardHTML}</div>
    ${statusBarHTML(state, view.humanSide, view)}

    <div class="phasebar">
      <span class="phase-name">${phaseText}</span>
      <span class="phase-status">${statusText}</span>
      ${brewBtn}${sacBtn}
      <button class="btn-end" data-act="end" ${canAct ? '' : 'disabled'}>结束阶段</button>
    </div>

    ${view.hint ? `<div class="hint ${view.selectedIid !== null ? 'hint-active' : ''}">${esc(view.hint)}</div>` : ''}
    ${/**
       * 观战者不画手牌区（作者 2026-10-23 第 4 条：不要显示手牌格子）。
       * 双方各有几张手牌，状态条上那行「手牌 N」已经说了 —— 手牌格子对旁观者
       * 只是占掉屏幕下半截的一块空地。视角切换见顶栏的「视角」按钮。
       */
      view.watcher === true
        ? ''
        : `<div class="hand-wrap"><div class="hand">${handHTML(state, view)}</div></div>`}

    ${view.banner ? `<div class="banner${view.bannerAnimate === false ? ' banner-rest' : ''}">${esc(view.banner)}${view.bannerSub ? `<small>${esc(view.bannerSub)}</small>` : ''}</div>` : ''}
    ${infoHTML(state, view)}
    ${state.winner !== null && !view.isReplay ? gameOverHTML(state, view) : ''}
  `;
}

/** 找到正在查看详情的单位（没有就返回空串） */
function infoHTML(state, view) {
  if (view.infoUid === null || view.infoUid === undefined) return '';
  for (const lane of LANES) {
    for (const side of [0, 1]) {
      for (const row of ROWS) {
        const u = state.board[lane].units[side][row];
        if (u && u.uid === view.infoUid) return unitInfoHTML(state, u, view);
      }
    }
  }
  return '';
}

/**
 * 结算浮层。
 *
 * 除了胜负，还要把**这局赚了多少金币**讲清楚 —— 否则「金币系统」
 * 对玩家来说就是首页上一个莫名其妙变大的数字。
 */
function gameOverHTML(state, view) {
  const w = state.winner;
  const win = w !== 'draw' && w === view.humanSide;
  const text = w === 'draw' ? '平局' : (win ? '你赢了' : '你输了');
  const cls = w === 'draw' ? 'draw' : (win ? 'win' : 'lose');

  const s = view.settle;
  const rewardHTML = s
    ? `
      <div class="reward">
        <div class="reward-head">
          <span class="reward-gold">+${s.reward.total}</span>
          <i class="coin"></i>
          <span class="reward-total">共 ${s.gold} 金币</span>
        </div>
        <div class="reward-sub">
          <span><i class="dust"></i> +${s.reward.dust || 0} 星尘</span>
          <span>表现分 +${s.reward.perf || 0}</span>
          <span>Lv.${s.levelAfter} · 累计 ${s.perf || 0}</span>
        </div>
        <ul class="reward-lines">
          ${s.reward.lines.map((l) => `<li>${esc(l)}</li>`).join('')}
        </ul>
        ${s.leveledUp ? `<div class="reward-levelup">🎉 升到 Lv.${s.levelAfter} 了</div>` : ''}
      </div>`
    : '';

  return `
    <div class="overlay">
      <div class="result ${cls}">
        <h2>${text}</h2>
        <p>${esc(state.winReason || '')}</p>
        ${rewardHTML}
        <div class="result-ops">
          <button class="btn-restart" data-act="restart">再来一局</button>
          <button class="btn-home" data-act="back-home">返回首页</button>
        </div>
      </div>
    </div>`;
}

/**
 * 陷阱格的渲染（作者 2026-10 口径）：
 *    未触发的陷阱：**只有主人看得见卡名与效果**；敌方视角只显示「敌方陷阱」；
 *    已触发的陷阱：双方都看得见，并且稍微放大展示（`.trap-slot.revealed`）。
 * 说明：联机是锁步架构、双方跑同一个引擎，所以这里是「不让对方看见」的
 * **渲染层遮挡**（防手滑），不是防作弊  作者已确认这样就行。
 */
function trapSlotHTML(state, view, lane) {
  const one = (trap, isMine) => {
    if (!trap) return '';
    const def = state.cardLib[trap.cardId];
    const name = def ? def.name : trap.cardId;
    const text = def ? (def.text || '') : '';
    if (trap.revealed) return `<span class="trap-slot revealed" title="${text}">${name}</span>`;
    return isMine
      ? `<span class="trap-slot" title="${text}">${name}</span>`
      : '<span class="trap-slot hidden">敌方陷阱</span>';
  };
  const mine = one(state.board[lane].traps[view.humanSide], true);
  const foe = one(state.board[lane].traps[1 - view.humanSide], false);
  const inner = mine || foe;
  /**
   * 靶场（作者 2026-10-23 第 3 条）：手里选着陷阱牌时，中间这一行陷阱格也要亮
   * —— 点哪一格就埋伏在哪一条线路（见 play-input.js 的 handleSlotClick）。
   */
  const sel = view && view.selectedIid !== null
    ? (((state.players[view.humanSide] || {}).hand) || []).find((c) => c.iid === view.selectedIid)
    : null;
  const trapLegal = state.sandbox === true && !!sel
    && G.isTrapCard(state.cardLib[sel.cardId] || null);
  return `<div class="slot trap${trapLegal ? ' legal' : ''}" data-lane="${lane}">${inner || '<span class="trap-mark">陷阱格</span>'}</div>`;
}
