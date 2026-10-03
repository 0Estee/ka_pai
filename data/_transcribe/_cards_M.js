/**
 * 第三批手绘卡  M 组（第六轮，作者 2026-10-03）
 *
 * 这一组带来两个新能力：
 *    `faction`：卡牌的阵营归属。带 faction 的牌**不进普通牌库**，
 *     只能通过阵营系统的「超能力抽取」获得（见 docs/规则书-v0.2.md 的裁决）。
 *    `delayedSummon`：下个大回合开始时再召唤。
 *
 * 词条 `combo`（组合）/ `nimble`（轻灵，旧卡面写「飞行」）/ `frenzy`（狂热）/
 * `spellImmune`（锦囊免疫）都是现成词条。
 *
 * 作者口径与问答见 data/_transcribe/超能力-规则与待确认.md。
 */

export const CARDS_M = [
  // 
  // 卡面：单位（人形）/「风神翼龙」/ 费用 4 / 攻击4 生命3
  //       词条行：组合、飞行（= 轻灵）
  //       作者 2026-10-03 补的数字：费用 4、攻击 4、生命 3
  // 
  { id: 'U397', name: '风神翼龙', type: 'unit', cost: 4, atk: 4, hp: 3, keywords: ['combo', 'nimble'], text: '' },

  // 
  // 卡面：攻击性锦囊（剑）/「下界之风」/ 费用 1 / 恶魔阵营超能力
  //       效果行：对敌方所有单位造成2点伤害
  //       作者 2026-10-03：这张牌**也会对敌方国王造成伤害**
  //       （规则书 D28「所有敌人」不含国王，所以国王那一下要单写一条）
  // 
  {
    id: 'U398',
    name: '下界之风',
    type: 'spell',
    spellKind: 'attack',
    cost: 1,
    faction: 'demon',
    text: '对敌方所有单位造成2点伤害，并对敌方国王造成2点伤害',
    actions: [
      { op: 'damage', amount: 2, target: { kind: 'allEnemyUnits' } },
      { op: 'damage', amount: 2, target: { kind: 'enemyKing' } },
    ],
  },

  // 
  // 卡面：道具性锦囊（方块）/「鲜血祭典」/ 费用 1 / 恶魔阵营超能力
  //       效果行：献祭一名队友,为国王回复与其 ⚔ 相等的 ♥
  //       作者 2026-10-03：回复量 = **被献祭单位的当前攻击力**，不超过国王血量上限
  //       （healKing 本来就被 kingMaxHp 卡住，见 damage.js）
  // 
  {
    id: 'U399',
    name: '鲜血祭典',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'demon',
    text: '献祭一名队友，为国王回复与其攻击力相等的生命',
    actions: [
      { op: 'sacrifice', target: { kind: 'chosenOwnUnit', excludeSource: true, prompt: '选择要献祭的队友' } },
      { op: 'heal', amount: { sacrificedAtk: true }, target: { kind: 'ownKing' } },
    ],
  },

  // 
  // 卡面：道具性锦囊（方块）/「召唤仪式」/ 费用 1 / 恶魔阵营超能力
  //       效果行（二选一）：在下回合召唤 恶魔虚影 ／ 国王扣除2♥:立即召唤
  //       作者 2026-10-03：「下回合」= **下个大回合开始时**召唤
  //       choose 的第 0 个选项必须是「不伤自己」的那个（AI 自动取第 0 项）
  // 
  {
    id: 'U400',
    name: '召唤仪式',
    type: 'spell',
    spellKind: 'item',
    cost: 1,
    faction: 'demon',
    text: '抉择:在下个大回合开始时召唤 恶魔虚影；或对自己的国王造成2点伤害，立即召唤',
    actions: [{
      op: 'choose',
      prompt: '召唤仪式:怎么召唤 恶魔虚影？',
      options: [
        { label: '下个大回合开始时召唤', actions: [{ op: 'delayedSummon', cardId: 'U402', delay: 1 }] },
        {
          label: '国王扣除2点生命，立即召唤',
          actions: [
            { op: 'damage', amount: 2, target: { kind: 'ownKing' } },
            { op: 'summon', cardId: 'U402' },
          ],
        },
      ],
    }],
  },

  // 
  // 卡面：单位（沙漏形阵营标志）/「死神」/ 费用 1 / 攻击2 生命2 / 恶魔阵营超能力
  //       效果行：献祭一名队友召唤:获得+1⚔+1♥,对自己的国王造成3点伤害,造成5点伤害
  //       作者 2026-10-03：死神的 2 2；「造成5点伤害」要**选一个敌方目标
  //       （可以是敌方国王）**；打出时**只能二选一**：发动一次献祭，或者不发动、
  //       直接打出、不触发任何效果。
  // 
  {
    id: 'U401',
    name: '死神',
    type: 'unit',
    cost: 1,
    atk: 2,
    hp: 2,
    keywords: [],
    faction: 'demon',
    text: '献祭一名队友:获得+1攻+1生命上限，对自己的国王造成3点伤害，对一个敌方目标造成5点伤害',
    effects: [{
      trigger: 'onPlay',
      actions: [{
        op: 'choose',
        prompt: '死神:要献祭一名队友吗？',
        options: [
          { label: '不发动，直接打出', actions: [] },
          {
            label: '献祭一名队友',
            actions: [
              { op: 'sacrifice', target: { kind: 'chosenOwnUnit', excludeSource: true, prompt: '选择要献祭的队友' } },
              { op: 'buffAtk', amount: 1, target: { kind: 'self' } },
              { op: 'buffMaxHp', amount: 1, target: { kind: 'self' } },
              { op: 'damage', amount: 3, target: { kind: 'ownKing' } },
              { op: 'damage', amount: 5, target: { kind: 'chosenEnemyTarget', prompt: '造成5点伤害的目标（可以是敌方国王）' } },
            ],
          },
        ],
      }],
    }],
  },

  // 
  // 卡面：令牌（沙漏形阵营标志 + 「令」字）/「恶魔虚影」/ 费用 3
  //       攻击力 1（作者 2026-10-03 补）、生命 4 / 词条行：狂热、锦囊免疫
  //       效果行：每献祭一名队友,便获+1⚔+1♥
  //       作者 2026-10-03：**在场时**每献祭一名友方单位，恶魔虚影获得 **+2 +1**
  //       （口述优先于卡面写的 +1/+1）；触发名 onAllySacrificed 由
  //       board.js 的 destroyUnit 在 reason === 'sacrifice' 时排给同侧单位。
  // 
  {
    id: 'U402',
    name: '恶魔虚影',
    type: 'unit',
    cost: 3,
    atk: 1,
    hp: 4,
    token: true,
    faction: 'demon',
    keywords: ['frenzy', 'spellImmune'],
    text: '狂热；锦囊免疫；每献祭一名己方单位，获得+2攻+1生命上限',
    effects: [{
      trigger: 'onAllySacrificed',
      actions: [
        { op: 'buffAtk', amount: 2, target: { kind: 'self' } },
        { op: 'buffMaxHp', amount: 1, target: { kind: 'self' } },
      ],
    }],
  },
];
