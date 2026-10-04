# 规则引擎

手机卡牌游戏的**纯规则引擎**。零依赖，纯 JavaScript ES Module，Node 与浏览器通用。

它只负责"规则算得对不对"，不含任何界面。等你把测试卡牌给我，直接往 `engine/cards/` 里加数据就能跑对局。

---

## 快速开始

```bash
node engine/test/smoke.mjs     # 跑规则回归测试（当前 124 个）
```

```js
import * as G from './engine/src/engine.js';
import { TEST_CARD_LIB, buildTestDeck } from './engine/cards/test-cards.js';

const state = G.createGame({
  seed: 42,                 // 同种子 = 完全相同的对局，可复现
  firstPlayer: 0,           // 先手
  deck: buildTestDeck(),    // 双方共用的牌库
  cardLib: TEST_CARD_LIB,   // 卡牌定义表
});
G.startGame(state);

// 主循环
while (!G.isOver(state)) {
  const actor = G.getActor(state);          // 当前可行动的玩家，null = 非行动阶段（如开战）
  if (actor === null) { G.advance(state); continue; }

  const plays = G.getLegalPlays(state, actor);   // 合法出牌（已算好费用/地形/占位）
  if (plays.length === 0) { G.advance(state); continue; }

  const play = plays[0];
  const place = play.places[0];                  // 单位需要位置；锦囊为 null
  G.playCard(state, actor, play.iid, place ? { lane: place.lane, row: place.row } : {});
}

console.log(state.winner, state.winReason);
```

---

## 架构

模块按职责拆开，越靠下越基础。最顶上的 `engine.js`、`mechanics.js`、`effects.js` 是**门面**：
它们只做 `import` + `export` 转发，好让 `import * as G from './src/engine.js'`
这样的用法（`test/smoke.mjs` 和 `app/js/*.js` 都在用）在拆文件之后**一行都不用改**。

```
constants.js   rng.js   keywords.js                    地基：无状态，谁都能用
      ↓
board.js  ←→  damage.js   stats.js                     机制层原语
      ↓
mechanics.js  （门面）
      ↓
auras.js      setup.js    turns.js
      ↓
targets.js / amounts.js / actions.js  →  effects.js（门面）
      ↓
choices.js  ←→  combat.js
      ↓
play.js       view.js
      ↓
engine.js     （门面：状态机与公开 API）
```

⚠️ **这里不是严格单向的**：`board ←→ damage`、`choices ←→ combat`，另外
`play`/`turns`/`view` 与 `combat`/`choices` 之间也有互相引用。这是拆文件时**刻意保留**的 ——
环里**只有函数声明**，函数声明会提升，所以 ESM 与打包器都能正常工作
（打包器把所有模块拍进同一作用域，函数声明更是全局提升）。
**但往环里的文件加「加载期求值的顶层 `const X = 另一个模块的东西`」会炸（TDZ），不要这么做。**
真要判断依赖是否健康，跑 `node engine/test/smoke.mjs` —— Node 会按真实 ESM 语义链接所有模块。

| 文件 | 职责 |
|---|---|
| `src/constants.js` | 线路、排、阶段、常量开关（`DRAW_ON_FIRST_TURN` / `MAX_TURNS`） |
| `src/rng.js` | 可复现随机源。存种子即可重放整局 |
| `src/keywords.js` | 25 个词条的查询与判定；伤害修正链；目标过滤器 |
| `src/board.js` | 场地与单位：查询、站位、移动/弹射、消灭（`destroyUnit` / `vanishUnit`） |
| `src/damage.js` | 伤害与死亡结算、触发入队、冻结、伤害封顶、属性改写 |
| `src/stats.js` | 词条的授予/剥夺、抽牌、法力 |
| `src/mechanics.js` | **门面**：把 board / damage / stats 合成原来那一层 API |
| `src/auras.js` | 光环：不写进单位数值，读取时叠加。来源离场 / 条件变化立刻失效 |
| `src/setup.js` | 建局：`createGame` / `makePlayer` / `makeBoard` / `instantiateUnit` |
| `src/turns.js` | 回合与阶段：`startGame` / `enterPhase` / `advance` / 终局判定 / 手牌内被动 |
| `src/targets.js` | 目标选择器解释（`resolveTargets`） |
| `src/amounts.js` | 数值表达式与条件求值（`resolveAmount` / `evalCondition`） |
| `src/actions.js` | 效果动作解释（`execActions` / `execAction`，每个 op 一个 case） |
| `src/effects.js` | **门面**：卡牌效果 DSL |
| `src/choices.js` | 交互挂起（generator 驱动）与触发队列 |
| `src/factions.js` | 阵营与超能力：开局抽牌、国王血量阈值抽牌、延迟召唤（作者 2026-10-03） |
| `src/combat.js` | 开战结算与召唤接口 |
| `src/play.js` | 出牌与合法性（`costOf` / `getLegalPlays` / `playCard`） |
| `src/view.js` | 视图（`viewFor` / `renderBoard`） |
| `src/engine.js` | **门面**：回合流程、开战结算、合法性校验、胜负判定 |
| `cards/user-cards.js` | ★ **作者设计的卡牌** 第二批（U01~U17） |
| `cards/user-cards-b3.js` | ★ **作者设计的卡牌** 第三批（U20~U402，由 `tools/merge-b3.mjs` 从 A~M 十三组片段合并生成） |
| `cards/test-cards.js` | 引擎自检用的演示卡 + 合并后的卡牌库 + 牌库构建（从全部卡里按种子抽 80 张） |

> **为什么光环要单独一层？** 永久加成（吸血鬼的 +1/+1）直接写进 `unit.atk` 就对了。
> 但光环不同 —— 拷问官一死，-3 攻必须立刻消失；密命王牌旁边一有队友，+3 攻必须立刻消失。
> 如果也直接改数值，就得在每次棋盘变动时「撤销上一次、再重新加上」，漏一个时机就永久错值。
> 所以 `unit.atk` 永远只存永久值，需要真实数值时调 `effectiveAtk(state, unit)` 现场叠加。
> **交战、伤害计算、界面、AI 都必须用 `effectiveAtk`，不能直接读 `unit.atk`。**

---

## 公开 API

| 函数 | 说明 |
|---|---|
| `createGame(cfg)` | 建局。`cfg = { seed, firstPlayer, deck, cardLib, shuffleDeck, factions }` |
| `startGame(state)` | 发起手牌并进入第 1 回合 |
| `advance(state)` | 推进到下一阶段；`TURN_END` 之后自动开下一回合 |
| `sacrificeUnit(state, side, uid)` | 献祭己方场上的一个单位（算作被消灭；恶魔阵营的献祭按钮走它） |
| `getActor(state)` | 当前可行动的玩家 side（0=先手 / 1=后手），非行动阶段返回 `null` |
| `getLegalPlays(state, side)` | 合法出牌列表，含每个单位的所有合法落点 |
| `playCard(state, side, iid, opts)` | 出牌。`opts = { lane, row, targetUid, choices }` |
| `legalPlacements(state, side, def)` | 某张单位牌的所有合法落点 |
| `isOver(state)` / `state.winner` | 对局是否结束 / `0` / `1` / `'draw'` |
| `viewFor(state, side)` | 某一方视角的状态快照（隐藏对手手牌） |
| `renderBoard(state)` | 调试用：打印一张 ASCII 战场图 |
| `resolveChoice(state, choice)` | 回答引擎抛出的选择请求 |

### 交互式选择（generator 挂起）

当某个效果需要玩家做选择（选目标 / 选线路）时，引擎会挂起并写进 `state.pending`：

```js
state.autoResolveChoices = true;   // 默认：自动选第一个合法项（AI / 模拟用）

// 要接 UI 就关掉它：
state.autoResolveChoices = false;
G.playCard(state, 0, iid, {});
if (state.pending) {
  console.log(state.pending.request.prompt);      // "选择伤害目标"
  console.log(state.pending.request.options);     // [{uid, label}, ...]
  G.resolveChoice(state, { uid: 7 });             // 恢复执行
}
```

**挂起发生在哪几处：**

| 情形 | 挂起点 | 自动代答时的口径 |
|---|---|---|
| 「抉择」（歼-10） | `choose` op，效果打到一半 | 取第一个选项 |
| 「拟定目标攻击」（强化士兵） | **开战结算轮到它出手时** | 按 `state.targetPicker` 算一个 |

「拟定目标攻击」这条有两个和上面那套**不一样**的地方，改它之前务必读懂：

1. **它可以挂在 `enterPhase('COMBAT')` 里面。** 开战结算因此是一条 generator 链
   （`runCombat → resolveLane → applyAttackBatch → collectAttackEvents`），
   由 `enterPhase` 用 `driveGenerator` 驱动。挂起时阶段**停在 `COMBAT`**，
   玩家答完由 `resolveChoice` 接着把这条链跑完 —— 所以 `advance()` 在挂起期间
   会（也应该）抛「存在待处理的交互请求」。
2. **它拒绝被自动代答。** 请求上带 `noAuto: true` 时，`takeChoice` 直接返回
   `PENDING`，不看 `autoResolveChoices`。判据是 `state.humanSide`
   （「这一方是不是真人」），**不是** `autoResolveChoices`
   —— 后者是「这一局有没有人在点」的全局事实，用它管一只具体单位的问询，
   会让回放与联机锁步分叉。

**`humanSide` 怎么用：**

| 值 | 含义 | 谁这么用 |
|---|---|---|
| `0` / `1` | 这一方是真人，它的强化士兵会**挂起等人答** | 正常对局（`app/js/game-flow.js` 的 `newGame` 设成 `me()`） |
| `-1` | **没有真人**，两侧都由引擎策略自己决策 | `__autoPlay` / `__playTurns` / `tools/balance-check.mjs` / 回放播放器 / 锁步自检 |

不设也行：默认按 `0` 处理（规则测试就是「0 号是真人」的口径）。
⚠ AI 的强化士兵**必须**走 `-1` 或非真人侧那条路 —— 否则没人会去答它的请求，整局卡住。

---

## 如何写卡牌

全部卡牌数据放一个文件里即可，引擎代码不用动。见 `cards/test-cards.js` 的完整注释。

### 单位

```js
{
  id: 'U001',
  name: '铁甲卫士',
  type: 'unit',
  cost: 2,
  atk: 2,
  hp: 4,
  keywords: ['armor:1'],            // 见下方词条 id 表
  effects: [                        // 触发式异能（可选）
    { trigger: 'onPlay',      actions: [ /* ... */ ] },
    { trigger: 'onDeath',     actions: [ /* ... */ ] },
    { trigger: 'onDealDamage', actions: [ /* ... */ ] },
  ],
}
```

`keywords` 支持三种写法：`'armor:1'`、`'aquatic'`、`{ id: 'armor', x: 1 }`。

### 锦囊

```js
{
  id: 'S001',
  name: '火球术',
  type: 'spell',
  spellKind: 'attack',              // 'attack' | 'item'，只影响图标
  cost: 2,
  actions: [
    { op: 'damage', amount: 3,
      target: { kind: 'chosenEnemyUnit', filter: 'spellTargetable', prompt: '选择伤害目标' } },
  ],
}
```

锦囊效果结算后自动进入弃牌堆。

### 词条 id 表

| id | 卡面名 | 参数 | 说明 |
|---|---|---|---|
| `doubleStrike` | 双重打击 | — | 交战存活后额外攻击一次 |
| `frenzy` | 狂热 | — | 交战击杀且存活后额外攻击一次 |
| `disease` | 疾病 | — | 造成伤害后标记，目标下回合开始被消灭 |
| `armor` | 装甲X | X | 受到伤害减少 X |
| `thorns` | 荆棘X | X | 受伤时对来源造成 X 点伤害 |
| `blessing` | 祝福X | X | 受到伤害封顶为 X |
| `aquatic` | 水生 | — | 只能放在水路（**移动同样受此限制**，见裁决 D63） |
| `amphibious` | 两栖 | — | 可以放在水路，也可以移动进出水路 |
| `nimble` | 轻灵 | — | 血量 ≥ 上限一半时获得两栖，否则失去；在水路失去时被消灭 |
| `spellImmune` | 锦囊免疫 | — | 不能成为锦囊目标 |
| `crit` | 暴击X | X | 50% 几率额外造成 X 点伤害 |
| `rooted` | 扎根 | — | 无法被弹射 |
| `invincible` | 无敌 | — | 免疫伤害与弹射；**不免疫"消灭"** |
| `combo` | 组合 | — | 解锁该线路第 2 个身位 |
| `splash` | 溅射X | X | 攻击时对相邻线路所有敌方单位（含后排）造成 X 点伤害 |
| `poison` | 淬毒X | X | 造成伤害后标记，目标下回合开始受 X 点（无视装甲/祝福） |
| `pierce` | 穿透X | X | 主要目标之外额外命中本线路 X 个敌方单位（含后排）；缺口溢出一次攻击力给国王；空线路不重复加伤 |
| `firstStrike` | 先制 | — | 开战时伤害先结算，被打死的敌人当回合不反击（卡面写作「这张牌在开战时优先攻击」） |
| `freeze` | 冻结 | — | **状态型**：被冻结的单位下一次攻击不进行并解除冻结。不是印在卡面上的词条 |
| `hunt` | 捕猎 | — | 有敌方单位被打出时，若可能则移动到那条线路；多个捕猎按 山地→水路 的优先级依次移动 |
| `trueStrike` | 必中 | — | 攻击时忽略敌方单位阻挡、**仅攻击国王**，且伤害不可被免疫（连无敌也挡不住） |
| `rebirth` | 复生 | — | 被消灭后**回满血**在原处复活一次并失去复生；不触发「被消灭:」异能，也不触发国王被动 |
| `fuse` | 融合进化 | — | 可以在一个友方单位**现在的位置**上打出：那个单位「消失」（不触发任何被消灭效果），新单位顶替它 |

> ⚠️ 卡面上的 **`⚔` 和 `◈` 都是攻击力**（作者确认），`♥` 是生命。
> 卡面可能把「轻灵」写成旧名 **「飞行」** —— 那是同一个词条，用 `nimble`。

### 光环（卡牌定义的 `auras` 字段）

光环不是效果动作，写在与 `keywords` / `effects` 平级的 `auras` 数组上。

```js
// 拷问官：本条线上的敌人获得扎根；场上所有扎根的敌人 -3 攻
auras: [
  { kind: 'grantKeyword', keyword: 'rooted', to: 'laneEnemies' },
  { kind: 'buffAtk', amount: -3, to: 'rootedEnemies' },
]

// 密命王牌：场上没有队友时 +3 攻
auras: [
  { kind: 'buffAtk', amount: 3, to: 'self', condition: 'noOtherAllies' },
]
```

| 字段 | 取值 |
|---|---|
| `kind` | `buffAtk`（改攻击力，`amount` 可为负）/ `grantKeyword`（授予词条） |
| `to` | `self` / `laneEnemies` / `laneAllies` / `laneBackRowAllies`（同线路**后排**友军，不含自己）/ `selfAndAdjacentLaneAllies`（自己和相邻线路的队友，含自己）/ `rootedEnemies` |
| `condition` | 可选。`'noOtherAllies'` = 自己棋盘上没有其他友方单位；`{ hpAbove: N }` / `{ hpAtLeast: N }` = 自身生命阈值 |

授予类光环（`grantKeyword`）不能用 `rootedEnemies` 作对象，否则会和「扎根敌人减攻」互相递归 —— 引擎会直接抛错。

### 效果动作（`op`）

| op | 参数 |
|---|---|
| `damage` | `amount`, `target` |
| `destroy` | `target` |
| `sacrifice` | `target`（不可献祭自身） |
| `draw` | `amount`, `side` |
| `gainMana` / `gainManaCap` | `amount`, `side` |
| `heal` | `amount`, `target`；`mode: 'halfLost'` = 回复已损失生命的一半（国王） |
| `buffAtk` / `buffMaxHp` | `amount`（可为负）, `target` |
| `modifyStats` | `atk`, `maxHp`, `target` —— 一次动作同时改攻防，**目标只选一次**（「骨折」） |
| `attachKingEffect` | `effects:[{trigger,actions}]` —— 给国王挂永久被动（「战略纵深」） |
| `summon` | `cardId`, `lane`, `row`, `side` —— 召唤到**场上**（免费打出，触发打出效果） |
| `summonToHand` | `cardId`, `count`, `side` —— 召唤到**手牌**（下划线「召唤」用这个） |
| `bounce` | `target` —— **弹射 = 退回其拥有者手牌**（「扎根」挡得住）。不算被消灭 |
| `move` | `target`, `lane`（不写就现场问玩家）—— 移动（「捕猎」用的同一套原语） |
| `freeze` | `target` —— 冻结 |
| `discard` | `amount`, `side` —— 弃置手牌 |
| `grantKeyword` | `keyword`, `x`, `target` —— 永久授予词条（「狂犬病」） |
| `stealToHand` | `target` —— 把敌方单位置入我的手牌（「战时盟国」，不算被消灭） |
| `setStats` | `hp`, `maxHp`, `atk`, `target` —— **设为固定值**（「永恒秘典」），与 `modifyStats`（加减）不同 |
| `transform` | `cardId`, `target` —— **就地变成另一张牌**（「魔术师」→ 令牌[兔子]）：名字/卡 id/攻血/词条/异能全换、加成重置、不算重新进场、保留封印 |
| `seal` | `target` —— 封印目标（effects 停、**词条也停**、它自己的光环与它吃到的光环全停；只留 ⚔ 与 ♥）。见裁决 D62 |
| `extraAttack` | `target` —— **立刻**再用该单位打一次（「咖啡豆」）。每单位每回合仍只一次 |
| `returnToDeck` | `from:'hand'\|'board'`, `to:'top'\|'shuffle'`, `count?`, `cardFilter?` —— 放回牌堆 |
| `modifyHandCost` | `amount`, `cardFilter?`, `side?` —— 改**手牌实例**的费用，可叠加 |
| `lockLane` | `lane` 或 `lanes`, `turns` —— 封锁线路，期间不能放置单位（「氢弹」） |
| `discardDrawn` | `side` —— 弃掉刚抽到的那几张牌（「希佩尔」） |

**动态数值**：`amount` 可以是 `{ perOwnUnit: 2 }`（己方场上单位数 ×2）、`{ perAllUnits: 1 }`（场上双方单位总数）、
`{ perKeywordOfTarget: 1 }`（目标的词条数）。「队友」= 自己场上，「单位」= 场上双方（裁决 D29/D42）。

**卡牌级开关**：`attackWithHp: true` = 这一击用**当前生命**当伤害基数（「武术大师」）。不是词条，是这张牌自己的攻击口径。
**第四 ~ 十一轮又补的 op**：`choose`（抉择，反问玩家）、`untargetable`（无法选中）、
`cycleStats`（依次变为）、`capDamage`（伤害封顶一回合）、`conditional`（条件分支，`if.compare`）、
`taxMana`（对方下回合少 N 费）、`seal`（封印）、`lockLane`（线路封锁）、`discardDrawn`。

**卡牌级开关**（不是词条，写在卡定义上）：
`attackWithHp` · `bypassInCombat`（不挡枪，蜜蜂）· `bodyguard`（替后排挨打，伪装土堆）·
`choosesTarget`（开战时由玩家指定目标，强化士兵）· `inHand`（在手牌中:在你出牌时，黑龙）。

**`bounce` 的 `preserveStats:true`** —— 回手后保留加成（扫地僧）。
**`damage` 的 `asAttack:true`** —— 这次伤害算作攻击，从而吃溅射（橄榄球）。
**光环**：新增 `to:'allEnemies'`、`to:'laneBackRowAllies'`，以及 `{kind:'seal'}` 封印光环（大封印碑，离场即解封）。

### 目标选择器（`target.kind`）

`self` · `ownKing` · `enemyKing` · `chosenEnemyUnit` · `chosenOwnUnit` · `chosenEnemyFront` · `chosenEnemyTarget` · `allEnemyUnits` · `allOwnUnits` · `allUnits` · `allEnemyUnitsInLane` · `allUnitsInLane` · `allLanesEnemyUnitsInLane` · `adjacentEnemyUnits` · `lowestHpEnemyUnit` · `triggerVictim`

`allUnits` = **双方**场上所有单位（「灭世：消灭场上所有单位」）。

`triggerVictim` 用于「有敌人受到伤害时，**对其**造成 X 点伤害」—— 目标来自触发事件的 payload，不需要玩家选择。

### 目标限定条件（`target.filter`）

`filter` 可以缩小可选目标范围。**引擎、AI、界面共用同一个过滤器**（`keywords.js` 的
`matchesTargetFilter`），所以界面高亮的目标一定能打出、AI 也不会选出非法目标。

```js
filter: 'spellTargetable'                     // 旧写法，等价于下面第一个
filter: { spellTargetable: true }             // 排除带「锦囊免疫」的单位
filter: { maxAtk: 2 }                         // 攻击力 ≤ 2   ← 「滚石」用这个
filter: { minAtk: 3 }
filter: { maxHp: 4 } / { minHp: 2 }
filter: { row: 'front' } / { row: 'back' }     // 只能选前排 / 后排
filter: { lane: 'water' }                     // 只能选水路
filter: { keyword: 'amphibious' }             // 必须拥有某词条
filter: { damaged: true }                     // 受伤（当前生命 < 生命上限）← 「斩杀」用这个
filter: { undamaged: true }                   // 未受伤
filter: { rooted: true }                      // 带「扎根」（含光环授予的）
filter: { maxAtk: 2, spellTargetable: true }  // 多个条件同时满足
```

`maxAtk` / `minAtk` / `rooted` 用的是**有效值**（含光环）—— 被拷问官减到 2 攻的敌人，
`滚石`（⚔≤2）就能砸掉它。这一点引擎、AI、界面三处都一致。

### 触发式异能的触发名（`effects[].trigger`）

| trigger | 时机 |
|---|---|
| `onPlay` | 该单位进入战场时。payload 带 `fused`（是否用融合进化打出） |
| `onEnterLane` | 进入一条线路时 —— **打出和移动都算**（「抱脸虫」） |
| `onDeath` | 该单位被消灭时 |
| `onDealDamage` | 该单位造成 > 0 伤害时（含打国王） |
| `onDamaged` | 该单位**受到**伤害时。payload 带 `amount`（「红火蚁」） |
| `onEnemyDamaged` | **任意**敌方单位受到伤害时（不限于本单位造成的）。payload 带 `victim` |
| `onTurnStart` | 每回合开始时（排在标准抽牌之后）（「第5伞兵旅」） |
| `onUnitBounced` | 场上有单位被弹射时。payload 带 `bounced` / `bouncedSide`（「跳杆运动员」） |
| `onFriendlyUnitDestroyed` | 国王被动专用：自己的单位被消灭时 |
| `onCombatStart` | **逐线路**开战结算之前（「狙击手」；它的一发伤害用 `chosenEnemyTarget` + `askHuman: true` 让真人点，见裁决 D71）。payload `{ lane }` |
| `onKill` | 本单位消灭了敌方单位（「无双剑豪」）。payload `{ victim }` |
| `onAllyPlayed` | **友方**单位被打出（「人间大炮」）。payload `{ played }` |
| `onEnemyCastSpell` | 对方打出**锦囊**（「拳击手」「苍耳」）。payload `{ cardId, cardName, casterSide }` |
| `onOpponentDraw` | 对方抽牌（「希佩尔」）。payload `{ drawerSide, cards }` |
| `onAnyUnitDestroyed` | 全场**任何**单位被消灭（「卫兵」）。payload `{ victim, reason }` |
| `onAllyExtraAttack` | **友方**单位额外攻击了一次（「派对客」）。payload `{ attacker }` |

`effects[]` 的附加字段：

- `when: 'fused'` —— 只有用**融合进化**打出时才发动
- `when: { lane: 'mountain' }` —— 只在指定地形落点时发动（「登山员」）
- `when: { deathsAtLeast: 4 }` —— 全场累计被消灭数 ≥ N 时（「卫兵」）
- `repeat: 'damageAmount'` —— 按本次伤害点数重复触发（「红火蚁」）

`effects[]` 还支持两个附加字段：

- `when: 'fused'` —— 只有**用融合进化打出**时才发动（「霸王龙：融合进化这张牌获得双重打击」）
- `repeat: 'damageAmount'` —— 按本次伤害点数重复触发（「红火蚁：每扣除1♥，便对指定单位造成1点伤害」）

两个防死循环护栏（都写死在引擎里，制卡时不用管）：

- 由 `onDealDamage` / `onEnemyDamaged` / `onDamaged` 异能**自己造成的伤害**，不再触发对应的触发时机。

### 国王作为目标

**回复**国王生命用 `ownKing` / `enemyKing`（上限 20）：

```js
{ op: 'heal', amount: 1, target: { kind: 'ownKing' } }   // ← 「蚊子」用这个
```

**指向**国王（或"单位或国王"二选一）用复合选择器 `chosenEnemyTarget`：

```js
// 卡面只写「造成X点伤害」而不限定目标时，可以选择国王作为目标（作者裁决 D16）
{ op: 'damage', amount: 2,
  target: { kind: 'chosenEnemyTarget', filter: { spellTargetable: true } } }

// allowKing: false → 只留单位，不允许打国王
target: { kind: 'chosenEnemyTarget', allowKing: false }
```

界面上这个目标表现为"顶部/底部血条里的国王可以点"，构建产物里的
`__demoKingTarget()` 就是用来验证这条链路的。

`filter` 只作用于单位 —— 国王不是单位，没有攻击力/词条，所以过滤器不会挡住国王。

`造成伤害:` 异能**对国王造成伤害时也会触发**（规则书 §1，作者确认）。
但 `淬毒` / `疾病` 仍只对单位生效 —— 它们需要给目标挂标记，而国王不是单位。

---

## 已实现的规则

对应 `docs/规则书-v0.2.md`，**124 个测试**逐条覆盖：

- 共享牌库、起手 5/4、回合开始后手先抽
- 费用上限 = 回合数、费用共享、费用上限增长
- 4 路 × 5 排战场、每路默认 1 个身位、`组合` 解锁第 2 个
- 地形限制（水生 / 两栖 / 轻灵）—— **放置与移动共用同一套判定**（裁决 D63）
- 开战：线路按 山地→平地(左)→平地(右)→水路 依次、同线路内同时结算
- 交战目标优先级 **前排 → 后排 → 国王**：前排是掩护，前排清空后后排会被普通攻击命中
- `溅射` / `穿透` 可以越过前排直接打到后排
- `穿透X`：主要目标之外额外命中 X 个，缺口溢出一次攻击力给国王
- `先制`：先单独结算一批，被打死的敌人当回合不反击
- 受伤修正链：**祝福封顶 → 装甲减伤 → 荆棘按最终伤害反弹**
- 全部 19 个词条
- 打出 / 被消灭 / 造成伤害 / 有敌人受到伤害 / 友方单位被消灭 五类异能
- 光环（拷问官授予扎根并减攻、密命王牌孤立加攻）—— 读取时叠加，离场即失效
- 国王附着被动（战略纵深）、数值修改（骨折）、受伤过滤器（斩杀）
- 胜负判定：国王归零、同时归零平局、30 回合上限、牌库抽空比血量
- 阵营与超能力（恶魔 / 上帝）：开局各抽 1 张、国王血量 15/9/3 阈值各一张；「令」字是令牌，不进抽取池
- 召唤时选落点（裁决 D73）：`summon` / `delayedSummon` 没写死落点时挂起 `{ type: 'summonCell', side, options }`，
  答案就是选项本身（`{ lane, row }`）；AI 侧取第一个合法格，界面是不遮棋盘的底部条

## 仍未实现 / 待你裁决

| 项 | 状态 |
|---|---|
| 陷阱系统 | 结构已预留（`board[lane].traps`），v0.2 不启用 |
| 「移动」机制 | 规则书未定义，引擎遇到 `move` / `bounce` 会明确抛错而非静默失败 |
| 「弹射」机制 | 同上。`扎根` 目前只挡弹射，而弹射还没实现，所以 `扎根` 暂时只影响 `拷问官` 的减攻判定 |
| 「有敌人受到伤害时」是否含国王 | 当前**不含**（裁决 D21）。想让怨魂也能追击国王，改 `mechanics.js` 的 `notifyDamageWatchers` 一处 |
| 卡组构筑界面 | 不做，使用固定预组 |
| 陷阱格的 `renderBoard` 显示 | 已显示为空位 |

## 可调开关

`src/constants.js` 里几行，改一行即可换口径：

- `DRAW_ON_FIRST_TURN`（默认 `true`）：第 1 回合是否也各抽 1 张。设为 `false` 则起手严格保持 5/4。
- `KING_MAX_HP`（默认 20）：国王生命上限，也是治疗的封顶值。
- `MAX_TURNS`（默认 30）：超过后按国王血量判胜负。
