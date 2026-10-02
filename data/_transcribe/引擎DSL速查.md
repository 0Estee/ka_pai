# 引擎 DSL 速查（录卡用）

> 录卡时**只允许**用下面列出的能力。卡面要求的东西如果不在表里，**不要硬凑**，
> 把它记进「第二批待做」，不要写进 `user-cards.js`。

## 卡牌定义字段

```js
// 单位
{
  id: 'U18', name: '卡名', type: 'unit', cost: 3, atk: 2, hp: 3,
  keywords: ['frenzy', 'armor:1', { id: 'pierce', x: 2 }],   // 三种写法都行
  text: '卡面效果原文',        // 界面直接显示；词条名不用重复写
  effects: [ { trigger: 'onPlay', actions: [...] } ],
  auras:   [ { kind: 'buffAtk', amount: 1, to: 'self' } ],
  token: true,               // 只给「令」牌用：不进牌库
}
// 锦囊
{
  id: 'U19', name: '卡名', type: 'spell', spellKind: 'attack' | 'item', cost: 2,
  text: '...', actions: [ { op: 'damage', amount: 2, target: {...} } ],
}
```

`cost` / `atk` / `hp` 必须是数字。**卡面空白的数字由作者补齐**，见 `作者裁定与补数.md`。

## 词条 id（`keywords` 里用 id，不是中文名）

| id | 卡面名 | 参数 |
|---|---|---|
| `doubleStrike` | 双重打击 | — |
| `frenzy` | 狂热 | — |
| `disease` | 疾病 | — |
| `armor` | 装甲 | X |
| `thorns` | 荆棘 | X |
| `blessing` | 祝福 | X |
| `aquatic` | 水生 | — |
| `amphibious` | 两栖 | — |
| `nimble` | 轻灵 | — |（**卡面可能写旧名「飞行」，就是这个词条**）|
| `spellImmune` | 锦囊免疫 | — |
| `crit` | 暴击 | X |
| `rooted` | 扎根 | — |
| `invincible` | 无敌 | — |
| `combo` | 组合 | — |
| `splash` | 溅射 | X |
| `poison` | 淬毒 | X |
| `pierce` | 穿透 | X |
| `firstStrike` | 先制 | — |
| `freeze` | 冻结 | — |（状态，一般不用写在卡上）|
| `hunt` | 捕猎 | — |
| `trueStrike` | 必中 | — |
| `rebirth` | 复生 | — |
| `fuse` | 融合进化 | — |

## 效果动作（`op`）

| op | 参数 | 说明 |
|---|---|---|
| `damage` | `amount`, `target` | 造成伤害 |
| `destroy` | `target`, `reason?` | 消灭 |
| `bounce` | `target` | **弹射 = 退回拥有者手牌**（扎根挡得住） |
| `move` | `target`, `lane?` | 移动；`lane` 不写就现场问玩家 |
| `freeze` | `target` | 冻结 |
| `heal` | `amount`, `target`；`mode:'halfLost'` | 治疗（国王上限 20） |
| `buffAtk` / `buffMaxHp` | `amount`, `target` | 永久改数值 |
| `modifyStats` | `atk`, `maxHp`, `target` | **一次动作同时改攻防、只选一次目标**（骨折那种）|
| `grantKeyword` | `keyword`, `x?`, `target` | 永久授予词条 |
| `draw` | `amount`, `side` | 抽牌 |
| `discard` | `amount`, `side` | 弃手牌 |
| `gainMana` / `gainManaCap` | `amount`, `side` | 费用 |
| `sacrifice` | `target` | 献祭（不可献祭自身）|
| `attachKingEffect` | `effects:[{trigger,actions}]` | 给国王挂永久被动 |
| `summon` | `cardId`, `lane`, `row`, `side?` | 召唤到**场上**（免费打出，触发打出效果）|
| `summonToHand` | `cardId`, `count?`, `side?` | 召唤到**手牌**（卡面「召唤」带下划线时用这个）|
| `stealToHand` | `target` | 把敌方单位置入我的手牌（不算被消灭）|

## 目标选择器（`target.kind`）

| kind | 说明 |
|---|---|
| `self` | 自己（仅单位异能可用） |
| `ownKing` / `enemyKing` | 国王 |
| `chosenEnemyUnit` | 点选一个敌方单位 |
| `chosenOwnUnit` | 点选一个友方单位 |
| `chosenEnemyTarget` | 敌方单位**或敌方国王**；`allowKing:false` 关掉打国王 |
| `chosenEnemyFront` | 点选敌方前排 |
| `allEnemyUnits` / `allOwnUnits` / `allUnits` | 全场批量（`allUnits` = 双方） |
| `allEnemyUnitsInLane` | 触发语境下 = **来源所在线路**的敌方单位 |
| `adjacentEnemyUnits` | 来源所在线路的**相邻线路**敌方单位 |
| `triggerVictim` | 触发事件里的受害者（「有敌人受到伤害时，对其…」）|

**不需要玩家选择的选择器**（`self`/`ownKing`/`enemyKing`/`allOwnUnits`/`allEnemyUnits`/`allUnits`/`triggerVictim`）
已经登记在 `app/js/play-input.js` 的 `NO_CHOICE_TARGET_KINDS` 里（原先在 `main.js`，2026-09 拆文件时搬过去了）。**新增这类选择器时必须同步登记**，否则那张牌在手里永远灰着。
`tools/check-bundle.mjs` 有一条断言会**按锚点字符串在源码里找这两个函数**（不写死路径），漏登记会直接报错。

## 目标过滤器（`target.filter`）

`{ spellTargetable: true }`（排除锦囊免疫）、`{ maxAtk: 2 }`、`{ minAtk: 4 }`、`{ maxHp: 3 }`、`{ minHp: 2 }`、
`{ row: 'front'|'back' }`、`{ lane: 'water' }`、`{ keyword: 'amphibious' }`、
`{ damaged: true }`、`{ undamaged: true }`、`{ rooted: true }`。

多个条件同时满足；`maxAtk`/`minAtk`/`rooted` 用**有效值**（含光环）。
过滤器里**没有**「生命最低」「攻击力≥X 里挑最大」这类**排序/择优**语义 —— 那些要靠 `chosenEnemyTarget` 让玩家点。

选择器上还可以加 **`askHuman: true`**：这一问若由**真人自己**的单位发起，就不要被自动代答，而是挂起等人点。
判据是 `ctx.controller === (state.humanSide === undefined ? 0 : state.humanSide)`，**不是** `autoResolveChoices`
（自动阶段那个开关一直是 true）。命中时请求带 `noAuto: true`，走「强化士兵」同一条挂起协议。
目前只有狙击手 U287 用了它（`chosenEnemyTarget` + `askHuman`，见裁决 D71）。

## 触发时机（`effects[].trigger`）

| trigger | 时机 | payload |
|---|---|---|
| `onPlay` | 进入战场时 | `{ fused }` |
| `onEnterLane` | 进入一条线路（打出**和**移动都算，作者裁决） | `{ from, lane }` |
| `onDeath` | 被消灭时 | `{ reason }` |
| `onDealDamage` | 本单位造成 >0 伤害（**含打国王**） | `{ victimUid, toKing, amount }` |
| `onDamaged` | 本单位受到伤害 | `{ amount, sourceUid }` |
| `onEnemyDamaged` | **任意**敌方单位受伤 | `{ victim }` |
| `onTurnStart` | 每回合开始（在标准抽牌之后） | `{ turn }` |
| `onUnitBounced` | 场上有单位被弹射 | `{ bounced, bouncedSide }` |
| `onFriendlyUnitDestroyed` | 只给国王被动用 | `{ unit, reason }` |

`effects[]` 还支持两个附加字段：
- `when: 'fused'` —— 只有**用融合进化打出**时才发动（霸王龙）
- `repeat: 'damageAmount'` —— 按本次伤害点数重复触发（红火蚁「每扣除1♥」）

## 光环（`auras`）

```js
{ kind: 'buffAtk', amount: -3, to: 'rootedEnemies' }
{ kind: 'grantKeyword', keyword: 'rooted', to: 'laneEnemies' }
{ kind: 'buffAtk', amount: 1, to: 'selfAndAdjacentLaneAllies' }   // 自己和相邻线的队友
{ kind: 'buffAtk', amount: 3, to: 'self', condition: { hpAbove: 2 } }  // ♥>2 时
```

| 字段 | 取值 |
|---|---|
| `kind` | `buffAtk` / `grantKeyword` |
| `to` | `self` / `laneEnemies` / `laneAllies` / `selfAndAdjacentLaneAllies` / `rootedEnemies` |
| `condition` | 省略 / `'noOtherAllies'` / `{ hpAbove: N }` / `{ hpAtLeast: N }` |

⚠️ 光环**不能**直接改 `unit.atk`；所有读攻击力的地方都走 `effectiveAtk`。
授予类光环（`grantKeyword`）不能用 `rootedEnemies` 当对象（会无限递归，引擎会抛错）。

## 防死循环护栏（写死的，制卡不用管）

- `onDealDamage` 异能自己造成的伤害不再触发「造成伤害时」词条
- `onEnemyDamaged` 观察者自己造成的伤害不再惊动其他观察者
- `onDamaged` 异能自己造成的伤害不再触发「受到伤害时」

## 卡面符号约定（作者确认）

- `⚔` 和 `◈` **都是攻击力**
- `♥` 是生命
- 下划线**独占一行** = 词条；出现在句子里 = 引用该词条

---

# 附录：第二批新增能力（2026-09，作者第二批卡的补充）

## 动态数值（`amount` 不再是裸数字）

```js
{ op:'damage', amount:{ perOwnUnit: 2 } }          // 己方场上单位数 × 2（力量光波）
{ op:'buffAtk', amount:{ perAllUnits: 1 } }        // 场上**双方**单位总数 × 1（石中剑）
{ op:'draw', amount:{ perKeywordOfTarget: 1 },     // 目标的词条数 × 1（第3补给营）
  target:{ kind:'chosenEnemyUnit' } }
{ op:'draw', amount:{ perKeywordOfTarget:{ id:'combo', per:1 } } }  // 只看某个词条
{ op:'modifyStats', atk:{ perOwnEntry: 1 }, maxHp:{ perOwnEntry: 1 },
  target:{ kind:'self' } }                         // 本局**这张牌**进场的次数 × 1（扫地僧）
{ op:'summonToHand', cardId:'U38',
  modify:{ costDelta:{ sourceCostDelta: true, plus: 1 } } }  // 来源的费用修正 +1（僵尸）
{ op:'damage', amount:{ fixed: 3 } }               // 常数（等价于写 3）
{ op:'damage', amount:{ perOwnUnit: 1, plus: 2 } } // 任何表达式后面再加常数
```
`damage / heal / buffAtk / buffMaxHp / modifyStats / setStats / draw / summonToHand / modifyHandCost` 都支持。
**「队友」= 自己场上；「单位」= 场上双方**（沿用裁决 D29 的口径）。

| 表达式 | 含义 |
|---|---|
| `{ perOwnEntry: N }` | **本局这张牌（来源单位的 cardId）进入战场的次数** × N。各方各算自己的（裁决 D60）；计数在 `instantiateUnit` 里自增，所以「打出」异能结算时**本次进场已经算进去** —— 第 1 次打出就是 ×1 |
| `{ sourceCostDelta: true }` | 来源单位当初从手牌打出来时，手牌上挂着多少**费用修正**（`unit.paidCostDelta`，`playCard` 里记的）。僵尸换代继承花费靠它 |
| `{ plus: N }` | 在**其它表达式**的结果上加常数。裸数字不能用它（要写就直接写相加后的数） |

## 新增 op

| op | 参数 | 说明 |
|---|---|---|
| `extraAttack` | `target` | **立刻**再用该单位打一次（咖啡豆/狂犬病/黑龙）。每单位每回合仍只一次（B10）；会触发「有队友额外攻击时」 |
| `seal` | `target` | 封印目标的**一切特殊效果**（effects 停、**词条也停**、它自己的光环与它吃到的光环全停；只留 ⚔ 与 ♥）。见裁决 D62 |
| `returnToDeck` | `from:'hand'\|'board'`, `to:'top'\|'shuffle'`, `cardFilter?` | 把牌放回牌堆（回收/利奥波德）。`cardFilter:{type:'unit'\|'spell', spellKind:'item'\|'attack'}` |
| `modifyHandCost` | `amount`, `cardFilter?`, `side?` | 改手牌费用（神秘礼物/僵尸）。作用在**手牌实例**上，可叠加 |
| `setStats` | `hp`, `maxHp`, `atk`, `target` | 把数值**设为固定值**（永恒秘典「♥变为4」）。与 `modifyStats`（加减）不同 |
| `transform` | `cardId`, `target` | **就地变成另一张牌**（魔术师→令牌[兔子] U329）。名字/卡 id/攻血/词条/异能全换、加成重置、不算重新进场、位置与 `sealed` 保留。见裁决 D64 |

## 新增目标选择器

| kind | 说明 |
|---|---|
| `lowestHpEnemyUnit` | **生命最低**的敌方单位，引擎自动挑（平手取 uid 最小）。不需要点选（鲸鲨） |

## 新增触发时机

| trigger | 时机 | payload |
|---|---|---|
| `onCombatStart` | **逐线路**开战结算之前（狙击手「开战时」、游击队「开战回合」） | `{ lane }` |
| `onKill` | 本单位消灭了敌方单位（无双剑豪「消灭敌人:」） | `{ victim }` |
| `onAllyPlayed` | **友方**单位被打出（人间大炮「有队友被打出时」） | `{ played }` |
| `onEnemyCastSpell` | 对方打出**锦囊**（拳击手/苍耳「对方打出锦囊牌时」） | `{ cardId, cardName, casterSide }` |
| `onOpponentDraw` | 对方抽牌（希佩尔「敌方抽牌时」） | `{ drawerSide, cards }` |
| `onAnyUnitDestroyed` | 全场**任何**单位被消灭（卫兵「4个单位被消灭后」） | `{ victim, reason }` |
| `onAllyExtraAttack` | **友方**单位额外攻击了一次（派对客） | `{ attacker }` |

## `effect.when` 的附加条件（不满足就跳过这条异能）

```js
when: 'fused'                 // 只有用融合进化打出时（霸王龙）
when: { lane: 'mountain' }    // 只在指定地形落点时（登山员「在高山上打出」）
when: { deathsAtLeast: 4 }    // 全场累计被消灭数 ≥ 4 时（卫兵）
```

## 其它

| 能力 | 写法 |
|---|---|
| 有时限的词条授予 | `{ op:'grantKeyword', keyword:'invincible', untilTurnEnd:true, target:{...} }` —— 回合结束自动清掉（炫彩糖果/游击队）。不加 `untilTurnEnd` 就是**永久**（狂犬病） |
| 召唤时改数值/费用 | `{ op:'summon'\|'summonToHand', cardId, modify:{ atk:-2, maxHp:-2, costDelta:-1, keywords:['thorns'] } }`。<br>`costDelta` 也可以写**表达式**：僵尸「其花费增加1」= `{ costDelta:{ sourceCostDelta: true, plus: 1 } }`（继承上一代再加 1 → 5→6→7→8） |
| 攻击改用生命值 | 卡牌定义上加 `attackWithHp: true`（武术大师「此攻击使用♥而不是⚔」）—— 不是词条，是这张牌自己的攻击口径 |
| 光环对象「后方的队友」 | `{ kind:'grantKeyword', to:'laneBackRowAllies' }`（永恒秘典）—— 同线路后排友军，不含自己 |
| 线路封锁 | 走 op 之外的地方：`state.laneLocks[lane] = state.turn`；`canPlaceUnit` 会拦。氢弹用 |

## 仍然没有的能力（第二批的卡也不要硬凑）

嘲讽/吸引攻击、伤害转移、抉择分支、手牌内触发（`在手牌中:`）、
「无法选中」状态、偷金币、「跟随」语义、锦囊的溅射、
`onOpponentDraw` 的「将其弃置」（弃哪张还没定）。

## 追加：又补了 3 个 op（2026-09 第二批收尾）

| op | 参数 | 说明 |
|---|---|---|
| `lockLane` | `lane` 或 `lanes:[...]`, `turns`（默认 1） | 封锁线路，期间**不能放置任何单位**（氢弹）。`turns:1` = 施放当回合 + 下一回合 |
| `discardDrawn` | `side`（默认 `'opponent'`） | 弃掉**刚刚被抽到的那几张牌**，牌从触发 payload 的 `cards` 来（希佩尔「敌方抽牌时,将其弃置」） |
| `returnToDeck` 的 `count` | 加 `count: 1` | 不写 `count` = 符合条件的一整批；写了就**让玩家挑**那么几张（回收「将1张手牌洗入牌组」） |

---

# 附录二：第四 ~ 十一轮新增能力（第二批收尾）

## 新增 op

| op | 参数 | 说明 |
|---|---|---|
| `choose` | `prompt`, `options:[{label, actions}]` | **抉择**（歼-10）。效果打到一半反问玩家，选完继续。界面是一层盖屏的二选一面板 |
| `untargetable` | `target`, `turns`（默认 1） | **无法选中**（神威）。挂着这个标记的单位**任何点选类目标都选不中它**（连友方增益也点不到）；回合结束自动摘掉。**不挡交战**（交战按线路打，不经过选择） |
| `cycleStats` | `steps:[{atk,hp},...]`, `target` | **依次变为**（劫匪团队）。每次触发往后走一格身材，走到末尾就停 |
| `capDamage` | `value`, `side`（默认 `'opponent'`）, `turns` | **伤害封顶**（反应装甲）。被限制的那一方打出的伤害，本回合至多 X 点 |
| `conditional` | `if:{compare}`, `then:[]`, `else:[]` | **条件分支**（四号坦克H型）。`compare` 支持 `enemiesLEAllies` / `enemiesLTAllies` / `enemiesGEAllies` / `enemiesGTAllies` |
| `taxMana` | `side`（默认 `'opponent'`）, `amount` | **费用税**（盗贼）。对方**下回合**少 N 点费用上限；只吃一次，不累积 |
| `lockLane` | `lane` 或 `lanes`, `turns` | **线路封锁**（氢弹）。`turns:1` = 施放当回合 + 下一回合不能放单位 |
| `discardDrawn` | `side` | 弃掉**刚抽到的那几张牌**（希佩尔）。牌从触发 payload 的 `cards` 来 |
| `seal` | `target` | **封印**（一次性，持续到离场）。停 effects、停光环，**也停词条**（裁决 D62） |
| `setStats` | `hp`/`maxHp`/`atk`, `target` | **设为固定值**（永恒秘典）。与 `modifyStats`（加减）不同 |
| `transform` | `cardId`, `target` | **就地换成另一张牌**（魔术师→兔子 U329，裁决 D64） |
| `extraAttack` | `target` | **立刻**再打一次（咖啡豆/狂犬病/黑龙）。每单位每回合仍只一次 |
| `returnToDeck` | `from`, `to`, `count?`, `cardFilter?` | 放回牌堆。写了 `count` 就**让玩家挑**那么几张（回收）；不写=符合条件的一整批 |
| `modifyHandCost` | `amount`, `cardFilter?`, `side?` | 改**手牌实例**的费用，可叠加 |

## `bounce` 的 `preserveStats`

`{op:'bounce', preserveStats:true, target:{kind:'self'}}` —— **回手后保留加成**（扫地僧，作者裁决）。
把场上单位与卡面的数值差额记到**回手的那张牌**上，重新打出时自动加回去。

## `damage` 的 `asAttack`

`{op:'damage', amount:2, asAttack:true, ...}` —— **让这次伤害算作攻击**，
从而吃来源（锦囊的虚拟来源）身上的**溅射**词条（橄榄球）。

## 卡牌级开关（写在卡定义上，不是词条）

| 字段 | 效果 | 卡 |
|---|---|---|
| `attackWithHp: true` | 这一击用**当前生命**当伤害基数（溅射/穿透同步） | 武术大师 |
| `bypassInCombat: true` | **不挡枪**：普通交战选目标时跳过它，攻击穿到它后面的单位 | 蜜蜂 |
| `bodyguard: true` | **替后排挨打**：同线路后排友军受伤时改由它承受 | 伪装土堆 |
| `choosesTarget: true` | **拟定目标攻击**：**开战回合轮到它出手时**逐只问玩家打谁（可跨线路、可打脸）；不选就不出手；AI 侧自己挑并记进战报 | 强化士兵 |
| `inHand: [{...}]` | **在手牌中:在你出牌时**（见下） | 黑龙 |

### `inHand`

```js
inHand: [{
  buff: { atk: 1, maxHp: 1 },      // 默认：每次你出牌给这张手牌累积 +1⚔+1♥
  ifAtkAbove: 6,                   // 一旦（卡面攻击 + 已累积）**超过**这个数…
  thenInstead: { costDelta: -1 },  // …改成降 1 费，不再加身材
}]
```
累积值存在**手牌实例**上（`statDelta` / `costDelta`），打出时自动加到落地单位身上。
同一张卡的不同副本互不影响。

## 光环

- 新增作用对象 `'allEnemies'`（全场敌人）
- 新增光环类型 `{ kind: 'seal', to: 'allEnemies' }` —— **封印光环**（大封印碑）：
  持续生效，来源**一离场立刻解封**（和一次性 `seal` op 不同）
- 新增作用对象 `'laneBackRowAllies'`（同线路后排友军，不含自己）

## 新增触发时机

| trigger | 时机 | payload |
|---|---|---|
| `onCombatStart` | 逐线路开战结算之前 | `{ lane }` |
| `onKill` | 本单位消灭了敌方单位 | `{ victim }` |
| `onAllyPlayed` | 友方单位被打出 | `{ played }` |
| `onEnemyCastSpell` | 对方打出锦囊 | `{ cardId, cardName, casterSide }` |
| `onOpponentDraw` | 对方抽牌 | `{ drawerSide, cards }` |
| `onAnyUnitDestroyed` | 全场任何单位被消灭 | `{ victim, reason }` |
| `onAllyExtraAttack` | 友方单位额外攻击了一次 | `{ attacker }` |

## `effect.when` 的附加条件

```js
when: 'fused'                 // 只有用融合进化打出时才发动
when: { lane: 'mountain' }    // 只在指定地形落点时发动（登山员）
when: { deathsAtLeast: 4 }    // 全场累计被消灭数 ≥ N（卫兵）
```

## 动态数值

`amount` 可以是 `{ perOwnUnit:2 }` / `{ perAllUnits:1 }` / `{ perKeywordOfTarget:1 }` / `{ fixed:3 }`。
**「队友」= 自己场上；「单位」= 场上双方**。

## 新选择器

`lowestHpEnemyUnit`（生命最低的敌人，引擎自己挑）、`allUnits`、`allUnitsInLane`、`allLanesEnemyUnitsInLane`。

## 仍然没有的能力

嘲讽/吸引攻击（蜜蜂已按「不挡枪」实现，若要改成必须打它需重做）、
「跟随」（伴生迅猛龙，作者已确认该卡无法正常获得，不做）、
「永久全局加成」中「你的◈+1」这类若 ◈ 指攻击力则仍无解。
