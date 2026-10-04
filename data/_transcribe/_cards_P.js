/**
 * 音乐阵营（music）的 4 张超能力，没有令牌，作者 2026-10-04 口述。
 *
 *  降噪耳机 U415 是光环式 -1 攻击力 -1 生命（作者选读法 A）：来源一进场就把敌方全场
 *    的上限与当前生命压下去，来源离场后还活着的人把这一份还回来（auras.js 的 syncStatAuras）。
 *  和弦 U416 在手牌里生效：引擎在锦囊结算之后调用 applyInHandSpellWatchers（play.js），
 *    被这张锦囊点名的敌方单位各 -1 攻击力 -1 生命，不花费用，但会写 in-hand-trigger 日志。
 */

export const CARDS_P = [
  // 卡面：回旋曲：选择一名敌人：其 -2 攻击力 -2 生命；选择并移动一名队友；抽一张牌。
  {
    id: 'U413',
    name: '回旋曲',
    type: 'spell',
    spellKind: 'attack',
    cost: 1,
    faction: 'music',
    text: '选择一名敌人：其 -2 攻击力 -2 生命；选择并移动一名队友；抽一张牌。',
    actions: [
      { op: 'modifyStats', atk: -2, maxHp: -2, target: { kind: 'chosenEnemyTarget', allowKing: false, prompt: '选择一名敌人' } },
      { op: 'move', target: { kind: 'chosenOwnUnit', prompt: '选择一名队友' }, prompt: '把队友移到哪条线路' },
      { op: 'draw', amount: 1 },
    ],
  },

  // 卡面：超重低音：造成 3 点伤害；所有敌方单位 -2 攻击力 -2 生命。
  {
    id: 'U414',
    name: '超重低音',
    type: 'spell',
    spellKind: 'attack',
    cost: 1,
    faction: 'music',
    text: '造成 3 点伤害；所有敌方单位 -2 攻击力 -2 生命。',
    actions: [
      { op: 'damage', amount: 3, target: { kind: 'chosenEnemyTarget', prompt: '选择目标' } },
      { op: 'modifyStats', atk: -2, maxHp: -2, target: { kind: 'allEnemyUnits' } },
    ],
  },

  // 卡面：降噪耳机：在场：所有敌方单位 -1 攻击力 -1 生命。
  {
    id: 'U415',
    name: '降噪耳机',
    type: 'unit',
    cost: 1,
    atk: 2,
    hp: 3,
    faction: 'music',
    keywords: [],
    text: '在场：所有敌方单位 -1 攻击力 -1 生命。',
    auras: [
      { kind: 'buffAtk', amount: -1, to: 'allEnemies' },
      { kind: 'buffMaxHp', amount: -1, to: 'allEnemies' },
    ],
  },

  // 卡面：和弦：选择一名敌人：其 -1 攻击力 -1 生命。在手牌中：有敌方单位成为锦囊牌的目标时，使其 -1 攻击力 -1 生命。
  {
    id: 'U416',
    name: '和弦',
    type: 'spell',
    spellKind: 'attack',
    cost: 1,
    faction: 'music',
    inHandSpellTarget: { atk: -1, maxHp: -1 },
    text: '选择一名敌人：其 -1 攻击力 -1 生命。在手牌中：有敌方单位成为锦囊牌的目标时，使其 -1 攻击力 -1 生命。',
    actions: [
      { op: 'modifyStats', atk: -1, maxHp: -1, target: { kind: 'chosenEnemyTarget', allowKing: false, prompt: '选择一名敌人' } },
    ],
  },
];
