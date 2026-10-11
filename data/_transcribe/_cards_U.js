/**
 * 派对阵营（party）的超能力，作者 2026-10-11 口述。
 *
 * 原文见 data/_transcribe/派对与炎帝-规格.md。
 * 四张非令牌超能力（小丑 U462 / 惊喜 U463 / 爆炸水果蛋糕 U464 / 杂技演员 U465）
 * 进超能力池；令牌（气球 U466）写 token:true，不进牌库、也不会被超能力池抽到，
 * 只能被「被消灭:召唤一张气球」这类卡面效果加进手里。
 */

export const CARDS_U = [
  {
    id: 'U462',
    name: '小丑',
    type: 'unit',
    cost: 1,
    atk: 1,
    hp: 2,
    faction: 'party',
    // 卡面原文：打出:所有单位额外攻击一次，立即进入下个回合
    // 「所有单位」按裁决 D29 的口径 = 场上双方（含敌方）；endTurnNow 把本回合
    // 剩下的阶段跑完（含开战）再进入下一回合，见 engine/src/turns.js。
    text: '打出:所有单位额外攻击一次，立即进入下个回合。',
    effects: [
      {
        trigger: 'onPlay',
        actions: [
          { op: 'extraAttack', target: { kind: 'allUnits' } },
          { op: 'endTurnNow' },
        ],
      },
    ],
  },
  {
    id: 'U463',
    name: '惊喜',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'party',
    text: '召唤一张随机的令牌，使其费用-1，友方国王回复3点生命。',
    actions: [
      { op: 'summonRandomToken', modify: { costDelta: -1 } },
      { op: 'heal', amount: 3, target: { kind: 'ownKing' } },
    ],
  },
  {
    id: 'U464',
    name: '爆炸水果蛋糕',
    type: 'spell',
    spellKind: 'attack',
    cost: 1,
    faction: 'party',
    text: '对一名敌人造成6点伤害，敌方抽一张牌。',
    actions: [
      { op: 'damage', amount: 6, target: { kind: 'chosenEnemyTarget' } },
      { op: 'draw', amount: 1, side: 'opponent' },
    ],
  },
  {
    id: 'U465',
    name: '杂技演员',
    type: 'unit',
    cost: 1,
    atk: 1,
    hp: 4,
    faction: 'party',
    text: '受到伤害:抽一张牌。被消灭:召唤一张气球。',
    effects: [
      { trigger: 'onDamaged', actions: [{ op: 'draw', amount: 1 }] },
      // 召唤落点不写死：走 ctx.chosenLane（= 它死时所在的那条线），
      // 也就是气球落在原地那条线的前排，被占就由 summonToken 就近找格。
      { trigger: 'onDeath', actions: [{ op: 'summon', cardId: 'U466' }] },
    ],
  },
  {
    id: 'U466',
    name: '气球',
    type: 'unit',
    cost: 2,
    atk: 0,
    hp: 1,
    faction: 'party',
    token: true,
    keywords: ['combo'],
    text: '组合。被消灭:对这条线上的所有敌人和敌方国王造成3点伤害。',
    effects: [
      {
        trigger: 'onDeath',
        actions: [
          { op: 'damage', amount: 3, target: { kind: 'allEnemyUnitsInLane' } },
          { op: 'damage', amount: 3, target: { kind: 'enemyKing' } },
        ],
      },
    ],
  },
];
