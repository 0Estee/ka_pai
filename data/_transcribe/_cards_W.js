/**
 * 作者设计的卡牌 · 第三批片段 W —— **心驭阵营**（作者 2026-10-24）的五张超能力。
 *
 * ⚠️ 这五张原本是直接写在 `engine/cards/user-cards-b3.js` 里的（当时片段目录已经录完），
 *    结果是 `tools/merge-b3.mjs` 一跑就把它们静默丢掉（合并是从零重建产物）。
 *    现在把它们补成正式片段：合并既能复现完整卡池，也不会再丢卡。
 *
 * 控制机制见 docs/规则书-v0.2.md 的 D76 / D77。
 */

export const CARDS_W = [
  {
    "id": "U478",
    "name": "恶堕の催眠",
    "type": "spell",
    "spellKind": "item",
    "cost": 1,
    "faction": "heart",
    "text": "控制一名花费≤3的敌人。",
    "actions": [
      {
        "op": "control",
        "target": {
          "kind": "chosenEnemyUnit",
          "controlRoom": true,
          "filter": {
            "maxCost": 3,
            "spellTargetable": true
          },
          "prompt": "控制一名花费≤3的敌人"
        }
      }
    ]
  },
  {
    "id": "U479",
    "name": "绝对の服从",
    "type": "spell",
    "spellKind": "item",
    "cost": 1,
    "faction": "heart",
    "text": "控制一名攻击力≤2的敌人，召唤一张最强の诱惑。",
    "actions": [
      {
        "op": "control",
        "target": {
          "kind": "chosenEnemyUnit",
          "controlRoom": true,
          "filter": {
            "maxAtk": 2,
            "spellTargetable": true
          },
          "prompt": "控制一名攻击力≤2的敌人"
        }
      },
      {
        "op": "summonToHand",
        "cardId": "U480"
      }
    ]
  },
  {
    "id": "U480",
    "name": "最强の诱惑",
    "type": "spell",
    "spellKind": "item",
    "cost": 7,
    "faction": "heart",
    "token": true,
    "text": "控制一名敌人。",
    "actions": [
      {
        "op": "control",
        "target": {
          "kind": "chosenEnemyUnit",
          "controlRoom": true,
          "filter": {
            "spellTargetable": true
          },
          "prompt": "控制一名敌人"
        }
      }
    ]
  },
  {
    "id": "U481",
    "name": "人性の爱",
    "type": "spell",
    "spellKind": "attack",
    "cost": 1,
    "faction": "heart",
    "text": "选择一个单位，指定另一个单位与其战斗，抽一张牌。",
    "actions": [
      {
        "op": "duel",
        "target": {
          "kind": "chosenAnyUnit",
          "prompt": "选择第一个单位"
        },
        "second": {
          "kind": "chosenAnyUnit",
          "prompt": "指定另一个单位与其战斗"
        }
      },
      {
        "op": "draw",
        "amount": 1
      }
    ]
  },
  {
    "id": "U482",
    "name": "魔醉の臣服",
    "type": "spell",
    "spellKind": "item",
    "cost": 1,
    "faction": "heart",
    "text": "控制一名敌人并将其冻结，下个回合开始时，将其返回敌方手牌。",
    "actions": [
      {
        "op": "control",
        "freeze": true,
        "returnAtTurnStart": true,
        "target": {
          "kind": "chosenEnemyUnit",
          "controlRoom": true,
          "filter": {
            "spellTargetable": true
          },
          "prompt": "控制一名敌人"
        }
      }
    ]
  },
];
