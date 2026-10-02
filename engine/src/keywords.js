/**
 * 词条层：只做「查询」与「判定」，不修改任何状态。
 * 对应《规则书 v0.2》§9 词条总表。
 *
 * 依赖方向：keywords ← mechanics ← effects ← engine
 */

import { LANES, DEFAULT_FORBIDDEN_LANES } from './constants.js';

/**
 * 词条定义表。
 *  params: 是否带数值参数 X
 *  kind:   类别（trigger 触发式 / replace 替代式 / static 静态 / restrict 打出限制 / action 动作）
 *  note:   规则出处与已裁决项
 */
export const KEYWORD_DEFS = {
  doubleStrike: { name: '双重打击', params: false, kind: 'trigger', note: '交战且未被消灭后，额外再攻击一次' },
  frenzy: { name: '狂热', params: false, kind: 'trigger', note: '交战并消灭敌方单位且自身存活后，额外再攻击一次' },
  disease: { name: '疾病', params: false, kind: 'trigger', note: '造成>0伤害后，目标下回合开始时被消灭' },
  armor: { name: '装甲', params: true, kind: 'replace', note: '受到伤害时减少X' },
  thorns: { name: '荆棘', params: true, kind: 'trigger', note: '受到伤害时对来源造成X点伤害' },
  blessing: { name: '祝福', params: true, kind: 'replace', note: '受到伤害时若伤害>X则设为X' },
  aquatic: { name: '水生', params: false, kind: 'restrict', note: '只能在水路打出' },
  amphibious: { name: '两栖', params: false, kind: 'restrict', note: '可在水路打出' },
  nimble: { name: '轻灵', params: false, kind: 'static', note: '原「飞行」。生命≥生命上限一半(上取整)时获得两栖，否则失去两栖；失去时若在水路则被消灭' },
  spellImmune: { name: '锦囊免疫', params: false, kind: 'static', note: '无法作为锦囊牌的目标' },
  crit: { name: '暴击', params: true, kind: 'trigger', note: '造成伤害时50%几率额外造成X点' },
  rooted: { name: '扎根', params: false, kind: 'static', note: '无法被移动，无法被弹射' },
  invincible: { name: '无敌', params: false, kind: 'static', note: '无法受到伤害或被弹射；但不免疫「消灭」' },
  combo: { name: '组合', params: false, kind: 'static', note: '解锁该线路第2个身位（前排1+后排1）' },
  splash: { name: '溅射', params: true, kind: 'trigger', note: '发动攻击时，对相邻左右各一条线路上的所有敌方单位(含后排)造成X点伤害' },
  poison: { name: '淬毒', params: true, kind: 'trigger', note: '造成>0伤害时，目标下回合开始时受X点伤害，无视机制（无敌除外）' },
  pierce: { name: '穿透', params: true, kind: 'trigger', note: '攻击时额外对本线路X个敌方单位(含后排)造成伤害；不足则溢出打国王' },
  firstStrike: { name: '先制', params: false, kind: 'static', note: '开战时本单位的伤害先于同线路其他单位结算；被它打死的敌人当回合不反击。卡面写作「这张牌在开战时优先攻击」' },

  // ── 第三批（2026-09，作者补充规则）
  freeze: { name: '冻结', params: false, kind: 'static', note: '被冻结的单位下一次攻击时不进行此次攻击，然后解除冻结。状态型，不是印在卡面上的词条' },
  hunt: { name: '捕猎', params: false, kind: 'trigger', note: '有敌方单位被打出时，若可能则移动至该单位的线路；多个捕猎单位按「山地→水路」的优先级依次移动' },
  trueStrike: { name: '必中', params: false, kind: 'static', note: '攻击时忽略敌方单位的阻挡，仅攻击国王，且这次伤害不可被免疫（无敌/祝福/装甲都不生效）' },
  rebirth: { name: '复生', params: false, kind: 'trigger', note: '被消灭后，在原处复活一次并失去复生；复活不触发打出效果' },
  fuse: { name: '融合进化', params: false, kind: 'restrict', note: '在一个友方单位现在的位置上打出：该友方单位消失（不触发被消灭效果），新单位占据这个位置' },
  cannotAttack: { name: '无法攻击', params: false, kind: 'static', note: '开战时不出手，即使攻击力被加成正数也不攻击（卡牌「卫兵」）' },
  trap: { name: '陷阱', params: false, kind: 'static', note: '标记类词条（卡牌「反应装甲」）：这张牌是埋伏/反制型，效果按卡面文字结算' },
};

/** 反查：中文名 → 词条 id */
export const KEYWORD_BY_NAME = Object.fromEntries(
  Object.entries(KEYWORD_DEFS).map(([id, d]) => [d.name, id]),
);

/**
 * 解析词条写法。支持三种形式：
 *   { id:'armor', x:1 }   对象（推荐）
 *   "armor:1"             字符串带参
 *   "armor"               字符串无参
 */
export function parseKeyword(raw) {
  if (raw === null || raw === undefined) throw new Error('parseKeyword: 收到空词条');
  if (typeof raw === 'object') {
    const id = resolveKeywordId(raw.id);
    return { id, x: raw.x === undefined ? 0 : Number(raw.x) };
  }
  const str = String(raw).trim();
  const [rawId, rawX] = str.split(':');
  const id = resolveKeywordId(rawId);
  return { id, x: rawX === undefined || rawX === '' ? 0 : Number(rawX) };
}

function resolveKeywordId(rawId) {
  const key = String(rawId).trim();
  if (KEYWORD_DEFS[key]) return key;
  if (KEYWORD_BY_NAME[key]) return KEYWORD_BY_NAME[key];
  throw new Error(`未知词条: ${rawId}`);
}

/** 取词条实例（含 x），没有则返回 null */
export function getKw(unit, id) {
  if (!unit || !Array.isArray(unit.keywords)) return null;
  for (const k of unit.keywords) if (k.id === id) return k;
  return null;
}

export function hasKw(unit, id) {
  return getKw(unit, id) !== null;
}

/** 单位是否拥有「后排」特性（不会被普通交战命中）—— 由所在排决定，不是词条 */
export function isBackRow(unit) {
  return !!unit && unit.row === 'back';
}

/**
 * 单位当前是否具有「两栖」。
 * 来源有二：自带 amphibious 词条；或拥有 nimble 且生命值 ≥ 生命上限的一半（向上取整）。
 * 判定基准是「生命上限」而非固定值（裁决 B12 未明确，此处按生命上限实现）。
 */
export function hasAmphibious(unit) {
  if (!unit || unit.hp <= 0) return false;
  if (hasKw(unit, 'amphibious')) return true;
  if (hasKw(unit, 'nimble')) {
    return unit.hp >= Math.ceil(unit.maxHp / 2);
  }
  return false;
}

/** 轻灵：失去两栖时若在水路 → 应被消灭 */
export function nimbleShouldDrown(unit) {
  return hasKw(unit, 'nimble') && unit.lane === 'water' && !hasAmphibious(unit);
}

/**
 * 放置合法性（规则书 §5.3）。
 * 水生：只能水路。两栖/轻灵(且达标)：任意。其余：不能水路。
 */
export function canPlaceInLane(unit, lane) {
  if (!LANES.includes(lane)) return false;
  if (hasKw(unit, 'aquatic')) return lane === 'water';
  if (hasAmphibious(unit)) return true;
  return !DEFAULT_FORBIDDEN_LANES.includes(lane);
}

/**
 * 「冻结」是**状态**不是印在卡面上的词条：单位被打出效果冻结后带上 freeze 标记，
 * 开战时跳过它这一次攻击，然后摘掉标记（作者补充规则）。
 */
export function isFrozen(unit) {
  if (!unit || unit.removed) return false;
  return (unit.marks || []).some((m) => m.type === 'freeze');
}

/**
 * 结算「受到伤害」的替代式修正（词条 B6 建议的固定结算链）。
 *   无敌 → 0
 *   祝福X → 封顶
 *   装甲X → 减伤
 * 返回最终伤害（≥0）。
 *
 * opts.ignoreMechanisms = true 时跳过祝福/装甲（用于「淬毒」），但「无敌」仍然生效（裁决 B7）。
 * opts.unpreventable  = true 时**一切防御都不生效** —— 连「无敌」也挡不住（用于「必中」）。
 */
export function computeFinalDamage(target, raw, opts = {}) {
  if (raw <= 0) return 0;
  if (opts.unpreventable) return raw;
  /**
   * 被封印：**除攻击力与生命之外的一切都失效**（裁决 D62），
   * 所以伤害管线里的词条  祝福 / 装甲 / 无敌  也都不参与结算。
   *
   * 判据由调用方（damage.js）算好传进来，因为这个函数拿不到 state：
   * 一次性封印看 `unit.sealed`，光环式封印（大封印碑）要看 `isSealedByAura(state, unit)`。
   */
  if (opts.sealed) return raw;
  if (hasKw(target, 'invincible')) return 0;
  if (opts.ignoreMechanisms) return raw;

  let amount = raw;
  const blessing = getKw(target, 'blessing');
  if (blessing && amount > blessing.x) amount = blessing.x;
  const armor = getKw(target, 'armor');
  if (armor) amount = Math.max(0, amount - armor.x);
  return amount;
}

/** 单位能否被移动。「扎根」（含光环授予的）会挡住移动 —— 这是扎根的第二个实际作用。 */
export function canBeMoved(unit) {
  if (!unit || unit.removed) return false;
  return !hasKw(unit, 'rooted');
}

/** 该卡牌定义是否可以放置在指定线路（用于引擎的合法性检查） */
export function cardCanPlaceIn(def, lane) {
  return canPlaceInLane({ keywords: def.keywords || [], hp: def.hp, maxHp: def.hp, lane: null }, lane);
}

/**
 * 目标限定条件（用于「消灭一名攻击力≤2的敌人」这类效果）。
 *
 * filter 既支持旧的字符串写法 'spellTargetable'，也支持对象：
 *   { spellTargetable: true }        排除「锦囊免疫」单位
 *   { maxAtk: 2 }                    攻击力 ≤ 2
 *   { minAtk: 3 } / { maxHp: n } / { minHp: n }
 *   { row: 'front' | 'back' }
 *   { lane: 'water' }
 *   { keyword: 'amphibious' }        必须拥有某词条
 *   { damaged: true }                只选「受伤」的单位（当前生命 < 生命上限）
 *   { undamaged: true }              只选「未受伤」的单位
 *
 * ctx 可选，用来注入「需要看全局才知道」的数值（光环效果）：
 *   ctx.atkOf(unit)      取单位的**有效**攻击力（含光环，如拷问官的 -3）
 *   ctx.isRooted(unit)   单位是否带「扎根」（含拷问官光环授予的）
 * 不传 ctx 时退化为单位自身的裸数值。
 *
 * 引擎、AI、界面三处都调用这一个函数，保证「能选的目标」完全一致。
 */
/** 单位是否处于「无法选中」状态（卡牌「神威」）。三处同源实现共用这一个判定 */
export function isUntargetable(unit) {
  return !!(unit && (unit.marks || []).some((m) => m.type === 'untargetable'));
}

export function matchesTargetFilter(unit, filter, ctx = {}) {
  if (!unit) return false;
  /**
   * 「无法选中」（卡牌「神威」）：作者 2026-10 口径 ——
   *   「**不能被除自身效果以外任何效果影响**」，开战回合时这条线上敌方单位的攻击略过它。
   *
   * 所以判据是「**这道效果的来源是不是它自己**」（`ctx.source`）：
   *   · 来源就是它自己 → 放行（它自己的效果照常生效）；
   *   · 别的任何来源（敌方、友方、锦囊、环境）→ 一律拒绝；
   *   · **拿不到来源**（界面 / AI / 规则测试等）→ 保守拒绝。
   *
   * ⚠这条口径的代价（作者已确认）：被神威保护的队友，**自己人也选不中它**
   *   —— 想给它加装甲/加攻都点不上。若哪天要改成"只挡敌方"，把这里换成
   *   `ctx.controller !== unit.side` 并让 filterCtx 收 controller 即可（一行的事）。
   *
   * 另外三处同源实现（改一处要一起想）：
   *   · **范围伤害 / 批量选择器** → targets.js 的 batch（那里一定会过这个函数）
   *   · **开战略过** → board.js 的 enemyCombatTarget
   *   · **不经过选择的伤害**（溅射/穿透/观察者/荆棘）→ damage.js 的 dealDamage
   */
  if (isUntargetable(unit) && ctx.source !== unit) return false;
  if (!filter) return true;

  if (typeof filter === 'string') {
    if (filter === 'spellTargetable') return !hasKw(unit, 'spellImmune');
    return true;
  }

  if (filter.spellTargetable && hasKw(unit, 'spellImmune')) return false;

  const atk = ctx.atkOf ? ctx.atkOf(unit) : unit.atk;

  if (filter.maxAtk !== undefined && atk > filter.maxAtk) return false;
  if (filter.minAtk !== undefined && atk < filter.minAtk) return false;
  if (filter.maxHp !== undefined && unit.hp > filter.maxHp) return false;
  if (filter.minHp !== undefined && unit.hp < filter.minHp) return false;
  if (filter.row && unit.row !== filter.row) return false;
  if (filter.lane && unit.lane !== filter.lane) return false;
  // 「平地上的所有敌人」这类：一次限定多条线路（平地左 + 平地右）
  if (filter.laneIn && !filter.laneIn.includes(unit.lane)) return false;
  if (filter.keyword && !hasKw(unit, filter.keyword)) return false;

  // 「受伤」= 当前生命低于生命上限。用于「斩杀：消灭一名受伤的敌人」。
  const hurt = unit.hp < unit.maxHp;
  if (filter.damaged !== undefined && hurt !== !!filter.damaged) return false;
  if (filter.undamaged !== undefined && hurt === !!filter.undamaged) return false;

  if (filter.rooted !== undefined) {
    const isRooted = ctx.isRooted ? ctx.isRooted(unit) : hasKw(unit, 'rooted');
    if (isRooted !== !!filter.rooted) return false;
  }

  return true;
}
