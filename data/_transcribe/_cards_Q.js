/**
 * 科学阵营（science）的 4 张非令牌超能力 + 1 张令牌（新兴研究 U421），作者 2026-10-04 口述。
 *
 *  本批新加的 op：repeatLastSpell（克隆重复上一张锦囊，带防递归）、randomOne（随机二选一）、
 *    permanentHandCost（友方手牌永久 -1 花费）、delayedDraw（下个回合开始抽牌）。
 *  新兴研究 U421 用 attachKingEffect 挂国王被动，打出的友方单位以 payloadUnit 作为载荷。
 */

export const CARDS_Q = [
  // 卡面：反应堆：组合。回合开始：友方 +1 费用。被消灭：对这条线上的所有敌方单位造成 4 点伤害。
  {
    id: 'U417',
    name: '反应堆',
    type: 'unit',
    cost: 1,
    atk: 0,
    hp: 1,
    faction: 'science',
    keywords: ['combo'],
    text: '组合。回合开始：友方 +1 费用。被消灭：对这条线上的所有敌方单位造成 4 点伤害。',
    effects: [
      { trigger: 'onTurnStart', actions: [{ op: 'gainMana', amount: 1 }] },
      { trigger: 'onDeath', actions: [{ op: 'damage', amount: 4, target: { kind: 'allEnemyUnitsInLane' } }] },
    ],
  },

  // 卡面：博士：锦囊免疫。回合开始：抽一张牌。
  {
    id: 'U418',
    name: '博士',
    type: 'unit',
    cost: 1,
    atk: 2,
    hp: 1,
    faction: 'science',
    keywords: ['spellImmune'],
    text: '锦囊免疫。回合开始：抽一张牌。',
    effects: [
      { trigger: 'onTurnStart', actions: [{ op: 'draw', amount: 1 }] },
    ],
  },

  // 卡面：克隆：触发你使用的上一张锦囊牌的效果；抽一张牌。
  {
    id: 'U419',
    name: '克隆',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'science',
    text: '触发你使用的上一张锦囊牌的效果；抽一张牌。',
    actions: [
      { op: 'repeatLastSpell' },
      { op: 'draw', amount: 1 },
    ],
  },

  // 卡面：前沿科技：召唤一张「新兴研究」加入手牌；下个回合开始时抽一张牌。
  {
    id: 'U420',
    name: '前沿科技',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'science',
    text: '召唤一张「新兴研究」加入手牌；下个回合开始时抽一张牌。',
    actions: [
      { op: 'summonToHand', cardId: 'U421' },
      { op: 'delayedDraw', n: 1, delay: 1 },
    ],
  },

  // 卡面：新兴研究：友方手中卡牌花费 -1。友方单位打出时：随机使其获得 +1 攻击力或 +1 生命。
  {
    id: 'U421',
    name: '新兴研究',
    type: 'spell',
    spellKind: 'item',
    cost: 4,
    faction: 'science',
    token: true,
    text: '友方手中卡牌花费 -1。友方单位打出时：随机使其获得 +1 攻击力或 +1 生命。',
    actions: [
      { op: 'permanentHandCost', amount: -1, side: 'controller' },
      {
        op: 'attachKingEffect',
        side: 'controller',
        effects: [
          {
            trigger: 'onAllyPlayed',
            actions: [
              {
                op: 'randomOne',
                options: [
                  { actions: [{ op: 'buffAtk', amount: 1, target: { kind: 'payloadUnit' } }] },
                  { actions: [{ op: 'buffMaxHp', amount: 1, target: { kind: 'payloadUnit' } }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
];
