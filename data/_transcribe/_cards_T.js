/**
 * 三阵营（炼狱 inferno / 极寒 frost / 罪恶 sin）的超能力，作者 2026-10-10 口述。
 *
 * 原文见 data/_transcribe/三阵营-规格.md，逐张 DSL 映射见 data/_transcribe/三阵营-实现计划.md。
 *
 * 令牌（怒火 U449 / 余温 U450 / 冰轮狂舞 U454 / 寒星追 U455 / 恶意 U459）写 token:true：
 * 不进牌库、也不会被超能力池抽到（池子过滤 token），只能被卡面里的「召唤」加进手牌。
 *
 * 卡名里的间隔号用 DOT 常量拼出来（直接写成字面量会被工具传输吞掉）。
 */

const DOT = String.fromCharCode(0xB7);

export const CARDS_T = [
  // ==================== 炼狱 inferno ====================
  {
    id: 'U445',
    name: '燥热难忍',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'inferno',
    text: '一名队友获得狂热并+2生命，召唤一张怒火。',
    actions: [
      {
        op: 'compound',
        target: { kind: 'chosenOwnUnit', prompt: '选择一名队友' },
        actions: [
          { op: 'grantKeyword', keyword: 'frenzy', target: { kind: 'compoundTarget' } },
          { op: 'modifyStats', maxHp: 2, target: { kind: 'compoundTarget' } },
        ],
      },
      { op: 'summonToHand', cardId: 'U449' },
    ],
  },
  {
    id: 'U446',
    name: '活火山',
    type: 'unit',
    cost: 1,
    atk: 1,
    hp: 4,
    faction: 'inferno',
    keywords: ['doubleStrike'],
    // 卡级旗标：出手时对全场敌方单位与敌方国王各造成一次攻击力伤害
    // （combat.js 的 collectAttackEvents 读它）
    sweepAllEnemies: true,
    text: '双重打击。同时攻击所有敌人和敌方国王。',
  },
  {
    id: 'U447',
    name: '黑曜石',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'inferno',
    text: '一名队友获得+3生命，并在每回合开始时+1攻击力，抽一张牌。',
    actions: [
      {
        op: 'compound',
        target: { kind: 'chosenOwnUnit', prompt: '选择一名队友' },
        actions: [
          { op: 'modifyStats', maxHp: 3, target: { kind: 'compoundTarget' } },
          {
            op: 'attachEffect',
            target: { kind: 'compoundTarget' },
            effects: [
              {
                trigger: 'onTurnStart',
                actions: [{ op: 'modifyStats', atk: 1, target: { kind: 'self' } }],
              },
            ],
          },
        ],
      },
      { op: 'draw', amount: 1 },
    ],
  },
  {
    id: 'U448',
    name: '炽热岩浆',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'inferno',
    text: '一名队友获得+3攻击力+1生命，召唤一张余温。',
    actions: [
      {
        op: 'compound',
        target: { kind: 'chosenOwnUnit', prompt: '选择一名队友' },
        actions: [
          { op: 'modifyStats', atk: 3, maxHp: 1, target: { kind: 'compoundTarget' } },
        ],
      },
      { op: 'summonToHand', cardId: 'U450' },
    ],
  },
  {
    id: 'U449',
    name: '怒火',
    type: 'spell',
    spellKind: 'attack',
    cost: 1,
    faction: 'inferno',
    token: true,
    text: '造成3点伤害。',
    actions: [
      { op: 'damage', amount: 3, target: { kind: 'chosenEnemyTarget' } },
    ],
  },
  {
    id: 'U450',
    name: '余温',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'inferno',
    token: true,
    text: '移动一名队友，使其获得溅射2。',
    actions: [
      {
        op: 'compound',
        target: { kind: 'chosenOwnUnit', prompt: '选择一名队友' },
        actions: [
          { op: 'move', target: { kind: 'compoundTarget' } },
          { op: 'grantKeyword', keyword: 'splash', x: 2, target: { kind: 'compoundTarget' } },
        ],
      },
    ],
  },

  // ==================== 极寒 frost ====================
  {
    id: 'U451',
    name: '寒星' + DOT + '霜',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'frost',
    text: '冻结一名敌人，使其获得-2攻击力，召唤一张寒星' + DOT + '追。',
    actions: [
      {
        op: 'compound',
        target: { kind: 'chosenEnemyUnit', prompt: '选择一名敌人' },
        actions: [
          { op: 'freeze', target: { kind: 'compoundTarget' } },
          { op: 'modifyStats', atk: -2, target: { kind: 'compoundTarget' } },
        ],
      },
      { op: 'summonToHand', cardId: 'U455' },
    ],
  },
  {
    id: 'U452',
    name: '冰刃出击',
    type: 'spell',
    spellKind: 'attack',
    cost: 1,
    faction: 'frost',
    text: '选择两条相邻的线路，冻结那里的所有敌人，并对其造成2点伤害。',
    actions: [
      { op: 'chooseLanes', count: 2, adjacent: true, prompt: '选择两条相邻的线路' },
      { op: 'freeze', target: { kind: 'chosenLanesEnemyUnits' } },
      { op: 'damage', amount: 2, target: { kind: 'chosenLanesEnemyUnits' } },
    ],
  },
  {
    id: 'U453',
    name: '冰轮' + DOT + '旋舞',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'frost',
    text: '冻结一条线上的敌人，召唤一张冰轮' + DOT + '狂舞，抽一张牌。',
    actions: [
      { op: 'chooseLanes', count: 1, prompt: '选择一条线路' },
      { op: 'freeze', target: { kind: 'chosenLanesEnemyUnits' } },
      { op: 'summonToHand', cardId: 'U454' },
      { op: 'draw', amount: 1 },
    ],
  },
  {
    id: 'U454',
    name: '冰轮' + DOT + '狂舞',
    type: 'spell',
    spellKind: 'attack',
    cost: 1,
    faction: 'frost',
    token: true,
    // 锦囊不消费词条：这里的「溅射2」只作卡面标记（实际命中范围由下面的选择器决定）
    keywords: ['splash:2'],
    text: '溅射2。对所有被冻结的敌人造成2点伤害。',
    actions: [
      { op: 'damage', amount: 2, target: { kind: 'allFrozenEnemyUnits' } },
    ],
  },
  {
    id: 'U455',
    name: '寒星' + DOT + '追',
    type: 'spell',
    spellKind: 'attack',
    cost: 1,
    faction: 'frost',
    token: true,
    text: '对所有被冻结的敌人造成4点伤害，解除所有单位的冻结效果。',
    actions: [
      { op: 'damage', amount: 4, target: { kind: 'allFrozenEnemyUnits' } },
      { op: 'clearFreeze' },
    ],
  },
  {
    id: 'U456',
    name: '雪人',
    type: 'unit',
    cost: 1,
    atk: 1,
    hp: 3,
    faction: 'frost',
    keywords: ['fuse'],
    text: '有敌人被冻结时:获得+2攻击力+1生命。融合进化:冻结1个敌方单位。',
    effects: [
      {
        trigger: 'onEnemyFrozen',
        actions: [{ op: 'modifyStats', atk: 2, maxHp: 1, target: { kind: 'self' } }],
      },
      {
        trigger: 'onPlay',
        when: 'fused',
        actions: [{ op: 'freeze', target: { kind: 'chosenEnemyUnit', prompt: '冻结一个敌方单位' } }],
      },
    ],
  },

  // ==================== 罪恶 sin ====================
  {
    id: 'U457',
    name: '色欲',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'sin',
    text: '一名队友获得捕猎和「攻击时:对敌方国王造成等同于本单位攻击力的伤害」。',
    actions: [
      {
        op: 'compound',
        target: { kind: 'chosenOwnUnit', prompt: '选择一名队友' },
        actions: [
          { op: 'grantKeyword', keyword: 'hunt', target: { kind: 'compoundTarget' } },
          {
            op: 'attachEffect',
            target: { kind: 'compoundTarget' },
            effects: [
              {
                trigger: 'onAttack',
                actions: [
                  { op: 'damage', amount: { perSelfAtk: 1 }, target: { kind: 'enemyKing' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'U458',
    name: '妒忌',
    type: 'spell',
    spellKind: 'attack',
    cost: 1,
    faction: 'sin',
    text: '对敌方1个攻击力最高的单位造成5点伤害，召唤一张恶意。',
    actions: [
      { op: 'damage', amount: 5, target: { kind: 'highestAtkEnemyUnit' } },
      { op: 'summonToHand', cardId: 'U459' },
    ],
  },
  {
    id: 'U459',
    name: '恶意',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'sin',
    token: true,
    text: '随机弃置敌方一张牌，将那张卡牌的复制加入手中，抽一张牌。',
    actions: [
      { op: 'stealRandomHand' },
      { op: 'draw', amount: 1 },
    ],
  },
  {
    id: 'U460',
    name: '暴食',
    type: 'spell',
    spellKind: 'attack',
    cost: 1,
    faction: 'sin',
    text: '消灭一名生命最低的敌人，友方国王回复5点生命，抽一张牌。',
    actions: [
      { op: 'destroy', target: { kind: 'lowestHpEnemyUnit' }, reason: 'spell' },
      { op: 'heal', amount: 5, target: { kind: 'ownKing' } },
      { op: 'draw', amount: 1 },
    ],
  },
  {
    id: 'U461',
    name: '贪婪',
    type: 'unit',
    cost: 1,
    atk: 3,
    hp: 2,
    faction: 'sin',
    keywords: ['hunt', 'combo'],
    text: '捕猎 组合。被消灭:友方国王回复4点生命。',
    effects: [
      { trigger: 'onDeath', actions: [{ op: 'heal', amount: 4, target: { kind: 'ownKing' } }] },
    ],
  },
];