/**
 * 第三批手绘卡  N 组（第七轮，作者 2026-10-04）
 *
 * 这一组是第二个阵营「上帝」的 4 张超能力 + 1 张令牌：
 *   传教 / 圣经 / 庇佑 / 祝福 + 令牌「上帝的信徒」。
 * 带 `faction: 'god'` 的牌不进普通牌库，只能靠超能力抽取拿到
 * （见 docs/规则书-v0.2.md 的裁决 D72 / D73 与 engine/src/factions.js）。
 *
 * 这一组同时给引擎带来一个能力：召唤时由玩家在场上选落点
 * （`summon` / `delayedSummon` 不写 lane 时挂起问人，见 actions.js 的 askSummonCell）。
 */

export const CARDS_N = [
  //
  // 卡面：道具性锦囊（方块）/「传教」/ 费用 1 / 上帝阵营超能力
  //       效果行：在场上召唤一个上帝的信徒
  //       作者 2026-10-04：召唤时直接在场上选择一个位置放下
  //
  {
    id: 'U403',
    name: '传教',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'god',
    text: '在场上召唤一个 上帝的信徒（选择一个位置）',
    actions: [
      { op: 'summon', cardId: 'U407', prompt: '选择「上帝的信徒」的落点' },
    ],
  },

  //
  // 卡面：道具性锦囊（方块）/「圣经」/ 费用 1 / 上帝阵营超能力
  //       效果行：一名队友本回合获得无敌并+2生命，抽一张牌
  //
  {
    id: 'U404',
    name: '圣经',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'god',
    text: '一名队友本回合获得无敌并+2生命，抽一张牌',
    actions: [
      {
        op: 'grantKeywordBuff',
        keyword: 'invincible',
        untilTurnEnd: true,
        maxHp: 2,
        target: {
          kind: 'chosenOwnUnit',
          filter: { spellTargetable: true },
          prompt: '选择一名队友（本回合无敌，+2生命）',
        },
      },
      { op: 'draw', amount: 1 },
    ],
  },

  //
  // 卡面：道具性锦囊（方块）/「庇佑」/ 费用 1 / 上帝阵营超能力
  //       效果行：所有友方单位和友方国王本回合获无敌，抽一张牌
  //       国王不是单位 -> 走新 op kingInvincible（标记记在玩家对象上，见 damage.js）
  //
  {
    id: 'U405',
    name: '庇佑',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'god',
    text: '所有友方单位和友方国王本回合获得无敌，抽一张牌',
    actions: [
      { op: 'grantKeyword', keyword: 'invincible', untilTurnEnd: true, target: { kind: 'allOwnUnits' } },
      { op: 'kingInvincible' },
      { op: 'draw', amount: 1 },
    ],
  },

  //
  // 卡面：道具性锦囊（方块）/「祝福」/ 费用 1 / 上帝阵营超能力
  //       效果行：使一名队友获得祝福1，抽一张牌
  //
  {
    id: 'U406',
    name: '祝福',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'god',
    text: '使一名队友获得祝福1，抽一张牌',
    actions: [
      {
        op: 'grantKeyword',
        keyword: 'blessing',
        x: 1,
        target: {
          kind: 'chosenOwnUnit',
          filter: { spellTargetable: true },
          prompt: '选择一名队友（祝福1）',
        },
      },
      { op: 'draw', amount: 1 },
    ],
  },

  //
  // 卡面：单位（人形）/「上帝的信徒」/ 费用 3 / 攻击2 生命4 / 上帝阵营超能力令牌
  //       效果行：回合开始:所有队友获得+2生命，为友方国王回复2点血量
  //
  {
    id: 'U407',
    name: '上帝的信徒',
    type: 'unit',
    cost: 3,
    atk: 2,
    hp: 4,
    token: true,
    faction: 'god',
    keywords: [],
    text: '回合开始:所有队友获得+2生命，为友方国王回复2点生命',
    effects: [{
      trigger: 'onTurnStart',
      actions: [
        { op: 'buffMaxHp', amount: 2, target: { kind: 'allOwnUnits' } },
        { op: 'heal', amount: 2, target: { kind: 'ownKing' } },
      ],
    }],
  },
];