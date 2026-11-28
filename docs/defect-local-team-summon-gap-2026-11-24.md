# 缺陷：未经市场部署的团队岗位无法被智语召唤

**日期**：2026-11-24
**发现于**：`add-personal-staff-fleet` 的真环境验收（4.1 / 4.2）
**严重度**：功能缺口（不是安全漏洞；当前是「过度收紧」而不是「过度放开」）

## 现象

个人幕僚团的五岗（幕僚长 / 评审官 / 侦查官 / 书记 / 审计官）与常务岗，
在智语房间 `zy_0abf5f80d114d07a42` 里**无法被 @点名召唤**。

实测链路（2026-11-24，`platform.finddatatech.cloud`，账号 `aloadtree@gmail.com`）：

```
/api/teams/cards                                  → []（一支团队卡都没发布）
/api/teams/cards/for-fleet/fleet_1794463395632_v4ycrt → { publication: null }
/api/fleets/<id> 的成员                           → 6 个岗位全在役，五个 on_duty/passive
/api/zhiyu/rooms/<id> 的成员                      → 20 个，agent 席只有 2 个，
                                                    且都是另一支团队的 product-advisor / project-assessor
```

五岗的 `target.kind` 是 `persona`（审计官是 `auditor`），
`target.servingPath` **全部 null**。

## 根因

`server/routes/fleets.js:220-233` 的 `resolveTarget`：

```js
if (member.targetKind !== "a2a") {
  return { alive: … , servingPath: null };   // ← persona / auditor 一律 null
}
const entry = catalog.getAgentEntry(member.targetId);
return { …, servingPath: alive ? servingPathFromEntryUrl(entry.url) : null };
```

`servingPath` 只从 **registry 的 a2a 部署条目**解出来
（`servingPathFromEntryUrl`：要求 URL 形如 `/agent/<path>/`）。

于是「能否被智语召唤」被锁在一条链上：

```
被召唤 ← servingPath 非 null ← registry 有 a2a entry ← 经市场部署 ← 发布成团队卡
```

代码注释写明了这个补丁的来历（`fix-zhiyu-summon-serving-face 1.1`）：
*"Only pack deployments are room-summonable"*。也就是说这是**当时有意的收紧**，
但它假设了「召唤 = 调外部服务」，没料到「本地/萬星部署的团队，对自己房间的成员也该可召唤」。

## 为什么这是缺陷而不是设计

两件事被错误地绑成一件：

| | 真正的判据 | 现在的判据 |
|---|---|---|
| 本房间成员能不能召唤它 | 这个岗在**本 cell 里活着** | 有没有**经市场发布** |
| 外部客户能不能调用它 | 发布行的 visibility / 白名单 / 配额 | 同左 |

**「对外可见」不该是「对内可用」的前提。** 用户的原话：

> 没有部署的也应该可以被召唤啊，比如我部署到萬星或者自己本地，对外和对内都应该可以使用才是啊。
> 这个安全问题确实很重要，但是应该允许这种行为吧，允许外部客户的操作导致本地写一些东西是
> 很常见的场景。

安全边界应该落在**谁能进这个房间**（房间成员 / 邀请 / 席位），
而不是落在「这个岗有没有出现在公开目录里」。

## 建议方向（未实施）

给 `servingPath` 增加**本地坐标**这一来源，与 registry 坐标并存：

1. **本地 persona/auditor 岗 → 一个 cell 内地址**（例如
   `/api/teams/local/<fleetId>/<memberId>/a2a`，走同一套 `team-serving` 的
   JSON-RPC 外壳，但身份解析改为「房间成员身份」而不是 registry 凭据）。
2. **召唤时的授权**：调用方必须是该房间的在席成员（`authorize(req, res, roomId)`
   已经存在，`gateway/zhiyu/index.js` 的其余路由都在用）。
3. **外部调用维持现状**：仍要求发布 + visibility + 配额，那条链不变。

也就是说：**内部召唤走房间授权，外部调用走发布授权**，两条互不冒充。

## 影响

- `add-personal-staff-fleet` 的 4.1（邀五岗入房）/ 4.2（@点名）无法完成，
  除非先补这一层。
- 任何「本地搭一支团队、在自己的智语房间里用」的场景都受影响——不只是这一支。
- 现有实现不会造成越权（它是收紧，不是放开），所以不紧急；但功能上「团队在房间里只是摆设」。

## 不该做的事

- **不要**为了让它「能召唤」而把团队发布成 `listed`/`open`。那是把内部可用性换成了对外暴露，
  与用户想要的方向相反。
- **不要**在 `add-personal-staff-fleet` 里硬塞这个改动——它改的是召唤坐标的来源，
  影响所有团队，属于独立能力。
