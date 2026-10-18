/**
 * 0.59.0 交互动画与两步放置（作者 2026-10 的四条要求）
 *
 * 1. 挨打的卡出现随机一种爪印：一笔一笔抓上去（不是一下子全出现），随后淡出。
 * 2. 出手的卡正反面转一圈。
 * 3. 掉血数字与退场都排在动画之后（先看到掉血、再看到牌消失）。
 * 4. 放置改两步：点牌 → 高亮可放区 → 点格子选中 → 该格高亮 → 再点同一格才放下；
 *    另外支持长按拖动放置，拖到合法格子即放，拖失败从当前位置飞回手牌。
 *
 * 门禁的 DOM 桩没有 createElement / elementFromPoint / getBoundingClientRect，
 * 所以爪印与拖动克隆卡这部分只能断言「源码与状态接得对、缺能力时安静退回」；
 * 具体观感靠 tools/verify-apk.ps1 的截图人工核对。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, api, elements, timers, check } from './harness.mjs';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const renderSrc = read('app/js/render.js');
const inputSrc = read('app/js/play-input.js');
const flowSrc = read('app/js/game-flow.js');
const uiSrc = read('app/js/ui.js');
const mainSrc = read('app/js/main.js');
const cssSrc = read('app/style.css');

api.setDifficulty('easy');

console.log('\n 0.59.0 交互动画与两步放置');

const stageHTML = () => {
  const el = elements.get('stage');
  return (el && el.innerHTML) || '';
};
const pumpAll = (n) => {
  for (let i = 0; i < n; i++) {
    for (const [id, t] of [...timers.entries()]) {
      timers.delete(id);
      try { t.fn(); } catch (e) { /* 桩 */ }
    }
  }
};

/** 摆一局「我方 W04 打对面 W02」的山地前排对撞，推进到开战。 */
const setupClash = () => {
  api.__go('home');
  api.__newGame();
  api.__pause(true);
  api.__place(0, 'W04', 'mountain', 'front');
  api.__place(1, 'W02', 'mountain', 'front');
  let n = 0;
  while (api.__game().phase !== 'COMBAT' && n++ < 14) api.__advance();
};

/* ── 1. 爪印 ───────────────────────────────────────────────────────── */

check('爪印素材齐全：6 组共 20 道抓痕，都是 160x160 的透明底 PNG', () => {
  const strokes = [3, 6, 3, 3, 1, 4];
  let total = 0;
  for (let g = 1; g <= strokes.length; g++) {
    for (let k = 1; k <= strokes[g - 1]; k++) {
      const p = path.join(ROOT, `app/img/claw-${g}-${k}.png`);
      if (!fs.existsSync(p)) throw new Error(`缺少爪印素材 ${g}-${k}`);
      const buf = fs.readFileSync(p);
      if (buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error(`claw-${g}-${k} 不是 PNG`);
      if (buf.readUInt32BE(16) !== 160 || buf.readUInt32BE(20) !== 160) {
        throw new Error(`claw-${g}-${k} 不是 160x160`);
      }
      if (buf[25] !== 6) throw new Error(`claw-${g}-${k} 不是 RGBA（缺透明通道）`);
      total++;
    }
  }
  if (total !== 20) throw new Error('爪印笔数不是 20：' + total);
});

check('爪印实现：随机挑一组、按笔顺序逐个入场、随后整组摘掉', () => {
  for (const n of ['function spawnClawFx(', 'function pickClawGroup(', 'const CLAW_STROKES']) {
    if (!renderSrc.includes(n)) throw new Error('render.js 缺少 ' + n);
  }
  // 随机 + 不连续重复（连着两只挨打不该是同一套爪印）
  if (!renderSrc.includes('clawLastGroup')) throw new Error('爪印没有避开「和上一次同一组」');
  // 逐笔：第 k 笔的动画延迟必须随 k 递增
  if (!/FX_CLAW_STEP_MS/.test(renderSrc)) throw new Error('爪印没有逐笔延迟常量');
  if (!renderSrc.includes("'animation-delay:'")) throw new Error('爪印没有给每一笔设 animation-delay');
  if (!renderSrc.includes('claw-') || !renderSrc.includes('.png')) throw new Error('爪印没有引用 claw-N-M.png');
  // 逐渐消失：CSS 端每一笔都要有淡出，且整组到点被移除
  if (!cssSrc.includes('@keyframes fx-claw-draw')) throw new Error('style.css 缺少 fx-claw-draw 关键帧');
  const key = cssSrc.slice(cssSrc.indexOf('@keyframes fx-claw-draw'));
  const block = key.slice(0, key.indexOf('\n}'));
  if (!/opacity:\s*0/.test(block) || !/opacity:\s*(1|\.9)/.test(block)) {
    throw new Error('fx-claw-draw 没有「淡入再淡出」的透明度变化');
  }
  if (!cssSrc.includes('.fx-claw i')) throw new Error('style.css 没有 .fx-claw i 的笔画样式');
});

check('爪印只在「单位受击」的那一拍挂上去，且不会重复叠', () => {
  // 挂在 applyTransientFx（渲染后拿活节点）里，而不是写进渲染字符串
  const at = renderSrc.indexOf('function applyTransientFx(');
  if (at < 0) throw new Error('render.js 没有 applyTransientFx');
  const body = renderSrc.slice(at, at + 4200);
  if (!body.includes('spawnClawFx(')) throw new Error('受击爪印没有挂在 applyTransientFx 里');
  if (!body.includes('clawDone')) throw new Error('爪印没有一次性标记，重绘会重复叠加');
  // 缺 DOM 能力时一行都不碰（门禁里 #fx-layer 永远建不起来）
  if (!renderSrc.includes('function canFlyDom(')) throw new Error('render.js 没有 canFlyDom 守卫');
  setupClash();
  api.__advance();
  pumpAll(4);
  const html = stageHTML();
  // fx-claw 是 JS 加在 #fx-layer 上的，绝不能出现在渲染字符串里
  if (html.includes('fx-claw')) throw new Error('爪印层被写进了渲染 HTML（每次重绘都会重播）');
});

/* ── 2. 翻面 ───────────────────────────────────────────────────────── */

check('出手翻面：两条 lunge 关键帧都带 rotateY 整圈，且回到正面', () => {
  for (const name of ['fx-lunge-mine', 'fx-lunge-foe']) {
    const i = cssSrc.indexOf('@keyframes ' + name);
    if (i < 0) throw new Error('style.css 缺少 @keyframes ' + name);
    const block = cssSrc.slice(i, cssSrc.indexOf('\n}', i));
    if (!/rotateY\(-?360deg\)/.test(block)) throw new Error(name + ' 没有转满一圈（rotateY 360deg）');
    if (!/rotateY\(0deg\)/.test(block)) throw new Error(name + ' 没有回到 0 度（翻完会歪着）');
    if (!/rotateY\(-?180deg\)/.test(block)) throw new Error(name + ' 中途没有经过 180 度（等于没翻面）');
    if (!block.includes('perspective(')) throw new Error(name + ' 没有 perspective，3D 翻转会变成横向压扁');
  }
  // 牌背只在「背朝观众」的那一段出现，否则会盖住牌面
  const bi = cssSrc.indexOf('@keyframes fx-flip-back');
  if (bi < 0) throw new Error('缺少 fx-flip-back 关键帧');
  const back = cssSrc.slice(bi, cssSrc.indexOf('\n}', bi));
  if (!/0%,\s*22%\s*\{\s*opacity:\s*0/.test(back)) throw new Error('牌背在翻面开头就露出来了');
  if (!/78%,\s*100%\s*\{\s*opacity:\s*0/.test(back)) throw new Error('牌背在翻面结尾没有收掉');
  if (!cssSrc.includes('.unit::after')) throw new Error('没有用 .unit::after 画牌背');
  if (!cssSrc.includes('.slot.fx-lunge .unit::after')) throw new Error('牌背没有跟 fx-lunge 绑定');
  // fx-lunge 仍由渲染字符串挂上（29-motion 的纪律正则允许）
  if (!uiSrc.includes("'fx-lunge'")) throw new Error('ui.js 没有给出手单位挂 fx-lunge');
  // 翻面时长要落在一步特效的时间预算内
  if (!/fx-lunge-mine \.38s/.test(cssSrc) && !/\.38s ease-out/.test(cssSrc)) {
    throw new Error('翻面时长不是 .38s');
  }
});

/* ── 3. 血量与退场延后 ─────────────────────────────────────────────── */

check('血量延后：掉血数字与血条都等到这一步的特效播完才更新', () => {
  // 状态层：fx 里带 hpBefore / hpAfter，渲染层据此决定显示哪一个
  if (!flowSrc.includes('hpBefore')) throw new Error('fxOfLogEntry 没有把受伤前的血量带下去');
  if (!uiSrc.includes('hpBefore')) throw new Error('ui.js 没有用 hpBefore 延后血量显示');
  // 统一的「演到这里时该显示多少血」：unitHTML 里血条与生命盾都读它
  if (!uiSrc.includes('function hitDefer(')) {
    throw new Error('ui.js 没有 hitDefer：血量没有统一的延后口径');
  }
  if (!/const hpShown = dfx \? dfx\.hpBefore : unit\.hp/.test(uiSrc)) {
    throw new Error('unitHTML 没有按「挨打之前」的血量画生命盾');
  }
  if (!/hpShown < unit\.maxHp/.test(uiSrc)) {
    throw new Error('血条没有用延后后的血量判断（会出现血条先掉）');
  }
  setupClash();
  api.__advance();
  const st = api.__fx();
  if (!st.fx) throw new Error('开战之后没有特效');
  // 找出正在播的这条受击特效，它必须带着受伤前后两端的血量
  let hit = st.fx.kind === 'hit' && st.fx.uid !== undefined ? st.fx : null;
  for (const f of st.queue) if (!hit && f.kind === 'hit' && f.uid !== undefined) hit = f;
  if (hit) {
    // hpBefore = 挨这一下之前；hp = 扣完之后（引擎日志里就叫 hp）
    if (hit.hpBefore === undefined || hit.hp === undefined) {
      throw new Error('受击特效没有带 hpBefore / hp（血量没法延后到动画之后）');
    }
    if (!(hit.hpBefore > hit.hp)) {
      throw new Error('受伤前后血量没有变化：' + hit.hpBefore + '→' + hit.hp);
    }
  }
});

check('退场延后：本路特效全播完才加 fx-death，尾部还会多等一拍再撤残影', () => {
  setupClash();
  const at = flowSrc.indexOf('function stepCombatFx(');
  if (at < 0) throw new Error('game-flow.js 没有 stepCombatFx');
  const body = flowSrc.slice(at, at + 1500);
  // 队列空但还有阵亡牌 → 先 refresh 让 fx-death 补上，再等 FX_DEATH_MS 才撤
  if (!body.includes('view.deadUnits.length')) throw new Error('收尾没有为阵亡牌留退场这一拍');
  if (!body.includes('FX_DEATH_MS')) throw new Error('收尾没有等到退场动画播完（FX_DEATH_MS）');
  // applyTransientFx 里要有「本路还有待播特效就先不退场」的闸门
  if (!renderSrc.includes('laneBusy')) throw new Error('applyTransientFx 没有按线路判断还在演');
  // 残影在等待期用 ghost-wait 保持正常卡面（不半透明），退场那一下才变暗
  if (!renderSrc.includes('ghost-wait')) throw new Error('等待期残影没有 ghost-wait 类');
  if (!cssSrc.includes('.unit.ghost.ghost-wait')) throw new Error('style.css 缺少 .unit.ghost.ghost-wait');
  // 等待期残影的血量必须是「倒下前那一格」，不能画成 0（0 血还站着太怪）
  if (!flowSrc.includes('view.fxLastHp')) throw new Error('pumpCombatFx 没记住挨打前的血量');
  if (!uiSrc.includes('g.hpWait')) throw new Error('ghostHTML 没有用 hpWait 画等待期的血量');
});

check('退场时序：开战当帧不退场，整段演出走完才退', () => {
  setupClash();
  api.__advance();
  if (stageHTML().includes('fx-dead')) {
    throw new Error('开战当帧就把牌按掉了：应该等这一路的动画演完');
  }
  pumpAll(30);
  // 演完之后阵亡牌已经撤掉，棋盘上不该再有残影
  if (stageHTML().includes('unit ghost')) throw new Error('演出播完后残影还挂在棋盘上');
});

/* ── 4. 两步放置 + 长按拖动 ───────────────────────────────────────── */

/** 造一个「手上有单位牌、已经点开」的局面，返回 { iid, slot } */
const setupPicked = () => {
  api.__go('home');
  api.__newGame();
  api.__pause(true);
  const g = api.__game();
  const p = g.players[0];
  p.manaCap = 20; p.mana = 20;
  // 行动权：getActor 只在部署/锦囊阶段返回某一方，别的时候 selectCard 直接早退
  const me = api.__me();
  api.__setPhase(me === g.firstPlayer ? 'DEPLOY_FIRST' : 'DEPLOY_SECOND');
  const cardId = Object.keys(g.cardLib).find((id) => {
    const d = g.cardLib[id];
    return d.type === 'unit' && !d.token && d.cost <= 3;
  });
  const hc = { iid: g.nextIid++, cardId };
  p.hand.push(hc);
  api.__go('game');
  api.__selectCard(hc.iid);
  const st = api.__view();
  if (!st.legalSlots.length) throw new Error('摆不出可放置的局面：' + (st.hint || ''));
  return { iid: hc.iid, slot: st.legalSlots[0], cardId };
};

check('两步点选：第一次点格子只选中、第二次点同一格才真的放下去', () => {
  const { slot } = setupPicked();
  const handBefore = api.__game().players[api.__me()].hand.length;

  api.__slotClick(slot.lane, slot.row);
  const st1 = api.__view();
  if (st1.selectedIid === null) throw new Error('点第一下就把选中清掉了');
  if (!st1.pickedSlot) throw new Error('第一次点格子没有记下落点');
  if (st1.pickedSlot.lane !== slot.lane || st1.pickedSlot.row !== slot.row) {
    throw new Error('记下的落点和点的不一致');
  }
  if (api.__game().players[api.__me()].hand.length !== handBefore) {
    throw new Error('第一次点格子就把牌打出去了（应该是两步）');
  }
  // 选中的格子要能被渲染层画出来
  const html = stageHTML();
  if (!html.includes('picked')) throw new Error('选中的落点没有渲染出 picked 类');

  api.__slotClick(slot.lane, slot.row);
  if (api.__game().players[api.__me()].hand.length !== handBefore - 1) {
    throw new Error('第二次点同一格没有把牌放下去');
  }
});

check('两步点选：改点另一个合法格子等于改选，不会放牌', () => {
  const { slot } = setupPicked();
  const me = api.__me();
  const slots = api.__view().legalSlots;
  const other = slots.find((s) => s.lane !== slot.lane || s.row !== slot.row);
  if (!other) return;   // 只有唯一落点时这条不适用
  const before = api.__game().players[me].hand.length;
  api.__slotClick(slot.lane, slot.row);
  api.__slotClick(other.lane, other.row);
  if (api.__game().players[me].hand.length !== before) throw new Error('改选落点却把牌打出去了');
  const st = api.__view();
  if (!st.pickedSlot || st.pickedSlot.lane !== other.lane) throw new Error('改选后落点没有跟过去');
});

check('两步点选：提示语说清楚「再点一次确认」', () => {
  const { slot } = setupPicked();
  api.__slotClick(slot.lane, slot.row);
  const hint = api.__view().hint || '';
  if (!hint.includes('再点一次')) throw new Error('选中落点后的提示没有告诉玩家还要再点一次：' + hint);
});

check('长按拖动：源码里有 pointer 手势、判定与回飞，缺 DOM 时安静退回', () => {
  for (const n of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    if (!mainSrc.includes(n)) throw new Error('main.js 没有监听 ' + n);
  }
  if (!mainSrc.includes('DRAG_HOLD_MS')) throw new Error('没有长按阈值');
  // 拖动中的 click 必须被吃掉，否则刚放下的牌又被重新选中
  if (!mainSrc.includes('dragSwallowClick')) throw new Error('拖动结束的 click 没有被吃掉');
  for (const n of ['function canDragCard(', 'function beginCardDrag(', 'function updateCardDrag(', 'function endCardDrag(']) {
    if (!inputSrc.includes(n)) throw new Error('play-input.js 缺少 ' + n);
  }
  // 落点判定必须用 elementFromPoint，并且只在 legalSlots 里才算命中
  if (!inputSrc.includes('elementFromPoint')) throw new Error('拖动落点没有用 elementFromPoint');
  if (!/view\.legalSlots\.some\(\(s\) => s\.lane === hit\.lane/.test(inputSrc)) {
    throw new Error('拖动落点没有限定在 legalSlots 内');
  }
  // 回飞：从当前位置飞回手牌
  if (!renderSrc.includes('function flyDragChipBack(')) throw new Error('render.js 没有「飞回手牌」');
  if (!renderSrc.includes('function beginDragChip(')) throw new Error('render.js 没有拖动克隆卡');
  if (!cssSrc.includes('.fx-drag-card')) throw new Error('style.css 缺少拖动克隆卡的样式');
  if (!cssSrc.includes('.hand .card.dragging')) throw new Error('style.css 缺少手牌让位样式');
  if (!renderSrc.includes('FX_DRAG_FLY_MS')) throw new Error('回飞没有时长常量');
  // 拖动手势的入口必须自己判能力，不能因为缺 DOM 就抛
  const ok = api.__canDrag(-1);
  if (ok !== false) throw new Error('canDragCard 对不存在的牌没有返回 false');
});

check('长按拖动：拖到合法格子即放，拖到别处不算放牌并保留选中', () => {
  const { iid, slot } = setupPicked();
  const me = api.__me();
  const before = api.__game().players[me].hand.length;
  if (!api.__beginDrag(iid)) throw new Error('合法的单位牌拖不起来');
  // 手工指定落点（门禁没有 elementFromPoint）
  api.__dragTo(slot.lane, slot.row);
  const res = api.__endDrag();
  if (!res || !res.placed) throw new Error('拖到合法格子上却没有放下去');
  if (api.__game().players[me].hand.length !== before - 1) throw new Error('放下之后手牌数量没变');

  // 再拖一张，落在非法位置
  const st2 = setupPicked();
  const me2 = api.__me();
  const before2 = api.__game().players[me2].hand.length;
  if (!api.__beginDrag(st2.iid)) throw new Error('第二张牌拖不起来');
  api.__dragTo('nope', 'front');
  const res2 = api.__endDrag();
  if (res2 && res2.placed) throw new Error('拖到非法位置却把牌放出去了');
  if (api.__game().players[me2].hand.length !== before2) throw new Error('拖失败却消耗了手牌');
  if (api.__view().selectedIid !== st2.iid) throw new Error('拖失败后没有保留选中（玩家得重新点牌）');
});

check('可放区高亮：选中 / 拖动 / 已选落点三态在样式上分得开', () => {
  const i = cssSrc.indexOf('.slot.legal');
  if (i < 0) throw new Error('style.css 缺少 .slot.legal');
  const legal = cssSrc.slice(i, cssSrc.indexOf('\n}', i));
  if (!legal.includes('var(--legal)')) throw new Error('.slot.legal 没有用可放置色');
  const pi = cssSrc.indexOf('.slot.picked');
  if (pi < 0) throw new Error('style.css 缺少 .slot.picked（已选好落点的那一格看不出来）');
  const picked = cssSrc.slice(pi, cssSrc.indexOf('\n}', pi));
  if (!picked.includes('var(--accent)') && !picked.includes('var(--gold)')) {
    throw new Error('.slot.picked 与 .slot.legal 没有可区分的颜色');
  }
  // 拖动时悬停的那一格要更亮
  if (!cssSrc.includes('.slot.drag-over')) throw new Error('style.css 缺少 .slot.drag-over');
});
