/**
 * 炼金阵营（alchemy）的超能力，作者 2026-10-07 口述（原文见 data/_transcribe/炼金阵营-规格.md）。
 *
 *  原料（U426~U429）不进牌库：开局每方一副 14 张的原料堆（金沙 x3、厄毒之尘 x3、
 *  陨铁 x4、硫磺 x4），每抽一张牌就抽一张原料。原料只能通过「炼药」消耗，
 *  直接当锦囊打出会被 play.js 拒绝；组合与计价见 factions.js 的 RAW_COMBOS 与 brew()。
 *
 *  令牌（U434~U444）同样 token:true，不会进牌库，也不会被超能力池抽到（池子过滤 token）。
 *  「事故」U444 带 autoUseOnAdd：加进手中的那一刻自动使用，然后结束当前出牌回合。
 */

export const CARDS_S = [
  // ---------- 原料（4 张） ----------
  {
    id: 'U426',
    name: '金沙',
    type: 'spell',
    spellKind: 'item',
    cost: 0,
    faction: 'alchemy',
    token: true,
    rawMaterial: true,
    text: '炼金原料。与手中其它原料一起炼药，按组合产出一张令牌。',
    actions: [],
  },
  {
    id: 'U427',
    name: '厄毒之尘',
    type: 'spell',
    spellKind: 'item',
    cost: 0,
    faction: 'alchemy',
    token: true,
    rawMaterial: true,
    text: '炼金原料。与手中其它原料一起炼药，按组合产出一张令牌。',
    actions: [],
  },
  {
    id: 'U428',
    name: '陨铁',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'alchemy',
    token: true,
    rawMaterial: true,
    text: '炼金原料。与手中其它原料一起炼药，按组合产出一张令牌。',
    actions: [],
  },
  {
    id: 'U429',
    name: '硫磺',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'alchemy',
    token: true,
    rawMaterial: true,
    text: '炼金原料。与手中其它原料一起炼药，按组合产出一张令牌。',
    actions: [],
  },

  // ---------- 超能力（4 张，可以被超能力池抽到） ----------
  // 卡面：巫毒娃娃 1 费 0 攻 2 血。锦囊免疫。每回合，友方国王首次受到的伤害改为由敌方国王承受。
  {
    id: 'U430',
    name: '巫毒娃娃',
    type: 'unit',
    cost: 1,
    atk: 0,
    hp: 2,
    faction: 'alchemy',
    keywords: ['spellImmune'],
    voodooDoll: true,
    text: '锦囊免疫。每回合，友方国王首次受到的伤害改为由敌方国王承受。',
    effects: [],
  },

  // 卡面：未收录粉尘 1 费。选择 2 张原料加入手牌，使其花费为 0。
  {
    id: 'U431',
    name: '未收录粉尘',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'alchemy',
    text: '选择 2 张原料加入手牌，使其花费为 0。',
    actions: [
      { op: 'addRawMaterials', amount: 2, side: 'controller', prompt: '选择一张原料' },
    ],
  },

  // 卡面：解禁 1 费。使友方国王获：「可在自己的单位回合打出超能力锦囊牌」。
  {
    id: 'U432',
    name: '解禁',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'alchemy',
    text: '使友方国王获：「可在自己的单位回合打出超能力锦囊牌」。',
    actions: [
      { op: 'unlockAlchemySpells', side: 'controller' },
    ],
  },

  // 卡面：炼金潮 1 费。本回合，友方打出非原料锦囊时，抽一张牌。
  {
    id: 'U433',
    name: '炼金潮',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'alchemy',
    text: '本回合，友方打出非原料锦囊时，抽一张牌。',
    actions: [
      { op: 'alchemyTide', side: 'controller' },
    ],
  },

  // ---------- 令牌（11 张） ----------
  // 卡面：玄剑 0 费。一名队友获得 +1 攻击 +2 血量，抽一张牌。
  {
    id: 'U434',
    name: '玄剑',
    type: 'spell',
    spellKind: 'item',
    cost: 0,
    faction: 'alchemy',
    token: true,
    text: '一名队友获得 +1 攻击 +2 血量，抽一张牌。',
    actions: [
      {
        op: 'compound',
        target: { kind: 'chosenOwnUnit', prompt: '选择一名队友' },
        actions: [
          { op: 'modifyStats', atk: 1, maxHp: 2, target: { kind: 'compoundTarget' } },
        ],
      },
      { op: 'draw', amount: 1 },
    ],
  },

  // 卡面：财富药水 0 费。友方当前费用 +3，若友方手牌数不大于 7，抽一张牌。
  {
    id: 'U435',
    name: '财富药水',
    type: 'spell',
    spellKind: 'item',
    cost: 0,
    faction: 'alchemy',
    token: true,
    text: '友方当前费用 +3，若友方手牌数不大于 7，抽一张牌。',
    actions: [
      { op: 'gainMana', amount: 3, side: 'controller' },
      {
        op: 'conditional',
        if: { compare: 'handCountLE', n: 7 },
        then: [{ op: 'draw', amount: 1 }],
      },
    ],
  },

  // 卡面：湮灭药水 2 费。消灭一名敌人。
  {
    id: 'U436',
    name: '湮灭药水',
    type: 'spell',
    spellKind: 'attack',
    cost: 2,
    faction: 'alchemy',
    token: true,
    text: '消灭一名敌人。',
    actions: [
      { op: 'destroy', target: { kind: 'chosenEnemyUnit', prompt: '选择一名敌人' } },
    ],
  },

  // 卡面：生命药水 0 费。友方国王回复 3 点血量。
  {
    id: 'U437',
    name: '生命药水',
    type: 'spell',
    spellKind: 'item',
    cost: 0,
    faction: 'alchemy',
    token: true,
    text: '友方国王回复 3 点血量。',
    actions: [
      { op: 'heal', amount: 3, target: { kind: 'ownKing' } },
    ],
  },

  // 卡面：棘刺之甲 1 费。一名队友获淬毒 1、荆棘 2 和 +1 生命。
  {
    id: 'U438',
    name: '棘刺之甲',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'alchemy',
    token: true,
    text: '一名队友获淬毒 1、荆棘 2 和 +1 生命。',
    actions: [
      {
        op: 'compound',
        target: { kind: 'chosenOwnUnit', prompt: '选择一名队友' },
        actions: [
          { op: 'grantKeyword', keyword: 'poison', x: 1, target: { kind: 'compoundTarget' } },
          { op: 'grantKeyword', keyword: 'thorns', x: 2, target: { kind: 'compoundTarget' } },
          { op: 'modifyStats', maxHp: 1, target: { kind: 'compoundTarget' } },
        ],
      },
    ],
  },

  // 卡面：高爆药水 1 费。对一名敌人造成 4 点伤害。
  {
    id: 'U439',
    name: '高爆药水',
    type: 'spell',
    spellKind: 'attack',
    cost: 1,
    faction: 'alchemy',
    token: true,
    text: '对一名敌人造成 4 点伤害。',
    actions: [
      { op: 'damage', amount: 4, target: { kind: 'chosenEnemyTarget', filter: { spellTargetable: true }, prompt: '选择敌方单位或敌方国王' } },
    ],
  },

  // 卡面：狂热药水 2 费。一个单位获得 +5 攻击，并令其受到 5 点伤害。
  {
    id: 'U440',
    name: '狂热药水',
    type: 'spell',
    spellKind: 'attack',
    cost: 2,
    faction: 'alchemy',
    token: true,
    text: '一个单位获得 +5 攻击，并令其受到 5 点伤害。',
    actions: [
      {
        op: 'compound',
        target: { kind: 'chosenAnyUnit', prompt: '选择一个单位' },
        actions: [
          { op: 'modifyStats', atk: 5, target: { kind: 'compoundTarget' } },
          { op: 'damage', amount: 5, target: { kind: 'compoundTarget' } },
        ],
      },
    ],
  },

  // 卡面：精致金甲 1 费。一名队友获得装甲 2，抽一张牌。
  {
    id: 'U441',
    name: '精致金甲',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'alchemy',
    token: true,
    text: '一名队友获得装甲 2，抽一张牌。',
    actions: [
      {
        op: 'compound',
        target: { kind: 'chosenOwnUnit', prompt: '选择一名队友' },
        actions: [
          { op: 'grantKeyword', keyword: 'armor', x: 2, target: { kind: 'compoundTarget' } },
        ],
      },
      { op: 'draw', amount: 1 },
    ],
  },

  // 卡面：毒雾药水 1 费。淬毒 1。对所有敌人造成一点伤害。
  {
    id: 'U442',
    name: '毒雾药水',
    type: 'spell',
    spellKind: 'attack',
    cost: 1,
    faction: 'alchemy',
    token: true,
    keywords: ['poison:1'],
    text: '淬毒 1。对所有敌人造成一点伤害。',
    actions: [
      { op: 'damage', amount: 1, target: { kind: 'allEnemyUnits' } },
    ],
  },

  // 卡面：毒爆药水 2 费。淬毒 2。造成 2 点伤害。
  {
    id: 'U443',
    name: '毒爆药水',
    type: 'spell',
    spellKind: 'attack',
    cost: 2,
    faction: 'alchemy',
    token: true,
    keywords: ['poison:2'],
    text: '淬毒 2。造成 2 点伤害。',
    actions: [
      { op: 'damage', amount: 2, target: { kind: 'chosenEnemyTarget', filter: { spellTargetable: true }, prompt: '选择敌方单位或敌方国王' } },
    ],
  },

  // 卡面：事故 0 费。对所有单位造成 3 点伤害。这张牌加入手中时：自动使用，然后结束当前出牌回合。
  {
    id: 'U444',
    name: '事故',
    type: 'spell',
    spellKind: 'attack',
    cost: 0,
    faction: 'alchemy',
    token: true,
    autoUseOnAdd: true,
    text: '对所有单位造成 3 点伤害。这张牌加入手中时：自动使用，然后结束当前出牌回合。',
    actions: [
      { op: 'damage', amount: 3, target: { kind: 'allUnits' } },
    ],
  },
];