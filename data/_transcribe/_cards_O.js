/**
 * 剑道阵营（sword）的 4 张非令牌超能力 + 1 张令牌（连斩 U410），作者 2026-10-04 口述。
 *
 *  卡牌 id / 名称 / 费用 / 效果按作者原文，出处见 data/_transcribe/四大阵营-规格.md。
 *  带 faction 的卡不进普通牌库，只在开局与国王血量跌破 15 / 9 / 3 时由引擎抽取。
 *  连斩靠 perUseCost 让花费随本局使用次数上涨，见 engine/src/play.js 的 costOf。
 */

export const CARDS_O = [
  // 卡面：一式·刀客：选择一名队友：使其获得穿透 2 并 +1 攻击力。
  {
    id: 'U408',
    name: '一式·刀客',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'sword',
    text: '选择一名队友：使其获得穿透 2 并 +1 攻击力。',
    actions: [
      { op: 'grantKeywordBuff', keyword: 'pierce', x: 2, atk: 1, target: { kind: 'chosenOwnUnit', prompt: '选择一名队友' } },
    ],
  },

  // 卡面：回刃：召唤一张「连斩」加入手牌，并为友方国王回复 1 点生命。
  {
    id: 'U409',
    name: '回刃',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'sword',
    text: '召唤一张「连斩」加入手牌，并为友方国王回复 1 点生命。',
    actions: [
      { op: 'summonToHand', cardId: 'U410' },
      { op: 'heal', amount: 1, target: { kind: 'ownKing' } },
    ],
  },

  // 卡面：连斩：造成 2 点伤害，并召唤一张「回刃」加入手牌。本局友方每使用过一张「连斩」，这张牌的花费 +1。
  {
    id: 'U410',
    name: '连斩',
    type: 'spell',
    spellKind: 'attack',
    cost: 0,
    faction: 'sword',
    token: true,
    perUseCost: 1,
    text: '造成 2 点伤害，并召唤一张「回刃」加入手牌。本局友方每使用过一张「连斩」，这张牌的花费 +1。',
    actions: [
      { op: 'damage', amount: 2, target: { kind: 'chosenEnemyTarget', prompt: '「连斩」要打谁？' } },
      { op: 'summonToHand', cardId: 'U409' },
    ],
  },

  // 卡面：二式·剑心：选择一名队友：其攻击力设为 4，并额外攻击一次；抽一张牌。
  {
    id: 'U411',
    name: '二式·剑心',
    type: 'spell',
    spellKind: 'attack',
    cost: 1,
    faction: 'sword',
    text: '选择一名队友：其攻击力设为 4，并额外攻击一次；抽一张牌。',
    actions: [
      {
        op: 'compound',
        target: { kind: 'chosenOwnUnit', prompt: '选择一名队友' },
        actions: [
          { op: 'setStats', atk: 4, target: { kind: 'compoundTarget' } },
          { op: 'extraAttack', target: { kind: 'compoundTarget' } },
        ],
      },
      { op: 'draw', amount: 1 },
    ],
  },

  // 卡面：终式·万剑归宗：对所有敌人造成等于场上敌方单位数量的伤害；对敌方国王造成等于场上友方单位数量的伤害；抽一张牌。
  {
    id: 'U412',
    name: '终式·万剑归宗',
    type: 'spell',
    spellKind: 'attack',
    cost: 1,
    faction: 'sword',
    text: '对所有敌人造成等于场上敌方单位数量的伤害；对敌方国王造成等于场上友方单位数量的伤害；抽一张牌。',
    actions: [
      { op: 'damage', amount: { perEnemyUnit: 1 }, target: { kind: 'allEnemyUnits' } },
      { op: 'damage', amount: { perOwnUnit: 1 }, target: { kind: 'enemyKing' } },
      { op: 'draw', amount: 1 },
    ],
  },
];
