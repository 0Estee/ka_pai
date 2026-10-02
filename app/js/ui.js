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
import { visibleMana } from '../../engine/src/board.js';

const PHASE_LABEL = {
  TURN_START: '回合开始',
  DEPLOY_FIRST: '先手 · 放置单位',
  DEPLOY_SECOND: '后手 · 放置单位',
  SPELL_FIRST: '先手 · 打出锦囊',
  SPELL_SECOND: '后手 · 打出锦囊',
  COMBAT: '开战结算',
  TURN_END: '回合结束',
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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

function unitHTML(state, unit, view) {
  if (!unit) return '';
  const kws = keywordLabels(state, unit);
  const marks = markLabels(unit);
  const isTarget = view.legalUnitTargets.includes(unit.uid);
  const classes = [
    'unit',
    unit.row === 'front' ? 'in-front' : 'in-back',
    isTarget ? 'targetable' : '',
    view.lastDamaged.includes(unit.uid) ? 'flash-damage' : '',
    unit.uid === view.lastKilled ? 'flash-die' : '',
  ].filter(Boolean).join(' ');

  // 显示有效攻击力（含光环），否则玩家看到的数字和实际打出的伤害对不上
  const atk = state ? effectiveAtk(state, unit) : unit.atk;

  // 「会被谁打、打多少」—— 只给我方单位算，让玩家在开战前就能预判
  const preview = state ? attackPreview(state, unit) : null;

  return `
    <div class="${classes}" data-uid="${unit.uid}">
      <div class="u-name">${esc(unit.name)}</div>
      <div class="u-kw">${kws.length ? esc(kws.join(' · ')) : ''}</div>
      ${marks.length ? `<div class="u-marks">${esc(marks.join(' '))}</div>` : ''}
      <div class="u-bottom">
        <span class="u-atk" title="攻击力">⚔${atk}</span>
        <span class="u-hp" title="生命">♥${unit.hp}${unit.maxHp !== unit.hp ? `<i class="u-max">/${unit.maxHp}</i>` : ''}</span>
      </div>
      ${preview ? `<div class="u-preview" title="开战时这一击会打向谁">${esc(preview)}</div>` : ''}
      ${unit.hp < unit.maxHp ? `<div class="u-hpbar"><i style="width:${Math.max(0, (unit.hp / unit.maxHp) * 100)}%"></i></div>` : ''}
    </div>`;
}

/**
 * 我方单位在开战时这一击会打向谁 —— 只算攻击力 > 0 的我方单位。
 *
 * 交战优先级是 前排 → 后排 → 国王（裁决 D17），所以这里跟
 * engine 的 enemyCombatTarget 保持同一套判断。
 */
function attackPreview(state, unit) {
  if (unit.side !== 0 && unit.side !== 1) return '';
  if (effectiveAtk(state, unit) <= 0) return '';
  const foe = 1 - unit.side;
  const target = state.board[unit.lane].units[foe].front
    || state.board[unit.lane].units[foe].back;
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

  const who = unit.side === view.humanSide ? `我方 · ${LANE_NAME[unit.lane]}${unit.row === 'front' ? '前排' : '后排'}`
    : `敌方 · ${LANE_NAME[unit.lane]}${unit.row === 'front' ? '前排' : '后排'}`;

  const strike = atk > 0
    ? `<div class="ui-line">开战打向：<b>${target ? esc(target.name) : '国王'}</b> ${atk} 点</div>`
    : '<div class="ui-line ui-dim">攻击力为 0，开战不会造成伤害</div>';

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
        <button class="ui-close" data-act="close-info">关闭</button>
      </div>
    </div>`;
}

function slotHTML(state, view, lane, side, row) {
  const unit = state.board[lane].units[side][row];
  const mine = side === view.humanSide;
  // 只有自己的格子才可能被高亮为合法落点，否则对手的同名格会一起亮
  const isLegal = mine && view.legalSlots.some((p) => p.lane === lane && p.row === row);
  const isLaneTarget = mine && row === 'front' && view.legalLanes.includes(lane) && !unit;
  const interactive = isLegal || isLaneTarget;
  const classes = [
    'slot',
    mine ? 'mine' : 'foe',
    `row-${row}`,
    interactive ? 'legal' : '',
    unit ? 'occupied' : 'empty',
  ].filter(Boolean).join(' ');

  /**
   * 战斗可视化的特效（见 game-flow.js 的 pumpCombatFx）：
   *    fx-lane  ：这一路正在交战（整路闪一下）
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
  const fxClasses = [laneHot ? 'fx-lane' : '', lunge ? 'fx-lunge' : '', here ? 'fx-hit' : ''].filter(Boolean);
  const fxRest = (fx && fx.animateFloat === false) ? ' fx-float-rest' : '';
  const fxHTML = (here && fx.text) ? `<span class="fx-float${fxRest}">${fx.text}</span>` : '';
  const allClasses = classes + (fxClasses.length ? ' ' + fxClasses.join(' ') : '');
  return `<div class="${allClasses}" data-lane="${lane}" data-side="${side}" data-row="${row}">${unitHTML(state, unit, view)}${fxHTML}</div>`;
}

function statusBarHTML(state, side, view) {
  const p = state.players[side];
  const isMe = side === view.humanSide;
  const isFirst = state.firstPlayer === side;
  /**
   * 敌方视角下看不见我埋陷阱花掉的那笔钱（作者 2026-10 口径）：
   * 自己的条显示**真值**（不然自己都不知道还剩多少费），对面那条显示 visibleMana。
   */
  const shownMana = isMe ? p.mana : visibleMana(state, side);
  // 直接问引擎谁是当前行动者，不要在这里重算一遍先后手逻辑
  const active = G.getActor(state) === side;

  const manaPips = Array.from({ length: Math.max(p.manaCap, 0) }, (_, i) => {
    const cls = i < p.mana ? 'pip on' : 'pip';
    return `<i class="${cls}"></i>`;
  }).join('');

  // 当前选中的牌若可以指定国王为目标，血条上的国王要高亮并可点击
  const kingTargetable = (view.legalKingTargets || []).includes(side);

  return `
    <div class="statusbar ${isMe ? 'me' : 'foe'} ${active ? 'active' : ''}">
      <span class="sb-side"><b>${isMe ? '你' : 'AI'}</b><i class="sb-role">${isFirst ? '先手' : '后手'}</i></span>
      <span class="sb-king ${kingTargetable ? 'targetable' : ''}${(view.fx && view.fx.kind === 'hit' && view.fx.kingSide === side) ? ' fx-hit' : ''}" data-king="${side}" title="${kingTargetable ? '点击：把国王指定为目标' : '国王生命'}">♥ ${p.kingHp}</span>${(view.fx && view.fx.kind === 'hit' && view.fx.kingSide === side && view.fx.text) ? '<span class="fx-float fx-float-king' + (view.fx.animateFloat === false ? ' fx-float-rest' : '') + '">' + view.fx.text + '</span>' : ''}
      <span class="sb-mana" title="费用">◈ ${shownMana}/${p.manaCap}<span class="pips">${manaPips}</span></span>
      <span class="sb-hand" title="手牌">手牌 ${p.hand.length}</span>
    </div>`;
}

function handHTML(state, view) {
  const p = state.players[view.humanSide];
  if (!p.hand.length) return '<div class="hand-empty">手牌已空</div>';

  return p.hand.map((hc) => {
    const def = state.cardLib[hc.cardId];
    if (!def) return '';
    // 手牌实例上可能带费用修正（「-1 花费」）—— 显示与实际扣费都必须读实例值，
    // 否则会出现「看着付得起、点下去报错」或者反过来。
    const cost = G.costOf(state, hc);
    const afford = cost <= p.mana;
    const playable = view.playableIids.includes(hc.iid);
    const selected = hc.iid === view.selectedIid;
    const classes = [
      'card',
      def.type === 'unit' ? 'is-unit' : `is-spell ${def.spellKind === 'item' ? 'is-item' : 'is-attack'}`,
      afford ? 'afford' : 'unafford',
      playable ? 'playable' : 'unplayable',
      selected ? 'selected' : '',
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
      <div class="${classes}" data-iid="${hc.iid}">
        <div class="c-cost">${cost}${hc.costDelta ? '<i class="c-cost-mod">*</i>' : ''}</div>
        <div class="c-name">${esc(def.name)}</div>
        ${stat}
        ${kws}
        ${desc}
      </div>`;
  }).join('');
}

/** 把锦囊的 actions 粗略翻译成人话（只在卡牌定义没写 text 时兜底） */
export function spellDescription(def) {
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
      default: parts.push(a.op);
    }
  }
  return parts.join('，');
}

// ── 主渲染 ────────────────────────────────────────────────

export function render(root, state, view) {
  const foeSide = 1 - view.humanSide;

  const rows = [
    { side: foeSide, row: 'back', label: '敌后排', cls: 'r-foe-back' },
    { side: foeSide, row: 'front', label: '敌前排', cls: 'r-foe-front' },
    { side: null, row: 'trap', label: '陷阱', cls: 'r-trap' },
    { side: view.humanSide, row: 'front', label: '我前排', cls: 'r-my-front' },
    { side: view.humanSide, row: 'back', label: '我后排', cls: 'r-my-back' },
  ];

  const boardHTML = rows.map((r) => {
    const cells = LANES.map((lane) => {
      if (r.side === null) {
        return trapSlotHTML(state, view, lane);
      }
      return slotHTML(state, view, lane, r.side, r.row);
    }).join('');
    return `<div class="board-row ${r.cls}"><div class="row-label">${r.label}</div><div class="row-cells">${cells}</div></div>`;
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
      : (actor === view.humanSide ? '轮到你了' : 'AI 行动中'));
  const canAct = !view.busy && actor === view.humanSide && !state.winner;

  root.innerHTML = `
    <div class="topbar">
      <span class="turn">第 ${state.turn} 回合</span>
      <span class="deck-left">牌库 ${state.deck.length}</span>
      <button class="btn-menu" data-act="menu">菜单</button>
    </div>

    ${statusBarHTML(state, foeSide, view)}
    <div class="board-wrap">${laneHead}${boardHTML}</div>
    ${statusBarHTML(state, view.humanSide, view)}

    <div class="phasebar">
      <span class="phase-name">${phaseText}</span>
      <span class="phase-status">${statusText}</span>
      <button class="btn-end" data-act="end" ${canAct ? '' : 'disabled'}>结束阶段</button>
    </div>

    ${view.hint ? `<div class="hint ${view.selectedIid !== null ? 'hint-active' : ''}">${esc(view.hint)}</div>` : ''}
    <div class="hand-wrap"><div class="hand">${handHTML(state, view)}</div></div>

    ${view.banner ? `<div class="banner">${esc(view.banner)}${view.bannerSub ? `<small>${esc(view.bannerSub)}</small>` : ''}</div>` : ''}
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

export { PHASE_LABEL };
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
  return `<div class="slot trap" data-lane="${lane}">${inner || '<span class="trap-mark">陷阱格</span>'}</div>`;
}
