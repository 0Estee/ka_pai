/**
 * 炎帝阵营（flame）的超能力与异火，作者 2026-10-11 口述。
 *
 * 原文（作者 2026-10-11 口述）未随仓库提供，本文件即当前唯一记录。
 *   · 五种异火（U467~U471）写 `flame: true`：都是**令牌**，只进异火堆，不进牌库；
 *     而且**只能靠超能力的效果获得**（作者裁定②）——没有「抽牌顺便抽异火」的钩子。
 *   · 焰分噬浪尺 U472 / 大天造化掌 U473 / 焚决 U474 / 天火三玄变 U475 是非令牌超能力，
 *     进超能力池（开局抽 1 张、国王过阈值再抽）。
 *   · 六合游身尺 U476 / 佛怒火莲 U477 是令牌超能力：不进牌库、也不进抽取池。
 */

export const CARDS_V = [
  // 卡面：陨落心炎 1 费 攻击型锦囊（令牌/异火）。一名敌人获得-1攻击力-1生命，一名队友获得+1攻击力+1生命。
  {
    "id": "U467",
    "name": "陨落心炎",
    "type": "spell",
    "spellKind": "attack",
    "cost": 1,
    "faction": "flame",
    "token": true,
    "flame": true,
    "text": "一名敌人获得-1攻击力-1生命，一名队友获得+1攻击力+1生命。",
    "actions": [
      {
        "op": "compound",
        "target": {
          "kind": "chosenEnemyUnit",
          "prompt": "选择一名敌人"
        },
        "actions": [
          {
            "op": "buffAtk",
            "amount": -1,
            "target": {
              "kind": "compoundTarget"
            }
          },
          {
            "op": "buffMaxHp",
            "amount": -1,
            "target": {
              "kind": "compoundTarget"
            }
          }
        ]
      },
      {
        "op": "compound",
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择一名队友"
        },
        "actions": [
          {
            "op": "buffAtk",
            "amount": 1,
            "target": {
              "kind": "compoundTarget"
            }
          },
          {
            "op": "buffMaxHp",
            "amount": 1,
            "target": {
              "kind": "compoundTarget"
            }
          }
        ]
      }
    ]
  },
  // 卡面：骨灵冷火 2 费 道具型锦囊（令牌/异火）。冻结一名敌人，封印其异能。
  {
    "id": "U468",
    "name": "骨灵冷火",
    "type": "spell",
    "spellKind": "item",
    "cost": 2,
    "faction": "flame",
    "token": true,
    "flame": true,
    "text": "冻结一名敌人，封印其异能。",
    "actions": [
      {
        "op": "compound",
        "target": {
          "kind": "chosenEnemyUnit",
          "prompt": "选择一名敌人"
        },
        "actions": [
          {
            "op": "freeze",
            "target": {
              "kind": "compoundTarget"
            }
          },
          {
            "op": "seal",
            "target": {
              "kind": "compoundTarget"
            }
          }
        ]
      }
    ]
  },
  // 卡面：净莲妖火 3 费 道具型锦囊（令牌/异火）。友方国王下次受到的伤害为0，友方回复3点生命。
  {
    "id": "U469",
    "name": "净莲妖火",
    "type": "spell",
    "spellKind": "item",
    "cost": 3,
    "faction": "flame",
    "token": true,
    "flame": true,
    "text": "友方国王下次受到的伤害为0，友方回复3点生命。",
    "actions": [
      {
        "op": "kingShield",
        "side": "controller"
      },
      {
        "op": "heal",
        "amount": 3,
        "target": {
          "kind": "ownKing"
        }
      }
    ]
  },
  // 卡面：生灵之焱 3 费 道具型锦囊（令牌/异火）。陷阱：友方国王受到致命伤害时，免除这次伤害，友方国王回复3点生命，选择并弃置友方的一张手牌。
  {
    "id": "U470",
    "name": "生灵之焱",
    "type": "spell",
    "spellKind": "item",
    "cost": 3,
    "faction": "flame",
    "token": true,
    "flame": true,
    "keywords": [
      "trap"
    ],
    "kingLethal": true,
    "text": "陷阱：友方国王受到致命伤害时，免除这次伤害，友方国王回复3点生命，选择并弃置友方的一张手牌。",
    "actions": [
      {
        "op": "heal",
        "amount": 3,
        "target": {
          "kind": "ownKing"
        }
      },
      {
        "op": "discard",
        "amount": 1,
        "side": "controller",
        "prompt": "选择要弃置的手牌"
      }
    ]
  },
  // 卡面：三千焱炎火 1 费 攻击型锦囊（令牌/异火）。一名队友本回合获得无敌。
  {
    "id": "U471",
    "name": "三千焱炎火",
    "type": "spell",
    "spellKind": "attack",
    "cost": 1,
    "faction": "flame",
    "token": true,
    "flame": true,
    "text": "一名队友本回合获得无敌。",
    "actions": [
      {
        "op": "grantKeyword",
        "keyword": "invincible",
        "untilTurnEnd": true,
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择一名队友"
        }
      }
    ]
  },
  // 卡面：焰分噬浪尺 1 费 攻击型锦囊。灼烧1；对两条相邻线上的敌人造成2点伤害，召唤一张六合游身尺。
  {
    "id": "U472",
    "name": "焰分噬浪尺",
    "type": "spell",
    "spellKind": "attack",
    "cost": 1,
    "faction": "flame",
    "keywords": [
      "burn:1"
    ],
    "text": "灼烧1。对两条相邻线上的敌人造成2点伤害，召唤一张六合游身尺。",
    "actions": [
      {
        "op": "chooseLanes",
        "count": 2,
        "adjacent": true,
        "prompt": "选择两条相邻的线路"
      },
      {
        "op": "damage",
        "amount": 2,
        "target": {
          "kind": "chosenLanesEnemyUnits"
        }
      },
      {
        "op": "summonToHand",
        "cardId": "U476",
        "count": 1
      }
    ]
  },
  // 卡面：大天造化掌 1 费 攻击型锦囊。抉择：对所有敌人和敌方国王造成3点伤害，下回合友方费用-3；或选择2个词条，一名队友获得它们，X=2（不可选无敌或祝福X）。
  {
    "id": "U473",
    "name": "大天造化掌",
    "type": "spell",
    "spellKind": "attack",
    "cost": 1,
    "faction": "flame",
    "text": "抉择：对所有敌人和敌方国王造成3点伤害，下回合友方费用-3；或选择2个词条，一名队友获得它们，X=2（不可选无敌或祝福X）。",
    "actions": [
      {
        "op": "choose",
        "prompt": "抉择",
        "options": [
          {
            "label": "对所有敌人和敌方国王造成3点伤害，下回合友方费用-3",
            "actions": [
              {
                "op": "damage",
                "amount": 3,
                "target": {
                  "kind": "allEnemyUnits"
                }
              },
              {
                "op": "damage",
                "amount": 3,
                "target": {
                  "kind": "enemyKing"
                }
              },
              {
                "op": "taxMana",
                "side": "controller",
                "amount": 3
              }
            ]
          },
          {
            "label": "选择2个词条给一名队友（X=2）",
            "actions": [
              {
                "op": "chooseKeywords",
                "count": 2,
                "x": 2,
                "exclude": [
                  "invincible",
                  "blessing"
                ],
                "target": {
                  "kind": "chosenOwnUnit",
                  "prompt": "选择一名队友"
                }
              }
            ]
          }
        ]
      }
    ]
  },
  // 卡面：焚决 1 费 道具型锦囊。使友方国王获得「有单位被消灭时，抽一张异火」。
  {
    "id": "U474",
    "name": "焚决",
    "type": "spell",
    "spellKind": "item",
    "cost": 1,
    "faction": "flame",
    "text": "使友方国王获得「有单位被消灭时，抽一张异火」。",
    "actions": [
      {
        "op": "attachKingEffect",
        "side": "controller",
        "effects": [
          {
            "trigger": "onAnyUnitDestroyed",
            "actions": [
              {
                "op": "drawFlame"
              }
            ]
          }
        ]
      }
    ]
  },
  // 卡面：天火三玄变 1 费 道具型锦囊。抉择：一个单位获得+3攻击力，将其生命设为1；或敌方下回合无法使用锦囊牌。抽一张异火。
  {
    "id": "U475",
    "name": "天火三玄变",
    "type": "spell",
    "spellKind": "item",
    "cost": 1,
    "faction": "flame",
    "text": "抉择：一个单位获得+3攻击力，将其生命设为1；或敌方下回合无法使用锦囊牌。抽一张异火。",
    "actions": [
      {
        "op": "choose",
        "prompt": "抉择",
        "options": [
          {
            "label": "一个单位获得+3攻击力，生命设为1",
            "actions": [
              {
                "op": "compound",
                "target": {
                  "kind": "chosenAnyUnit",
                  "prompt": "选择一个单位"
                },
                "actions": [
                  {
                    "op": "buffAtk",
                    "amount": 3,
                    "target": {
                      "kind": "compoundTarget"
                    }
                  },
                  {
                    "op": "setStats",
                    "hp": 1,
                    "target": {
                      "kind": "compoundTarget"
                    }
                  }
                ]
              }
            ]
          },
          {
            "label": "敌方下回合无法使用锦囊牌",
            "actions": [
              {
                "op": "spellLock",
                "side": "opponent"
              }
            ]
          }
        ]
      },
      {
        "op": "drawFlame"
      }
    ]
  },
  // 卡面：六合游身尺 1 费 道具型锦囊（令牌）。所有单位本回合攻击力为0。
  {
    "id": "U476",
    "name": "六合游身尺",
    "type": "spell",
    "spellKind": "item",
    "cost": 1,
    "faction": "flame",
    "token": true,
    "text": "所有单位本回合攻击力为0。",
    "actions": [
      {
        "op": "lockAtk",
        "untilTurnEnd": true
      }
    ]
  },
  // 卡面：佛怒火莲 5 费 攻击型锦囊（令牌）。异火堆和手牌中均没有异火牌时，将这张牌加入手中。对所有敌方单位和敌方国王造成3点伤害，重置异火堆。
  {
    "id": "U477",
    "name": "佛怒火莲",
    "type": "spell",
    "spellKind": "attack",
    "cost": 5,
    "faction": "flame",
    "token": true,
    "text": "异火堆和手牌中均没有异火牌时，将这张牌加入手中。对所有敌方单位和敌方国王造成3点伤害，重置异火堆。",
    "actions": [
      {
        "op": "damage",
        "amount": 3,
        "target": {
          "kind": "allEnemyUnits"
        }
      },
      {
        "op": "damage",
        "amount": 3,
        "target": {
          "kind": "enemyKing"
        }
      },
      {
        "op": "resetFlamePile"
      }
    ]
  },
];
