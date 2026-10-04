/**
 * 神佑阵营（divine）的 4 张超能力，没有令牌，作者 2026-10-04 口述。
 *
 *  神使 U422 靠 kingGuard 替国王挨打：damage.js 的 findKingGuard 挑生命最低的那张顶上。
 *  装甲 +1 用 buffKeywordX（把 armor 的 X 加 1）；祈祷用 kingDamageReduce（本回合有效）。
 *  永久设为 0 用 lockAtk：之后任何加成都不再提升攻击力（stats.js 的 buffAtk 会直接跳过）。
 */

export const CARDS_R = [
  // 卡面：神使：装甲 1。替友方国王承受伤害。回合开始：获得 +1 装甲。
  {
    id: 'U422',
    name: '神使',
    type: 'unit',
    cost: 1,
    atk: 1,
    hp: 4,
    faction: 'divine',
    keywords: ['armor:1'],
    kingGuard: true,
    text: '装甲 1。替友方国王承受伤害。回合开始：获得 +1 装甲。',
    effects: [
      { trigger: 'onTurnStart', actions: [{ op: 'buffKeywordX', keyword: 'armor', x: 1, target: { kind: 'self' } }] },
    ],
  },

  // 卡面：祈祷：友方国王本回合每次受伤 -2；为友方国王回复 3 点生命。
  {
    id: 'U423',
    name: '祈祷',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'divine',
    text: '友方国王本回合每次受伤 -2；为友方国王回复 3 点生命。',
    actions: [
      { op: 'kingDamageReduce', amount: 2, side: 'controller' },
      { op: 'heal', amount: 3, target: { kind: 'ownKing' } },
    ],
  },

  // 卡面：诅咒：选择一名敌人：将其攻击力永久设为 0（本局内无法再被加成提升）；抽一张牌。
  {
    id: 'U424',
    name: '诅咒',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'divine',
    text: '选择一名敌人：将其攻击力永久设为 0（本局内无法再被加成提升）；抽一张牌。',
    actions: [
      { op: 'lockAtk', value: 0, target: { kind: 'chosenEnemyUnit', prompt: '选择一名敌人' } },
      { op: 'draw', amount: 1 },
    ],
  },

  // 卡面：神罚：将所有攻击力大于等于 3 的敌人的攻击力永久设为 0。
  {
    id: 'U425',
    name: '神罚',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'divine',
    text: '将所有攻击力大于等于 3 的敌人的攻击力永久设为 0。',
    actions: [
      { op: 'lockAtk', value: 0, target: { kind: 'allEnemyUnits', filter: { minAtk: 3 } } },
    ],
  },
];
