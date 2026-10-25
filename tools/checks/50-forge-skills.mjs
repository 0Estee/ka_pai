/**
 * § 精通技能表：28 个技能**必须每一个都真的能生效**
 *
 * 防的是「技能表里写了一条，但引擎 / 翻译层不认，玩家选了等于没选」这种静默失效。
 * 作者 2026-10-24 把旧的 16 个技能整表换成了五档 28 个新技能 —— 其中有
 * `fx`（触发式异能）/ `flags`（单位级开关）/ `kingAura`（国王被动）/ `expand`（全能展开）
 * 四类新东西，引擎侧必须全部接住。
 */
import { api, check } from './harness.mjs';

console.log('\n§ 精通技能表（五档 28 技能，作者 2026-10-24）');

const lib = api.__cardLib();
const forgeable = (d) => !!d && !d.token && !d.faction && !d.legacy;
const unitId = Object.keys(lib).find((id) => forgeable(lib[id]) && lib[id].type === 'unit');

check('技能表是 28 个，五档齐全（白/绿/橙/紫/彩）', () => {
  const ids = api.__forgeSkillIds();
  if (ids.length !== 28) throw new Error('技能数应为 28，实际 ' + ids.length);
  if (new Set(ids).size !== ids.length) throw new Error('技能 id 有重复');
  const rar = api.__forgeRarity();
  for (const k of ['white', 'green', 'orange', 'purple', 'rainbow']) {
    if (rar.indexOf(k) < 0) throw new Error('缺少档位 ' + k);
  }
});

check('每个技能都会产出引擎增量（没有任何一条是「选了等于没选」）', () => {
  const ids = api.__forgeSkillIds();
  const inert = [];
  for (const id of ids) {
    const d = api.__forgeDelta(unitId, id);
    if (!d) { inert.push(id); continue; }
    const has = (d.atk || d.hp || d.cost
      || (d.kw && d.kw.length)
      || (d.fx && d.fx.length)
      || (d.flags && Object.keys(d.flags).length)
      || d.kingAura);
    if (!has) inert.push(id);
  }
  if (inert.length) throw new Error('这些技能没有产出任何增量：' + inert.join(', '));
});

check('技能表用到的新 op / 新目标都真的出现在增量里', () => {
  const ops = ['summonSelf', 'setKingHp', 'discardHandUnits'];
  const kinds = ['randomEnemyUnits'];
  const ids = api.__forgeSkillIds();
  const used = [];
  const walk = (list) => {
    for (const a of list || []) {
      if (!a || typeof a !== 'object') continue;
      if (a.op) used.push(a.op);
      if (a.target && a.target.kind) used.push('target:' + a.target.kind);
      walk(a.then); walk(a.else); walk(a.actions);
      if (Array.isArray(a.options)) for (const o of a.options) walk(o && o.actions);
    }
  };
  for (const id of ids) {
    const d = api.__forgeDelta(unitId, id);
    for (const e of (d && d.fx) || []) walk(e.actions);
  }
  for (const op of ops) {
    if (used.indexOf(op) < 0) throw new Error('技能表里应当用到 op ' + op);
  }
  for (const k of kinds) {
    if (used.indexOf('target:' + k) < 0) throw new Error('技能表里应当用到 target ' + k);
  }
});
