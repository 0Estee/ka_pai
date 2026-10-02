/**
 * 作者设计的卡牌 · 第三批（手绘卡 k 目录 + 令牌目录）
 *
 * ⚠️ 这个文件由 `tools/merge-b3.mjs` 从 data/_transcribe 的 A~D 四组片段合并生成，
 *    **不要手改** —— 改了下次合并会被覆盖。要改卡就改片段再合并，
 *    或者先合并、之后把片段目录删掉、转为直接维护本文件。
 *
 * 录入约定：
 *   · 卡面上 `⚔` 与 `◈` 都是攻击力，`♥` 是生命
 *   · 卡面旧名「飞行」= 词条 `nimble`（轻灵）
 *   · 独占一行且带下划线的词条名 → `keywords`；出现在句子中间的 → 效果文本里的引用
 *   · 类型下方带「令」的卡是**令牌**：`token: true`，不进牌库、只能被召唤
 *   · 每个 op / 选择器 / 触发时机写法见 data/_transcribe/引擎DSL速查.md
 */

export const USER_CARDS_B3 = [
  {
    "id": "U20",
    "name": "转移",
    "type": "spell",
    "spellKind": "item",
    "cost": 1,
    "text": "移动一名队友；抽一张牌",
    "actions": [
      {
        "op": "move",
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择要移动的队友"
        }
      },
      {
        "op": "draw",
        "amount": 1
      }
    ]
  },
  {
    "id": "U21",
    "name": "异化蚰蜒",
    "type": "unit",
    "cost": 6,
    "atk": 6,
    "hp": 8,
    "keywords": [
      "amphibious",
      "combo",
      "thorns:2"
    ],
    "text": ""
  },
  {
    "id": "U22",
    "name": "狂暴异虫",
    "type": "unit",
    "cost": 3,
    "atk": 3,
    "hp": 3,
    "keywords": [
      "crit:2"
    ],
    "text": ""
  },
  {
    "id": "U23",
    "name": "战时盟国",
    "type": "spell",
    "spellKind": "item",
    "cost": 8,
    "text": "将一名敌人置入你的手牌",
    "actions": [
      {
        "op": "stealToHand",
        "target": {
          "kind": "chosenEnemyUnit",
          "filter": {
            "spellTargetable": true
          },
          "prompt": "选择一名要夺走的敌人"
        }
      }
    ]
  },
  {
    "id": "U24",
    "name": "灭世",
    "type": "spell",
    "spellKind": "attack",
    "cost": 8,
    "text": "消灭场上所有单位",
    "actions": [
      {
        "op": "destroy",
        "target": {
          "kind": "allUnits"
        }
      }
    ]
  },
  {
    "id": "U25",
    "name": "枪打出头鸟",
    "type": "spell",
    "spellKind": "attack",
    "cost": 3,
    "text": "消灭一名⚔≥4的敌人",
    "actions": [
      {
        "op": "destroy",
        "target": {
          "kind": "chosenEnemyUnit",
          "filter": {
            "minAtk": 4,
            "spellTargetable": true
          },
          "prompt": "选择一名攻击力≥4的敌人"
        }
      }
    ]
  },
  {
    "id": "U26",
    "name": "强心针",
    "type": "spell",
    "spellKind": "item",
    "cost": 1,
    "text": "一名队友获得+3♥",
    "actions": [
      {
        "op": "buffMaxHp",
        "amount": 3,
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择一名队友"
        }
      }
    ]
  },
  {
    "id": "U27",
    "name": "伪装土堆",
    "type": "unit",
    "cost": 2,
    "atk": 0,
    "hp": 7,
    "keywords": [
      "combo"
    ],
    "bodyguard": true,
    "text": "这张牌将为后方的单位承受伤害"
  },
  {
    "id": "U28",
    "name": "鲸鱼",
    "type": "unit",
    "cost": 4,
    "atk": 2,
    "hp": 5,
    "keywords": [
      "aquatic"
    ],
    "text": "回合开始:对自己线上造成1点伤害",
    "effects": [
      {
        "trigger": "onTurnStart",
        "actions": [
          {
            "op": "damage",
            "amount": 1,
            "target": {
              "kind": "allEnemyUnitsInLane"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U31",
    "name": "跳杆运动员",
    "type": "unit",
    "cost": 4,
    "atk": 4,
    "hp": 3,
    "keywords": [
      "fuse"
    ],
    "text": "有单位被弹射时获得+1⚔+1♥；融合进化:弹射一名敌人",
    "effects": [
      {
        "trigger": "onUnitBounced",
        "actions": [
          {
            "op": "buffAtk",
            "amount": 1,
            "target": {
              "kind": "self"
            }
          },
          {
            "op": "buffMaxHp",
            "amount": 1,
            "target": {
              "kind": "self"
            }
          }
        ]
      },
      {
        "trigger": "onPlay",
        "when": "fused",
        "actions": [
          {
            "op": "bounce",
            "target": {
              "kind": "chosenEnemyUnit",
              "filter": {
                "spellTargetable": true
              },
              "prompt": "选择一名要弹射的敌人"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U32",
    "name": "致命打击",
    "type": "spell",
    "spellKind": "attack",
    "cost": 3,
    "text": "造成3点伤害；使那名单位的生命上限减少3",
    "actions": [
      {
        "op": "damage",
        "amount": 3,
        "target": {
          "kind": "chosenEnemyTarget",
          "prompt": "选择敌方单位或敌方国王"
        }
      },
      {
        "op": "modifyStats",
        "atk": 0,
        "maxHp": -3,
        "target": {
          "kind": "chosenEnemyUnit",
          "prompt": "选择那名单位"
        }
      }
    ]
  },
  {
    "id": "U33",
    "name": "雷电击",
    "type": "spell",
    "spellKind": "attack",
    "cost": 2,
    "text": "造成2点伤害,受到此伤害的敌人获-2⚔",
    "actions": [
      {
        "op": "damage",
        "amount": 2,
        "target": {
          "kind": "chosenEnemyTarget",
          "prompt": "选择敌方单位或敌方国王"
        }
      },
      {
        "op": "modifyStats",
        "atk": -2,
        "target": {
          "kind": "chosenEnemyUnit",
          "prompt": "选择那名敌人"
        }
      }
    ]
  },
  {
    "id": "U34",
    "name": "火球",
    "type": "spell",
    "spellKind": "attack",
    "cost": 2,
    "keywords": [
      "crit:1"
    ],
    "text": "对一名敌人造成3点伤害",
    "actions": [
      {
        "op": "damage",
        "amount": 3,
        "target": {
          "kind": "chosenEnemyUnit",
          "filter": {
            "spellTargetable": true
          },
          "prompt": "选择一名敌人"
        }
      }
    ]
  },
  {
    "id": "U35",
    "name": "第5伞兵旅",
    "type": "unit",
    "cost": 3,
    "atk": 3,
    "hp": 4,
    "keywords": [],
    "text": "回合开始:抽两张牌,弃置一张手牌",
    "effects": [
      {
        "trigger": "onTurnStart",
        "actions": [
          {
            "op": "draw",
            "amount": 2
          },
          {
            "op": "discard",
            "amount": 1
          }
        ]
      }
    ]
  },
  {
    "id": "U36",
    "name": "隐翅虫",
    "type": "unit",
    "cost": 3,
    "atk": 3,
    "hp": 1,
    "keywords": [
      "poison:2"
    ],
    "text": "被消灭:自己线上的敌人获-2⚔-2♥",
    "effects": [
      {
        "trigger": "onDeath",
        "actions": [
          {
            "op": "modifyStats",
            "atk": -2,
            "maxHp": -2,
            "target": {
              "kind": "allEnemyUnitsInLane"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U37",
    "name": "SU-122",
    "type": "unit",
    "cost": 6,
    "atk": 5,
    "hp": 5,
    "keywords": [
      "pierce:1"
    ],
    "text": "打出:造成3点伤害,若目标具有装甲,对其额外造成10点伤害",
    "effects": [
      {
        "trigger": "onPlay",
        "actions": [
          {
            "op": "damage",
            "amount": 3,
            "target": {
              "kind": "chosenEnemyTarget",
              "prompt": "选择敌方单位或敌方国王"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U38",
    "name": "僵尸",
    "type": "unit",
    "cost": 5,
    "atk": 5,
    "hp": 5,
    "keywords": [
      "frenzy"
    ],
    "text": "被消灭:召唤一张僵尸，其花费增加1",
    "effects": [
      {
        "trigger": "onDeath",
        "actions": [
          {
            "op": "summonToHand",
            "cardId": "U38",
            "modify": {
              "costDelta": {
                "sourceCostDelta": true,
                "plus": 1
              }
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U60",
    "name": "病原体",
    "type": "unit",
    "cost": 3,
    "atk": 3,
    "hp": 3,
    "keywords": [
      "disease"
    ],
    "text": ""
  },
  {
    "id": "U61",
    "name": "来一口",
    "type": "spell",
    "spellKind": "attack",
    "cost": 2,
    "text": "一名敌人获得-1⚔-1♥，为自己回复3♥",
    "actions": [
      {
        "op": "modifyStats",
        "atk": -1,
        "maxHp": -1,
        "target": {
          "kind": "chosenEnemyUnit",
          "filter": {
            "spellTargetable": true
          },
          "prompt": "选择一名敌人"
        }
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
  {
    "id": "U62",
    "name": "恒河水炮",
    "type": "unit",
    "cost": 3,
    "atk": 2,
    "hp": 4,
    "keywords": [
      "disease"
    ],
    "text": ""
  },
  {
    "id": "U63",
    "name": "苦痛",
    "type": "unit",
    "cost": 7,
    "atk": 4,
    "hp": 7,
    "keywords": [
      "thorns:3"
    ],
    "text": "受到伤害:获得+4⚔",
    "effects": [
      {
        "trigger": "onDamaged",
        "actions": [
          {
            "op": "buffAtk",
            "amount": 4,
            "target": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U64",
    "name": "回旋龙卷风",
    "type": "spell",
    "spellKind": "item",
    "cost": 3,
    "text": "弹射一名敌人",
    "actions": [
      {
        "op": "bounce",
        "target": {
          "kind": "chosenEnemyUnit",
          "filter": {
            "spellTargetable": true,
            "rooted": false
          },
          "prompt": "选择一名敌人（扎根的单位弹不动）"
        }
      }
    ]
  },
  {
    "id": "U65",
    "name": "沙丁鱼",
    "type": "unit",
    "cost": 1,
    "atk": 1,
    "hp": 1,
    "keywords": [
      "aquatic",
      "combo"
    ],
    "text": ""
  },
  {
    "id": "U66",
    "name": "霸王龙",
    "type": "unit",
    "cost": 6,
    "atk": 6,
    "hp": 6,
    "keywords": [
      "fuse"
    ],
    "text": "融合进化打出时，这张牌获得双重打击",
    "effects": [
      {
        "trigger": "onPlay",
        "when": "fused",
        "actions": [
          {
            "op": "grantKeyword",
            "keyword": "doubleStrike",
            "target": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U67",
    "name": "强壮",
    "type": "spell",
    "spellKind": "item",
    "cost": 1,
    "text": "所有队友获得+1⚔+2♥",
    "actions": [
      {
        "op": "buffAtk",
        "amount": 1,
        "target": {
          "kind": "allOwnUnits"
        }
      },
      {
        "op": "buffMaxHp",
        "amount": 2,
        "target": {
          "kind": "allOwnUnits"
        }
      }
    ]
  },
  {
    "id": "U68",
    "name": "掩体",
    "type": "unit",
    "cost": 1,
    "atk": 0,
    "hp": 5,
    "keywords": [
      "combo"
    ],
    "text": ""
  },
  {
    "id": "U69",
    "name": "抹杀",
    "type": "spell",
    "spellKind": "attack",
    "cost": 5,
    "text": "消灭一名敌人",
    "actions": [
      {
        "op": "destroy",
        "target": {
          "kind": "chosenEnemyUnit",
          "filter": {
            "spellTargetable": true
          },
          "prompt": "选择一名敌人"
        }
      }
    ]
  },
  {
    "id": "U70",
    "name": "铁墙",
    "type": "unit",
    "cost": 2,
    "atk": 0,
    "hp": 6,
    "keywords": [
      "combo",
      "armor:1"
    ],
    "text": ""
  },
  {
    "id": "U71",
    "name": "假人模特",
    "type": "unit",
    "cost": 1,
    "atk": 0,
    "hp": 4,
    "keywords": [
      "combo",
      "spellImmune"
    ],
    "text": ""
  },
  {
    "id": "U72",
    "name": "红火蚁",
    "type": "unit",
    "cost": 2,
    "atk": 2,
    "hp": 5,
    "keywords": [],
    "text": "每扣除1♥，便对指定单位造成1点伤害；打出:获得-2♥",
    "effects": [
      {
        "trigger": "onDamaged",
        "repeat": "damageAmount",
        "actions": [
          {
            "op": "damage",
            "amount": 1,
            "target": {
              "kind": "chosenEnemyTarget",
              "prompt": "选择一名敌方单位或敌方国王（每掉 1♥ 砸 1 点）"
            }
          }
        ]
      },
      {
        "trigger": "onPlay",
        "actions": [
          {
            "op": "modifyStats",
            "maxHp": -2,
            "target": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U73",
    "name": "虫族药师",
    "type": "unit",
    "cost": 3,
    "atk": 3,
    "hp": 2,
    "keywords": [
      "poison:1",
      "combo"
    ],
    "text": "打出:造成2点伤害",
    "effects": [
      {
        "trigger": "onPlay",
        "actions": [
          {
            "op": "damage",
            "amount": 2,
            "target": {
              "kind": "chosenEnemyTarget",
              "prompt": "选择敌方单位或敌方国王"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U74",
    "name": "老鼠",
    "type": "unit",
    "cost": 2,
    "atk": 2,
    "hp": 1,
    "keywords": [],
    "text": "自己线上的敌人获得-1⚔",
    "auras": [
      {
        "kind": "buffAtk",
        "amount": -1,
        "to": "laneEnemies"
      }
    ]
  },
  {
    "id": "U100",
    "name": "定点打击",
    "type": "spell",
    "spellKind": "attack",
    "cost": 1,
    "text": "造成2点伤害",
    "actions": [
      {
        "op": "damage",
        "amount": 2,
        "target": {
          "kind": "chosenEnemyTarget",
          "filter": {
            "spellTargetable": true
          },
          "prompt": "选择敌方单位或敌方国王"
        }
      }
    ]
  },
  {
    "id": "U101",
    "name": "虫族士兵",
    "type": "unit",
    "cost": 1,
    "atk": 2,
    "hp": 1,
    "keywords": [
      "combo"
    ],
    "text": ""
  },
  {
    "id": "U102",
    "name": "战棋",
    "type": "unit",
    "cost": 2,
    "atk": 1,
    "hp": 1,
    "keywords": [
      "combo"
    ],
    "text": "在场:自己和相邻线上的队友获得+1⚔",
    "auras": [
      {
        "kind": "buffAtk",
        "amount": 1,
        "to": "selfAndAdjacentLaneAllies"
      }
    ]
  },
  {
    "id": "U103",
    "name": "吹箭手",
    "type": "unit",
    "cost": 2,
    "atk": 3,
    "hp": 1,
    "keywords": [
      "pierce:1"
    ],
    "text": ""
  },
  {
    "id": "U104",
    "name": "沧龙",
    "type": "unit",
    "cost": 5,
    "atk": 5,
    "hp": 4,
    "keywords": [
      "aquatic"
    ],
    "text": "回合开始:消灭自己和相邻线上的所有敌人",
    "effects": [
      {
        "trigger": "onTurnStart",
        "actions": [
          {
            "op": "destroy",
            "target": {
              "kind": "adjacentEnemyUnits"
            }
          },
          {
            "op": "destroy",
            "target": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U105",
    "name": "T-34 1942",
    "type": "unit",
    "cost": 6,
    "atk": 6,
    "hp": 6,
    "keywords": [
      "invincible"
    ],
    "text": "本单位受到的伤害为0"
  },
  {
    "id": "U106",
    "name": "紧急撤离",
    "type": "spell",
    "spellKind": "item",
    "cost": 2,
    "text": "弹射一名队友，抽一张牌",
    "actions": [
      {
        "op": "bounce",
        "target": {
          "kind": "chosenOwnUnit",
          "filter": {
            "spellTargetable": true
          },
          "prompt": "选择一名队友，将其退回手牌"
        }
      },
      {
        "op": "draw",
        "amount": 1
      }
    ]
  },
  {
    "id": "U107",
    "name": "礼盒",
    "type": "spell",
    "spellKind": "item",
    "cost": 2,
    "text": "回复3♥，抽一张牌",
    "actions": [
      {
        "op": "heal",
        "amount": 3,
        "target": {
          "kind": "ownKing"
        }
      },
      {
        "op": "draw",
        "amount": 1
      }
    ]
  },
  {
    "id": "U108",
    "name": "甲龙",
    "type": "unit",
    "cost": 4,
    "atk": 2,
    "hp": 3,
    "keywords": [
      "armor:3"
    ],
    "text": ""
  },
  {
    "id": "U109",
    "name": "健身学员",
    "type": "unit",
    "cost": 1,
    "atk": 1,
    "hp": 1,
    "keywords": [],
    "text": "回合开始:获得+1⚔+1♥",
    "effects": [
      {
        "trigger": "onTurnStart",
        "actions": [
          {
            "op": "buffAtk",
            "amount": 1,
            "target": {
              "kind": "self"
            }
          },
          {
            "op": "buffMaxHp",
            "amount": 1,
            "target": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U110",
    "name": "绷带",
    "type": "spell",
    "spellKind": "item",
    "cost": 1,
    "text": "治疗3点生命值",
    "actions": [
      {
        "op": "heal",
        "amount": 3,
        "target": {
          "kind": "ownKing"
        }
      }
    ]
  },
  {
    "id": "U111",
    "name": "弓箭手",
    "type": "unit",
    "cost": 1,
    "atk": 1,
    "hp": 1,
    "keywords": [],
    "text": "打出:造成一点伤害",
    "effects": [
      {
        "trigger": "onPlay",
        "actions": [
          {
            "op": "damage",
            "amount": 1,
            "target": {
              "kind": "chosenEnemyTarget",
              "filter": {
                "spellTargetable": true
              },
              "prompt": "选择敌方单位或敌方国王"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U112",
    "name": "橄榄球员",
    "type": "unit",
    "cost": 5,
    "atk": 4,
    "hp": 4,
    "keywords": [
      "armor:1",
      "frenzy",
      "splash:1"
    ],
    "text": ""
  },
  {
    "id": "U113",
    "name": "鸡腿",
    "type": "spell",
    "spellKind": "item",
    "cost": 2,
    "text": "治疗4点生命值",
    "actions": [
      {
        "op": "heal",
        "amount": 4,
        "target": {
          "kind": "ownKing"
        }
      }
    ]
  },
  {
    "id": "U140",
    "name": "生长炸弹",
    "type": "spell",
    "spellKind": "attack",
    "cost": 5,
    "actions": [
      {
        "op": "buffAtk",
        "amount": 1,
        "target": {
          "kind": "allUnits"
        }
      },
      {
        "op": "destroy",
        "target": {
          "kind": "allUnits",
          "filter": {
            "minAtk": 4
          }
        }
      }
    ]
  },
  {
    "id": "U141",
    "name": "炒鸡赛亚人",
    "type": "unit",
    "cost": 5,
    "atk": 5,
    "hp": 4,
    "keywords": [
      "pierce:999"
    ]
  },
  {
    "id": "U142",
    "name": "停战调剂",
    "type": "spell",
    "spellKind": "item",
    "cost": 4,
    "text": "所有单位获得-1◈；然后弹射所有◈<2的单位",
    "actions": [
      {
        "op": "buffAtk",
        "amount": -1,
        "target": {
          "kind": "allUnits"
        }
      },
      {
        "op": "bounce",
        "target": {
          "kind": "allUnits",
          "filter": {
            "maxAtk": 1
          }
        }
      }
    ]
  },
  {
    "id": "U143",
    "name": "大力丸",
    "type": "spell",
    "spellKind": "item",
    "cost": 2,
    "text": "一名队友获+2⚔+2♥",
    "actions": [
      {
        "op": "buffAtk",
        "amount": 2,
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择一名队友"
        }
      },
      {
        "op": "buffMaxHp",
        "amount": 2,
        "target": {
          "kind": "chosenOwnUnit"
        }
      }
    ]
  },
  {
    "id": "U144",
    "name": "物产丰富",
    "type": "spell",
    "spellKind": "item",
    "cost": 3,
    "text": "抽两张牌",
    "actions": [
      {
        "op": "draw",
        "amount": 2
      }
    ]
  },
  {
    "id": "U145",
    "name": "南方巨兽龙",
    "type": "unit",
    "cost": 7,
    "atk": 6,
    "hp": 7,
    "keywords": [
      "frenzy"
    ]
  },
  {
    "id": "U146",
    "name": "雪松",
    "type": "unit",
    "cost": 2,
    "atk": 0,
    "hp": 3,
    "keywords": [
      "armor:1",
      "combo",
      "rooted"
    ],
    "text": "回合开始:获得+1♥",
    "effects": [
      {
        "trigger": "onTurnStart",
        "actions": [
          {
            "op": "buffMaxHp",
            "amount": 1,
            "target": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U147",
    "name": "异形",
    "type": "unit",
    "cost": 3,
    "atk": 1,
    "hp": 4,
    "token": true,
    "keywords": [
      "crit:2",
      "poison:1"
    ]
  },
  {
    "id": "U148",
    "name": "牛肉",
    "type": "spell",
    "spellKind": "item",
    "cost": 1,
    "token": true,
    "text": "恢复3点血量",
    "actions": [
      {
        "op": "heal",
        "amount": 3,
        "target": {
          "kind": "ownKing"
        }
      }
    ]
  },
  {
    "id": "U149",
    "name": "仙人掌",
    "type": "unit",
    "cost": 3,
    "atk": 0,
    "hp": 4,
    "keywords": [
      "thorns:3",
      "combo"
    ]
  },
  {
    "id": "U150",
    "name": "麻雀",
    "type": "unit",
    "cost": 1,
    "atk": 2,
    "hp": 2,
    "keywords": [
      "nimble"
    ]
  },
  {
    "id": "U155",
    "name": "赤红糖果",
    "type": "spell",
    "spellKind": "item",
    "cost": 1,
    "text": "一名队友获得+1⚔+2♥",
    "actions": [
      {
        "op": "buffAtk",
        "amount": 1,
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择一名队友"
        }
      },
      {
        "op": "buffMaxHp",
        "amount": 2,
        "target": {
          "kind": "chosenOwnUnit"
        }
      }
    ]
  },
  {
    "id": "U153",
    "name": "功勋",
    "type": "spell",
    "spellKind": "item",
    "cost": 2,
    "token": true,
    "text": "一名队友获复生",
    "actions": [
      {
        "op": "grantKeyword",
        "keyword": "rebirth",
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择一名队友"
        }
      }
    ]
  },
  {
    "id": "U154",
    "name": "抱脸虫",
    "type": "unit",
    "cost": 4,
    "atk": 3,
    "hp": 3,
    "token": true,
    "keywords": [
      "hunt"
    ],
    "text": "进入一条线:那里的敌人获-2⚔-1♥",
    "effects": [
      {
        "trigger": "onEnterLane",
        "actions": [
          {
            "op": "modifyStats",
            "atk": -2,
            "maxHp": -1,
            "target": {
              "kind": "allEnemyUnitsInLane"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U156",
    "name": "流星碎片",
    "type": "unit",
    "cost": 2,
    "atk": 0,
    "hp": 1,
    "token": true,
    "text": "打出:一名队友获+3⚔；这张牌获-1♥",
    "effects": [
      {
        "trigger": "onPlay",
        "actions": [
          {
            "op": "buffAtk",
            "amount": 3,
            "target": {
              "kind": "chosenOwnUnit",
              "prompt": "选择一名队友"
            }
          },
          {
            "op": "modifyStats",
            "atk": 0,
            "maxHp": -1,
            "target": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U200",
    "name": "游击队",
    "type": "unit",
    "cost": 2,
    "atk": 4,
    "hp": 1,
    "keywords": [],
    "text": "开战回合:获得无敌",
    "effects": [
      {
        "trigger": "onCombatStart",
        "actions": [
          {
            "op": "grantKeyword",
            "keyword": "invincible",
            "untilTurnEnd": true,
            "target": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U201",
    "name": "紫电局地战",
    "type": "unit",
    "cost": 6,
    "atk": 4,
    "hp": 5,
    "keywords": [
      "nimble",
      "doubleStrike"
    ],
    "text": "开战回合这张牌无敌",
    "effects": [
      {
        "trigger": "onCombatStart",
        "actions": [
          {
            "op": "grantKeyword",
            "keyword": "invincible",
            "untilTurnEnd": true,
            "target": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U202",
    "name": "登山员",
    "type": "unit",
    "cost": 2,
    "atk": 2,
    "hp": 2,
    "keywords": [],
    "text": "在高山上打出获得+1⚔+1♥",
    "effects": [
      {
        "trigger": "onPlay",
        "when": {
          "lane": "mountain"
        },
        "actions": [
          {
            "op": "modifyStats",
            "atk": 1,
            "maxHp": 1,
            "target": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U203",
    "name": "力量光波",
    "type": "spell",
    "spellKind": "attack",
    "cost": 4,
    "text": "造成己方场上队友数×2的伤害",
    "actions": [
      {
        "op": "damage",
        "amount": {
          "perOwnUnit": 2
        },
        "target": {
          "kind": "chosenEnemyTarget",
          "prompt": "选择敌方单位或敌方国王"
        }
      }
    ]
  },
  {
    "id": "U204",
    "name": "石中剑",
    "type": "unit",
    "cost": 3,
    "atk": 1,
    "hp": 5,
    "keywords": [],
    "text": "打出:场上每有一名单位这张牌便获+1⚔",
    "effects": [
      {
        "trigger": "onPlay",
        "actions": [
          {
            "op": "buffAtk",
            "amount": {
              "perAllUnits": 1
            },
            "target": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U205",
    "name": "鲸鲨",
    "type": "unit",
    "cost": 4,
    "atk": 2,
    "hp": 4,
    "keywords": [
      "aquatic"
    ],
    "text": "打出:消灭一名♥最低的敌人",
    "effects": [
      {
        "trigger": "onPlay",
        "actions": [
          {
            "op": "destroy",
            "target": {
              "kind": "lowestHpEnemyUnit"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U206",
    "name": "狂犬病",
    "type": "spell",
    "spellKind": "attack",
    "cost": 3,
    "text": "一名队友获得疾病,并额外攻击一次",
    "actions": [
      {
        "op": "grantKeyword",
        "keyword": "disease",
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择一名队友"
        }
      },
      {
        "op": "extraAttack",
        "target": {
          "kind": "chosenOwnUnit"
        }
      }
    ]
  },
  {
    "id": "U207",
    "name": "咖啡豆",
    "type": "spell",
    "spellKind": "attack",
    "cost": 2,
    "text": "一名队友额外攻击一次",
    "actions": [
      {
        "op": "extraAttack",
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择一名队友"
        }
      }
    ]
  },
  {
    "id": "U208",
    "name": "魔术师",
    "type": "unit",
    "cost": 4,
    "atk": 2,
    "hp": 3,
    "keywords": [],
    "text": "打出:让一名敌人变为⚔1♥2的兔子",
    "effects": [
      {
        "trigger": "onPlay",
        "actions": [
          {
            "op": "transform",
            "cardId": "U329",
            "target": {
              "kind": "chosenEnemyUnit",
              "filter": {
                "spellTargetable": true
              },
              "prompt": "选择一名要变成兔子的敌人"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U209",
    "name": "感染",
    "type": "spell",
    "spellKind": "item",
    "cost": 4,
    "text": "一名队友获+3⚔+3♥；并获得组合与淬毒；清空其本身的异能",
    "actions": [
      {
        "op": "modifyStats",
        "atk": 3,
        "maxHp": 3,
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择一名队友"
        }
      },
      {
        "op": "grantKeyword",
        "keyword": "combo",
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择一名队友"
        }
      },
      {
        "op": "grantKeyword",
        "keyword": "poison",
        "x": 0,
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择一名队友"
        }
      },
      {
        "op": "seal",
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择那名队友（清空其异能）"
        }
      }
    ]
  },
  {
    "id": "U210",
    "name": "山炮",
    "type": "unit",
    "cost": 1,
    "atk": 2,
    "hp": 1,
    "keywords": [
      "combo"
    ],
    "text": ""
  },
  {
    "id": "U211",
    "name": "剑龙",
    "type": "unit",
    "cost": 3,
    "atk": 2,
    "hp": 4,
    "keywords": [
      "thorns:2"
    ],
    "text": ""
  },
  {
    "id": "U212",
    "name": "坚固防线",
    "type": "spell",
    "spellKind": "item",
    "cost": 4,
    "text": "为你的国王回复等同于在场单位数的♥",
    "actions": [
      {
        "op": "heal",
        "amount": {
          "perAllUnits": 1
        },
        "target": {
          "kind": "ownKing"
        }
      }
    ]
  },
  {
    "id": "U240",
    "name": "无双剑豪",
    "type": "unit",
    "cost": 9,
    "atk": 8,
    "hp": 7,
    "keywords": [
      "crit:3",
      "splash:3"
    ],
    "text": "消灭敌人:所有队友获+1⚔；+1♥",
    "effects": [
      {
        "trigger": "onKill",
        "actions": [
          {
            "op": "buffAtk",
            "amount": 1,
            "target": {
              "kind": "allOwnUnits"
            }
          },
          {
            "op": "buffMaxHp",
            "amount": 1,
            "target": {
              "kind": "allOwnUnits"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U241",
    "name": "酸雨",
    "type": "spell",
    "spellKind": "attack",
    "cost": 2,
    "text": "平地上的所有敌人获得-1⚔-1♥",
    "actions": [
      {
        "op": "modifyStats",
        "atk": -1,
        "maxHp": -1,
        "target": {
          "kind": "allEnemyUnits",
          "filter": {
            "laneIn": [
              "plainL",
              "plainR"
            ]
          }
        }
      }
    ]
  },
  {
    "id": "U242",
    "name": "拳击手",
    "type": "unit",
    "cost": 2,
    "atk": 2,
    "hp": 3,
    "keywords": [],
    "text": "对方打出锦囊牌时,获得+1⚔+1♥",
    "effects": [
      {
        "trigger": "onEnemyCastSpell",
        "actions": [
          {
            "op": "modifyStats",
            "atk": 1,
            "maxHp": 1,
            "target": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U243",
    "name": "永恒秘典",
    "type": "unit",
    "cost": 3,
    "atk": 0,
    "hp": 4,
    "keywords": [
      "armor:1",
      "combo"
    ],
    "text": "后方的队友获 穿透2；回合开始:♥变为4",
    "auras": [
      {
        "kind": "grantKeyword",
        "keyword": "pierce",
        "x": 2,
        "to": "laneBackRowAllies"
      }
    ],
    "effects": [
      {
        "trigger": "onTurnStart",
        "actions": [
          {
            "op": "setStats",
            "hp": 4,
            "target": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U244",
    "name": "派对客",
    "type": "unit",
    "cost": 3,
    "atk": 2,
    "hp": 3,
    "keywords": [
      "doubleStrike"
    ],
    "text": "有队友额外攻击时,抽一张牌",
    "effects": [
      {
        "trigger": "onAllyExtraAttack",
        "actions": [
          {
            "op": "draw",
            "amount": 1
          }
        ]
      }
    ]
  },
  {
    "id": "U245",
    "name": "格斗家",
    "type": "unit",
    "cost": 4,
    "atk": 3,
    "hp": 4,
    "keywords": [],
    "text": "♥>2时获穿透1",
    "auras": [
      {
        "kind": "grantKeyword",
        "keyword": "pierce",
        "x": 1,
        "to": "self",
        "condition": {
          "hpAbove": 2
        }
      }
    ]
  },
  {
    "id": "U280",
    "name": "导弹",
    "type": "unit",
    "cost": 3,
    "atk": 0,
    "hp": 1,
    "keywords": [
      "combo"
    ],
    "text": "被消灭:对自己线上的所有单位造成5点伤害",
    "effects": [
      {
        "trigger": "onDeath",
        "actions": [
          {
            "op": "damage",
            "amount": 5,
            "target": {
              "kind": "allUnitsInLane"
            }
          },
          {
            "op": "damage",
            "amount": 5,
            "target": {
              "kind": "ownKing"
            }
          },
          {
            "op": "damage",
            "amount": 5,
            "target": {
              "kind": "enemyKing"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U281",
    "name": "卫兵",
    "type": "unit",
    "cost": 2,
    "atk": 6,
    "hp": 6,
    "keywords": [
      "combo",
      "cannotAttack"
    ],
    "text": "无法攻击,4个单位被消灭后,封印这张牌的异能",
    "effects": [
      {
        "trigger": "onAnyUnitDestroyed",
        "when": {
          "deathsAtLeast": 4
        },
        "actions": [
          {
            "op": "seal",
            "target": {
              "kind": "self"
            }
          },
          {
            "op": "revokeKeyword",
            "keyword": "cannotAttack",
            "target": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U282",
    "name": "利奥波德",
    "type": "unit",
    "cost": 10,
    "atk": 6,
    "hp": 5,
    "keywords": [
      "pierce:2"
    ],
    "text": "打出:将所有敌方单位返回牌堆顶",
    "effects": [
      {
        "trigger": "onPlay",
        "actions": [
          {
            "op": "returnToDeck",
            "side": "opponent",
            "from": "board",
            "to": "top",
            "target": {
              "kind": "allEnemyUnits"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U283",
    "name": "武术大师",
    "type": "unit",
    "cost": 6,
    "atk": 0,
    "hp": 7,
    "keywords": [
      "doubleStrike"
    ],
    "attackWithHp": true,
    "text": "此攻击使用♥而不是⚔"
  },
  {
    "id": "U284",
    "name": "禁军",
    "type": "unit",
    "cost": 3,
    "atk": 4,
    "hp": 2,
    "keywords": [],
    "text": "打出:封印一个单位的异能.",
    "effects": [
      {
        "trigger": "onPlay",
        "actions": [
          {
            "op": "seal",
            "target": {
              "kind": "chosenEnemyUnit",
              "prompt": "选择要封印异能的敌方单位"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U285",
    "name": "弹簧假人",
    "type": "unit",
    "cost": 2,
    "atk": 1,
    "hp": 4,
    "keywords": [],
    "text": "造成伤害:弹射那名敌人",
    "effects": [
      {
        "trigger": "onDealDamage",
        "actions": [
          {
            "op": "bounce",
            "target": {
              "kind": "triggerVictim"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U286",
    "name": "青蛙",
    "type": "unit",
    "cost": 3,
    "atk": 2,
    "hp": 2,
    "keywords": [
      "amphibious"
    ],
    "text": "打出:消灭自己线上⚔<2的所有单位",
    "effects": [
      {
        "trigger": "onPlay",
        "actions": [
          {
            "op": "destroy",
            "target": {
              "kind": "allUnitsInLane",
              "filter": {
                "maxAtk": 1
              }
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U287",
    "name": "狙击手",
    "type": "unit",
    "cost": 4,
    "atk": 3,
    "hp": 3,
    "keywords": [],
    "text": "自己线上的战斗开始前:造成2点伤害",
    "effects": [
      {
        "trigger": "onCombatStart",
        "actions": [
          {
            "op": "damage",
            "amount": 2,
            "target": {
              "kind": "allEnemyUnitsInLane"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U288",
    "name": "毒镖",
    "type": "spell",
    "spellKind": "attack",
    "cost": 2,
    "keywords": [
      "poison:1"
    ],
    "text": "对一名敌人造成3点伤害",
    "actions": [
      {
        "op": "damage",
        "amount": 3,
        "target": {
          "kind": "chosenEnemyUnit",
          "filter": {
            "spellTargetable": true
          },
          "prompt": "选择一名敌人"
        }
      }
    ]
  },
  {
    "id": "U289",
    "name": "第3补给营",
    "type": "unit",
    "cost": 4,
    "atk": 2,
    "hp": 2,
    "keywords": [
      "combo",
      "armor:1"
    ],
    "text": "打出:选择一个单位,其每具有一个词条,抽一张牌",
    "effects": [
      {
        "trigger": "onPlay",
        "actions": [
          {
            "op": "draw",
            "amount": {
              "perKeywordOfTarget": 1
            },
            "target": {
              "kind": "chosenAnyUnit",
              "prompt": "选择一个单位（按其词条数抽牌）"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U291",
    "name": "炫彩糖果",
    "type": "spell",
    "spellKind": "item",
    "cost": 2,
    "text": "一名队友本回合获得无敌,抽1张牌",
    "actions": [
      {
        "op": "grantKeyword",
        "keyword": "invincible",
        "untilTurnEnd": true,
        "target": {
          "kind": "chosenOwnUnit",
          "filter": {
            "spellTargetable": true
          },
          "prompt": "选择一名队友（本回合无敌）"
        }
      },
      {
        "op": "draw",
        "amount": 1
      }
    ]
  },
  {
    "id": "U293",
    "name": "宝藏",
    "type": "spell",
    "spellKind": "item",
    "cost": 4,
    "text": "每有一名队友,抽一张牌",
    "actions": [
      {
        "op": "draw",
        "amount": {
          "perOwnUnit": 1
        }
      }
    ]
  },
  {
    "id": "U320",
    "name": "幽灵",
    "type": "unit",
    "cost": 1,
    "atk": 0,
    "hp": 1,
    "token": true,
    "keywords": [
      "combo"
    ]
  },
  {
    "id": "U321",
    "name": "白鼠",
    "type": "unit",
    "cost": 2,
    "atk": 0,
    "hp": 1,
    "token": true,
    "text": "被消灭:所有队友获+1♥+1⚔",
    "effects": [
      {
        "trigger": "onDeath",
        "actions": [
          {
            "op": "buffMaxHp",
            "amount": 1,
            "target": {
              "kind": "allOwnUnits"
            }
          },
          {
            "op": "buffAtk",
            "amount": 1,
            "target": {
              "kind": "allOwnUnits"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U322",
    "name": "猎手模式",
    "type": "spell",
    "spellKind": "item",
    "cost": 4,
    "token": true,
    "text": "所有队友获得捕猎；所有捕猎的队友获+1⚔+1♥和狂热",
    "actions": [
      {
        "op": "grantKeyword",
        "keyword": "hunt",
        "target": {
          "kind": "allOwnUnits"
        }
      },
      {
        "op": "buffAtk",
        "amount": 1,
        "target": {
          "kind": "allOwnUnits",
          "filter": {
            "keyword": "hunt"
          }
        }
      },
      {
        "op": "buffMaxHp",
        "amount": 1,
        "target": {
          "kind": "allOwnUnits",
          "filter": {
            "keyword": "hunt"
          }
        }
      },
      {
        "op": "grantKeyword",
        "keyword": "frenzy",
        "target": {
          "kind": "allOwnUnits",
          "filter": {
            "keyword": "hunt"
          }
        }
      }
    ]
  },
  {
    "id": "U323",
    "name": "枯树皮",
    "type": "spell",
    "spellKind": "item",
    "cost": 0,
    "token": true,
    "text": "一名队友获得装甲1；和+2♥",
    "actions": [
      {
        "op": "grantKeyword",
        "keyword": "armor",
        "x": 1,
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择一名队友"
        }
      },
      {
        "op": "buffMaxHp",
        "amount": 2,
        "target": {
          "kind": "chosenOwnUnit"
        }
      }
    ]
  },
  {
    "id": "U324",
    "name": "火箭弹",
    "type": "spell",
    "spellKind": "attack",
    "cost": 1,
    "token": true,
    "text": "造成3点伤害",
    "actions": [
      {
        "op": "damage",
        "amount": 3,
        "target": {
          "kind": "chosenEnemyTarget",
          "filter": {
            "spellTargetable": true
          },
          "prompt": "选择敌方单位或敌方国王"
        }
      }
    ]
  },
  {
    "id": "U325",
    "name": "劫匪头套",
    "type": "spell",
    "spellKind": "item",
    "cost": 1,
    "token": true,
    "text": "融合:让那个单位获得+1⚔",
    "actions": [
      {
        "op": "buffAtk",
        "amount": 1,
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择要获得+1⚔的队友"
        }
      }
    ]
  },
  {
    "id": "U326",
    "name": "队徽",
    "type": "spell",
    "spellKind": "item",
    "cost": 1,
    "token": true,
    "text": "使一名队友获得:装甲1、祝福2",
    "actions": [
      {
        "op": "grantKeyword",
        "keyword": "armor",
        "x": 1,
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择一名队友"
        }
      },
      {
        "op": "grantKeyword",
        "keyword": "blessing",
        "x": 2,
        "target": {
          "kind": "chosenOwnUnit"
        }
      }
    ]
  },
  {
    "id": "U327",
    "name": "近卫步兵",
    "type": "unit",
    "cost": 1,
    "atk": 1,
    "hp": 1,
    "token": true,
    "keywords": [
      "thorns:2",
      "disease",
      "combo"
    ],
    "text": "本单位的疾病效果立即触发",
    "effects": [
      {
        "trigger": "onDealDamage",
        "actions": [
          {
            "op": "destroy",
            "target": {
              "kind": "triggerVictim"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U328",
    "name": "湿滑地面",
    "type": "spell",
    "spellKind": "item",
    "cost": 1,
    "token": true,
    "text": "移动一名敌人",
    "actions": [
      {
        "op": "move",
        "target": {
          "kind": "chosenEnemyUnit",
          "prompt": "选择要移动的敌人"
        }
      }
    ]
  },
  {
    "id": "U329",
    "name": "兔子",
    "type": "unit",
    "cost": 1,
    "atk": 1,
    "hp": 2,
    "token": true
  },
  {
    "id": "U330",
    "name": "催化剂",
    "type": "spell",
    "spellKind": "item",
    "cost": 3,
    "token": true,
    "text": "名队友获得+2⚔+2♥",
    "actions": [
      {
        "op": "buffAtk",
        "amount": 2,
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择一名队友"
        }
      },
      {
        "op": "buffMaxHp",
        "amount": 2,
        "target": {
          "kind": "chosenOwnUnit"
        }
      }
    ]
  },
  {
    "id": "U331",
    "name": "水蛭",
    "type": "unit",
    "cost": 3,
    "atk": 3,
    "hp": 1,
    "text": "被消灭:消灭一名♥≤3的敌人",
    "effects": [
      {
        "trigger": "onDeath",
        "actions": [
          {
            "op": "destroy",
            "target": {
              "kind": "chosenEnemyUnit",
              "filter": {
                "maxHp": 3
              },
              "prompt": "选择一名♥≤3的敌人"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U332",
    "name": "群情激愤",
    "type": "spell",
    "spellKind": "item",
    "cost": 1,
    "text": "所有队友获得+1⚔",
    "actions": [
      {
        "op": "buffAtk",
        "amount": 1,
        "target": {
          "kind": "allOwnUnits"
        }
      }
    ]
  },
  {
    "id": "U333",
    "name": "苍耳",
    "type": "unit",
    "cost": 1,
    "atk": 0,
    "hp": 2,
    "text": "对方打出锦囊牌时，对其造成1点伤害",
    "effects": [
      {
        "trigger": "onEnemyCastSpell",
        "actions": [
          {
            "op": "damage",
            "amount": 1,
            "target": {
              "kind": "enemyKing"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U334",
    "name": "缠绕水草",
    "type": "spell",
    "spellKind": "attack",
    "cost": 2,
    "text": "一名敌人获得-1⚔-2♥；如果其位于水路,消灭它",
    "actions": [
      {
        "op": "modifyStats",
        "atk": -1,
        "maxHp": -2,
        "target": {
          "kind": "chosenEnemyUnit",
          "filter": {
            "spellTargetable": true
          },
          "prompt": "选择一名敌人"
        }
      },
      {
        "op": "destroy",
        "target": {
          "kind": "chosenEnemyUnit",
          "filter": {
            "lane": "water",
            "spellTargetable": true
          },
          "prompt": "如果它是水路单位就消灭它"
        }
      }
    ]
  },
  {
    "id": "U360",
    "name": "氢弹",
    "type": "spell",
    "spellKind": "attack",
    "cost": 7,
    "text": "消灭平地上的所有单位；令平地不可放置单位一回合",
    "actions": [
      {
        "op": "destroy",
        "target": {
          "kind": "allUnits",
          "filter": {
            "laneIn": [
              "plainL",
              "plainR"
            ]
          }
        }
      },
      {
        "op": "lockLane",
        "lanes": [
          "plainL",
          "plainR"
        ],
        "turns": 1
      }
    ]
  },
  {
    "id": "U361",
    "name": "回收",
    "type": "spell",
    "spellKind": "item",
    "cost": 1,
    "text": "将1张手牌洗入牌组，抽一张牌",
    "actions": [
      {
        "op": "returnToDeck",
        "from": "hand",
        "count": 1,
        "to": "shuffle",
        "prompt": "选择要洗回牌组的牌"
      },
      {
        "op": "draw",
        "amount": 1
      }
    ]
  },
  {
    "id": "U362",
    "name": "希佩尔海军上将号",
    "type": "unit",
    "cost": 6,
    "atk": 6,
    "hp": 5,
    "keywords": [
      "aquatic"
    ],
    "text": "敌方抽牌时，将其弃置",
    "effects": [
      {
        "trigger": "onOpponentDraw",
        "actions": [
          {
            "op": "discardDrawn",
            "side": "opponent"
          }
        ]
      }
    ]
  },
  {
    "id": "U370",
    "name": "大封印碑",
    "type": "unit",
    "cost": 6,
    "atk": 0,
    "hp": 5,
    "keywords": [
      "combo"
    ],
    "text": "在场:封印敌方所有单位的特殊效果",
    "auras": [
      {
        "kind": "seal",
        "to": "allEnemies"
      }
    ]
  },
  {
    "id": "U371",
    "name": "反应装甲",
    "type": "spell",
    "spellKind": "item",
    "cost": 2,
    "token": true,
    "keywords": [
      "trap"
    ],
    "text": "本回合，所有敌方卡牌造成的伤害至多为2",
    "actions": [
      {
        "op": "capDamage",
        "value": 2,
        "side": "opponent",
        "turns": 1
      }
    ]
  },
  {
    "id": "U372",
    "name": "劫匪团队",
    "type": "unit",
    "cost": 3,
    "atk": 4,
    "hp": 3,
    "keywords": [],
    "text": "受到伤害:依次变为3/2、2/1。被消灭:召唤一张劫匪头套",
    "effects": [
      {
        "trigger": "onDamaged",
        "actions": [
          {
            "op": "cycleStats",
            "steps": [
              {
                "atk": 3,
                "hp": 2
              },
              {
                "atk": 2,
                "hp": 1
              }
            ]
          }
        ]
      },
      {
        "trigger": "onDeath",
        "actions": [
          {
            "op": "summonToHand",
            "cardId": "U325"
          }
        ]
      }
    ]
  },
  {
    "id": "U373",
    "name": "四号坦克H型",
    "type": "unit",
    "cost": 4,
    "atk": 4,
    "hp": 5,
    "token": true,
    "keywords": [],
    "text": "若场上敌人数不大于队友数，获双重打击，否则额外攻击一次",
    "effects": [
      {
        "trigger": "onPlay",
        "actions": [
          {
            "op": "conditional",
            "if": {
              "compare": "enemiesLEAllies"
            },
            "then": [
              {
                "op": "grantKeyword",
                "keyword": "doubleStrike",
                "target": {
                  "kind": "self"
                }
              }
            ],
            "else": [
              {
                "op": "extraAttack",
                "target": {
                  "kind": "self"
                }
              }
            ]
          }
        ]
      }
    ]
  },
  {
    "id": "U374",
    "name": "神威",
    "type": "spell",
    "spellKind": "item",
    "cost": 3,
    "token": true,
    "text": "令一名队友无法选中一回合",
    "actions": [
      {
        "op": "untargetable",
        "turns": 1,
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择一名队友"
        }
      }
    ]
  },
  {
    "id": "U375",
    "name": "橄榄球",
    "type": "spell",
    "spellKind": "attack",
    "cost": 1,
    "keywords": [
      "splash:1"
    ],
    "text": "对一名敌人造成2点伤害",
    "actions": [
      {
        "op": "damage",
        "amount": 2,
        "asAttack": true,
        "target": {
          "kind": "chosenEnemyTarget",
          "filter": {
            "spellTargetable": true
          },
          "prompt": "选择敌方单位或敌方国王"
        }
      }
    ]
  },
  {
    "id": "U380",
    "name": "蜜蜂",
    "type": "unit",
    "cost": 2,
    "atk": 2,
    "hp": 2,
    "keywords": [
      "poison:1"
    ],
    "bypassInCombat": true,
    "text": "任何单位攻击时将略过这张牌；造成伤害:受到1点伤害",
    "effects": [
      {
        "trigger": "onDealDamage",
        "actions": [
          {
            "op": "damage",
            "amount": 1,
            "target": {
              "kind": "self"
            },
            "noDamagedTrigger": true
          }
        ]
      }
    ]
  },
  {
    "id": "U381",
    "name": "雷龙",
    "type": "unit",
    "cost": 7,
    "atk": 5,
    "hp": 7,
    "keywords": [],
    "text": "打出:弹射平地上的所有敌人",
    "effects": [
      {
        "trigger": "onPlay",
        "actions": [
          {
            "op": "bounce",
            "target": {
              "kind": "allEnemyUnits",
              "filter": {
                "laneIn": [
                  "plainL",
                  "plainR"
                ]
              }
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U382",
    "name": "野蔷薇",
    "type": "unit",
    "cost": 2,
    "atk": 1,
    "hp": 3,
    "keywords": [
      "thorns:2",
      "poison:1",
      "combo"
    ],
    "text": ""
  },
  {
    "id": "U383",
    "name": "傀儡",
    "type": "unit",
    "cost": 1,
    "atk": 0,
    "hp": 2,
    "token": true,
    "keywords": [
      "spellImmune"
    ],
    "text": ""
  },
  {
    "id": "U384",
    "name": "人间大炮",
    "type": "unit",
    "cost": 4,
    "atk": 3,
    "hp": 4,
    "keywords": [
      "trueStrike",
      "combo"
    ],
    "text": "有队友被打出时，对敌方国王造成1点伤害",
    "effects": [
      {
        "trigger": "onAllyPlayed",
        "actions": [
          {
            "op": "damage",
            "amount": 1,
            "target": {
              "kind": "enemyKing"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U385",
    "name": "独生花",
    "type": "unit",
    "cost": 5,
    "atk": 10,
    "hp": 1,
    "token": true,
    "keywords": [
      "spellImmune"
    ],
    "text": ""
  },
  {
    "id": "U386",
    "name": "双嵴龙",
    "type": "unit",
    "cost": 2,
    "atk": 2,
    "hp": 2,
    "keywords": [
      "amphibious"
    ],
    "text": "在水池线上打出:获得+1⚔+1♥",
    "effects": [
      {
        "trigger": "onPlay",
        "when": {
          "lane": "water"
        },
        "actions": [
          {
            "op": "modifyStats",
            "atk": 1,
            "maxHp": 1,
            "target": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U387",
    "name": "坚韧",
    "type": "spell",
    "spellKind": "item",
    "cost": 2,
    "text": "一名队友获得装甲1，并+2♥",
    "actions": [
      {
        "op": "grantKeyword",
        "keyword": "armor",
        "x": 1,
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择一名队友"
        }
      },
      {
        "op": "buffMaxHp",
        "amount": 2,
        "target": {
          "kind": "chosenOwnUnit",
          "prompt": "选择一名队友"
        }
      }
    ]
  },
  {
    "id": "U390",
    "name": "黑龙",
    "type": "unit",
    "cost": 13,
    "atk": 3,
    "hp": 3,
    "keywords": [],
    "text": "在手牌中:在你出牌时，这张牌获+1⚔+1♥，若超过6⚔，转而降低1花费；打出:额外攻击一次",
    "inHand": [
      {
        "buff": {
          "atk": 1,
          "maxHp": 1
        },
        "ifAtkAbove": 6,
        "thenInstead": {
          "costDelta": -1
        }
      }
    ],
    "effects": [
      {
        "trigger": "onPlay",
        "actions": [
          {
            "op": "extraAttack",
            "target": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U391",
    "name": "经济爆炸",
    "type": "spell",
    "spellKind": "item",
    "cost": 2,
    "token": true,
    "text": "在剩下的游戏时间里，你的◈+1",
    "actions": [
      {
        "op": "gainManaCap",
        "amount": 1
      }
    ]
  },
  {
    "id": "U392",
    "name": "扫地僧",
    "type": "unit",
    "cost": 3,
    "atk": 1,
    "hp": 4,
    "keywords": [],
    "text": "受到伤害:弹射本单位；打出:本单位的攻击力和防御力增加等同于本局对战中扫地僧进入战场次数的数值",
    "effects": [
      {
        "trigger": "onDamaged",
        "actions": [
          {
            "op": "bounce",
            "target": {
              "kind": "self"
            }
          }
        ]
      },
      {
        "trigger": "onPlay",
        "actions": [
          {
            "op": "modifyStats",
            "atk": {
              "perOwnEntry": 1
            },
            "maxHp": {
              "perOwnEntry": 1
            },
            "target": {
              "kind": "self"
            }
          }
        ]
      }
    ]
  },
  {
    "id": "U393",
    "name": "歼-10",
    "type": "unit",
    "cost": 8,
    "atk": 4,
    "hp": 4,
    "keywords": [
      "nimble"
    ],
    "text": "打出:抉择:获-4花费和穿透1；或+4⚔+2♥和装甲1",
    "effects": [
      {
        "trigger": "onPlay",
        "actions": [
          {
            "op": "choose",
            "prompt": "抉择（歼-10）",
            "options": [
              {
                "label": "少花 4 费，并获得穿透1",
                "actions": [
                  {
                    "op": "gainMana",
                    "amount": 4
                  },
                  {
                    "op": "grantKeyword",
                    "keyword": "pierce",
                    "x": 1,
                    "target": {
                      "kind": "self"
                    }
                  }
                ]
              },
              {
                "label": "+4⚔+2♥，并获得装甲1",
                "actions": [
                  {
                    "op": "modifyStats",
                    "atk": 4,
                    "maxHp": 2,
                    "target": {
                      "kind": "self"
                    }
                  },
                  {
                    "op": "grantKeyword",
                    "keyword": "armor",
                    "x": 1,
                    "target": {
                      "kind": "self"
                    }
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  },
  {
    "id": "U394",
    "name": "盗贼",
    "type": "unit",
    "cost": 4,
    "atk": 3,
    "hp": 4,
    "keywords": [],
    "text": "回合开始:偷取对方国王 1 币（对方下回合少 1 点费用）",
    "effects": [
      {
        "trigger": "onTurnStart",
        "actions": [
          {
            "op": "taxMana",
            "side": "opponent",
            "amount": 1
          }
        ]
      }
    ]
  },
  {
    "id": "U396",
    "name": "强化士兵",
    "type": "unit",
    "cost": 2,
    "atk": 2,
    "hp": 3,
    "keywords": [],
    "choosesTarget": true,
    "text": "拟定目标攻击；被消灭:召唤一张功勋",
    "effects": [
      {
        "trigger": "onDeath",
        "actions": [
          {
            "op": "summonToHand",
            "cardId": "U153"
          }
        ]
      }
    ]
  },
];
