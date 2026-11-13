## Context

见 `proposal.md` — Why。这一节只记塑造方案的现状与约束。

**词表来源（不在本仓）**：四轴词汇、枚举边界、继承解析与 `executed` 语义由仓库根的
`add-agent-memory-declaration` 定稿，落在两处实现：

| 位置 | 形态 | 用途 |
|---|---|---|
| `fd-agent-graph/fd_agent_graph/memory_decl.py` | Python，零 IO | roster 离线校验 |
| `fd-memory/src/policy.ts` | TypeScript，零 IO | 运行时 policy 面 |

两者由共享 fixture `fd-memory/fixtures/memory-policy-cases.json` 对账：4 组解析用例逐字段相等、
5 组拒收用例指名同一出错键。**本变更不写第三份实现**——paas 侧只做形状校验与落地，解析复用既有语义。

**paas 侧现状（读代码确认）**

1. `server/knowledge-profile.js` 是纯函数模块（零 IO），一份 `normalizeKnowledgeProfile` 同时服务蓝图校验面与运行时装配面。这个「同一份 normalize 服务两个消费方」的纪律必须保留——它是校验面与运行时不分歧的唯一机制。
2. `knowledge` 段已是一等的：`memory {enabled, scope, budget 64..2000}` + `collections`，两层覆盖（cell 默认 → 舰队覆写），消费点在 `server/fleet-context.js` 的注入阶梯（记忆段与文档段共用预算梯子）。
3. `lib/pack-manifest.js` 已有 `agents[].memory.guidance`（≤600 字散文，拼进 persona 尾巴，`dsh-profile.js` 消费）与 `agents[].resources`（skills / mcpServers / mcpTools 三维，无 memory 维度）。pack 顶层无任何 memory 段。
4. `add-fleet-plugin-declaration` 刚给 pack 加了第六个声明面 `plugins[]`，其形态是本变更的直接先例：只引用已烘入的东西、落地点是团队实例补丁、不新增运行期通路。

**约束**

- 不分叉词表：paas 只消费根仓定义的语义。
- 不新增存储实例、不做跨根共享。
- 存量 pack 与只写 `knowledge.memory` 的蓝图零改动。

## Goals / Non-Goals

**Goals**

- 团队制品自足：一份 pack 能带走「这个团队怎么记事」，不再靠运维口头约定。
- 一处校验、两处消费：形状校验与继承解析同源，蓝图校验面与运行时装配面零分歧。
- 让「声明了但没生效」在管理面必然可见（四列 + `executed`），而不是靠人记得去查。

**Non-Goals**

- 不实现 `process.promote_after` / `process.cold_after_days` 的执行：根仓实测确认无证据计数与淘汰面，两键均为「可声明、可解析、`executed: false`」。本仓同样只透传与如实标注。
- 不改 `write.authority` 在宿主侧的承载方式：宿主 frontmatter 的 `memory` 键是存储位置枚举，写着色权威会被拒收（已在根仓实测并被生成器停止写入）。paas 侧不碰 agent 定义生成。
- 不做 pack 之间的记忆共享、不做记忆迁移工具。

## Decisions

### D1: 新增顶层 `memory` 段，而不是继续扩展 `knowledge.memory`

`knowledge` 段的语义是「成员能看到哪些原料」（文档集 + 召回范围），把处理策略塞进去会让一个段同时回答两个问题，而这正是本次要修的病灶（同名字段跨轴）。

替代方案：把四轴都塞进 `knowledge.memory`。放弃——`knowledge` 是「知识供应」的语言，`process` 是「数据面处理」的语言，混在一起后 UI 与校验的措辞都会开始含糊。

### D2: `knowledge.memory` 保留为 `read` 轴的等价写法

存量 pack 与蓝图很多，字段名已经在 UI 与文档里出现。直接改名会让「不声明即零改动」这条承诺破掉。

规则：等价时归一，不一致时拒收。拒绝比静默择一重要——静默择一正是「两个开关一个口径」的成因。

替代方案：只支持新写法并写迁移脚本。放弃——收益是命名整洁，代价是所有存量蓝图要改，且改名本身不产生任何行为价值。

### D3: 解析复用根仓语义，paas 不写第三份

paas 需要的只是「形状合法吗」与「这个团队的生效值是什么」。前者用根仓 fixture 的同一份用例驱动，后者由 fd-memory 的 `/policy` 回答（团队落地时写入，读面直接代理）。

替代方案：paas 自己实现一份继承解析（像 knowledge-profile.js 现在那样）。放弃——两份归一函数正是 `knowledge-profile.js` 刻意收敛掉的东西；再来一份，第三个消费方出现时就会三份不一致。**例外**：`knowledge.memory` ↔ `memory.read` 的等价/冲突判定必须在 paas 侧（那是 paas 自己的历史包袱），但它的产物是「一份规范声明」，交给根仓语义解析，不自己算继承。

### D4: `process` 落地为团队的 fd-memory policy，不落 paas 库

处理策略的消费者是记忆服务。paas 若自己存一份再透传，就会出现两个权威，而 `FD_MEMORY_DISTILL_U` 这类部署开关会长期与它并存。

落地形态复用既有幂等写入路径（同 `plugins[]` 的团队补丁做法）：团队落地写 policy、团队归档清 policy、重跑幂等。

替代方案：paas 保存 effective profile 并注入回合。放弃——那是 knowledge-profile 已经做对的部分（`read` 轴的运行时注入），不该被复制到处理轴。

### D5: guidance 与 authority 并列，不合并

`guidance` 回答「记什么」（散文，进 persona），`authority` 回答「你的结论算不算数」（枚举，进校验与读面）。合并成一个字段会重演「一个字段两套语义」。

替代方案：把 guidance 变成 authority 的附注。放弃——两个都缺失时都合法，附注形态会逼着必须写 authority。

### D6: 四列读面，`executed` 由根仓语义给出

只报「生效值」会让调用方以为 `cold_after_days: 90` 已在执行。`executed` 列把它变成必然可见的字段，而不是靠人记得检查。

`executed` 的来源是根仓的 `EXECUTED_SUBKEYS`，paas 只透传，不自己判定——否则「谁执行了」会变成第二份真相。

### D10: 坏行由读面指名，且`resolvePolicy`不动

写入面会拒坏文档，所以坏行只可能来自带外：旧版本写的、手改的、从校验存在之前的备份恢复的。
**先测后改**：直接往存储写 `{distil:"off", promote_after:"lots"}`，读面报出
`rows.distill.effective="on"`（意图消失）与 `rows.promote_after.effective="lots"`（不可解析却当生效值）
——两条都是规格禁止的「以默认值呈现为正常」。

两个标记，因为两种坏法落点不同：

- **未知键**不产生任何行，只能进顶层 `stored_invalid`（level + key + code + message）
- **值非法**会进到行里，故行上带 `invalid`，它的 `effective` 不得被当成生效值

`normalizePolicyPartial()` 保留能解析的键、只丢非法的键；`normalizePolicy` 变成它的薄包装——
写入面要「全收或全拒」，读面要「留好的、指名坏的」，同一套规则两种丢弃策略。

**`resolvePolicy` 刻意不动**：调度器与共享 fixture 逐字节依赖它，上报只建在读面建表处。否则
一次判据改动会同时改变蒸馏行为和跨实现一致性 —— 两件事应该分开。

### D7: 整段替换 vs 逐键继承——不合并，但把被顶掉的声明标出来

两条规则同时存在，且**必然**同时存在：

| 面 | 规则 | 出处 |
|---|---|---|
| 根仓记忆声明（agent → team → deployment） | 逐键继承，`inherit` 表示继续上溯 | `agent-memory-declaration` |
| paas `knowledge` 段（cell 默认 → 舰队覆写） | 整段替换：覆写提到该段即整体顶掉 | `member-knowledge-profile` |

paas 的规则有它自己的理由，而且写进了既有契约：「一份部署覆写是它所提到那些段的完整声明，因此可以收紧，但永不悄悄依赖记不全的上一层」。改它 = 改变存量部署的生效值，不在本变更范围。

不合并的代价是同一份声明在两处解析结果可能不同。**补偿**：读面把「被顶掉的声明」标成 `shadowed_by`——

```
cell 写 scope: shared ，deployment 只写 budget: 700
  → declared: "shared" · inherited_from: "platform" · effective: "own+shared"
    · shadowed_by: "deployment"
```

没有这一列时，算子在管理面看到的是一条看起来正常的 `own+shared`，而它写下的 `shared` 已经不在生效——这正是「声明了但没生效」最难被发现的一种：不是被忽略，是被顶掉。

（词表同步：`read.scope` 的三个取值已与根仓一致；`own` 因无消费方被两端同时排除，见归档变更 `narrow-memory-read-scope`。）

### D8: 策略写在 pack 记忆根，不假装比存储更细

实测出的坐标规则（`yongyi-client/dist/mounts.js`）：成员命名空间是
`d/${packId}/${agentId}`，pod 令牌挂 `d/${packId}` —— **根按 pack 划分，不按 fleet 行划分**。

而 `findFleetByTemplate(packId, ownerEmail)` 的去重键是 **pack + owner**：同一个 pack 被不同所有者
各落地一次，会得到两个 fleet 行，却共用同一个 `d-<pack>` 根。

所以在「团队」粒度写策略是写不出来的——那个粒度在存储里不存在。选 root 作用域，与存储对齐；
读面显示根键，让算子看得出作用域。**这不是本变更引入的限制**：同一 pack 的两个团队今天就已经
共用一份记忆，策略只是跟着同一粒度走。

替代方案：按每个成员的 project 写一份（`d-<pack>/<member>`）。放弃——同一 pack 的两个团队成员
agentId 相同，project 也会撞；只是把同样的共享藏得更深，还多 N 倍写入。

### D9: 编译与写入分离；写入用 pack 自己的 pod 令牌（不是新特权）

实施 4.1 时把「算」和「写」拆开（`lib/pack-memory-policy.js` 只做前者）：

- **算**：声明 → `{rootKey, doc}`。三条都是可测的事实，且都有测试钉住：根键按 pack
  （`d-<pack>`，与 D8 的坐标规则一致，因此两个所有者的团队算出来是**同一次写入**）；
  只写**被声明的**子键（把平台默认物化进文档，等于把「平台默认 on」变成「本合同声明 on」，
  之后默认变了也到不了团队）；**空声明不产生写入**——`/policy` 里空文档是清除语义，
  写空会把同根下兄弟团队的策略删掉。
- **写**：由调用方做，用**该 pack 自己的 pod 令牌**。

初稿把写入当成一个待裁的授权问题（担心「一个租户改另一个租户团队的策略」）。**实测推翻了
这个担心**：`agent-runner/manager.js:1111 #podMemoryMountToken()` 今天就在为每个 pack 铸
namespace 为 `d/<pack>` 的 pod 令牌，并拿它挂一个有写能力的 fd-memory MCP 面
（`dshMemoryMount`）。也就是说「以 pack 根为作用域写入」这件事早已在既有信任模型内，
写 policy 只是同一把钥匙开同一把锁，不引入新的跨租户权力。

因此写入路径（待 `server/routes/fleets.js` 解封）：

1. 读来源模板的 packId → `compilePackMemoryPolicy(manifest.memory, {packId})`；
2. `empty: true` → 不写（撤销即回部署默认，4.4）；否则
3. 用 `#mintMemoryToken(podMemoryNamespace(packId))` 同款的 pod 令牌 `PUT /policy?scope=root`，
   写前用 `isSamePolicyWrite()` 比一次读回值，相同就跳过（4.2 的幂等，避免刷 `updated_at`）。

仍然必须由调用方而非本模块做：令牌铸造、失败降级（degrade open，绝不影响配对／落地）、
以及读面显示根键（D8）。

## Risks / Trade-offs

- **[paas 与根仓语义漂移]** fixture 在 fd-memory 仓里，paas 的校验测试若不复用就分叉。→ paas 侧的用例从同一份 fixture 读（跨仓相对路径），并在 tasks 里写明「根仓改语义，这里先红」。
- **[`knowledge.memory` 与 `memory.read` 双写法长期并存]** 两套写法会一直有人在用。→ 接受：等价写法不产生行为差异，拒收冲突；文档只示范新写法，UI 只渲染新写法。
- **[团队 policy 落地后与部署 env 并存]** 迁移期存在两个来源。→ 顺序：先上校验与读面（只读），再上落地写入；env 恒为最低层默认，被任何声明覆盖。
- **[pack 作者把地址写进 `home`]** → 独立错误码（`store_home_addressed`），与「枚举值不认识」分开报，因为它是一条边界而不是一次笔误。
- **[策略作用域比「团队」粗]** 同一 pack 的多所有者团队共享策略 → 用 D8 记录并对齐存储粒度；读面显示根键，不谎称按合同隔离。真正的按租户隔离需要记忆中台的根键带上 tenant，属另一件事。
- **[新增第七个声明面让 pack manifest 更复杂]** → 全部可选、未声明零成本；校验按轴闭合，错误逐键指名，作者不会面对一条含糊的「格式错误」。

## Migration Plan

顺序不可反，每步可单独回退。

1. **校验与预览（只读）**：`pack-memory-declaration` 形状校验 + 四列预览上线，不写任何落地点。回退 = 撤校验（存量 pack 本来就不声明）。
2. **等价归一**：`knowledge.memory` ↔ `memory.read` 的等价与冲突判定上线，读面开始显示继承来源。此步只影响呈现，不改行为。
3. **团队落地**：`process` 编译为 fd-memory policy。回退 = 清空该团队的 policy 行，落地路径幂等可重跑。
4. **UI**：管理面渲染四列；`enabled` 从 UI 入口下线（仍接受为等价写法）。

## Open Questions

无。
