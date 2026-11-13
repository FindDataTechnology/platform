# Design: add-zhiyu-team-memory

## Context

三块地基已建制，缺的是把「现役团队」接上去：

1. **永忆侧**：fd-memory u/ 面（capture/MCP/digest 渲染契约、L0→L1→L2 蒸馏、永不删页只 supersede、
   per-owner 日预算）全在产；`chat-memory` 的 digest 注入契约（硬预算 1500 tokens、layer/tier 标注、
   同源检索）有独立渲染器可复用。壹座现役团队的岗位回合目前**零记忆接入**——fleetContext
   （`server/fleet-context.js`）只有下级报数+在岗总览+决策 digest+巡逻纪律四段。
2. **智语侧**：空间成员三类（user/facade/agent，agent ref=部署 id `packId:agentId`）、消息
   kind=human|agent|system|event、回合协议与熔断、通知触达全在产。空间与团队之间零通路。
3. **判例**：`PATROL_DISCIPLINE`（§15.88）治的「岗位把工作区文件当记忆用」正是缺记忆注入的症状；
   fleet-memory（萬星部署侧）的 d/ scope+shared 区证明了「团队共享区」模型可行——壹座侧等价物
   就是 `f/` project 的 memberId 过滤。

## Goals / Non-Goals

**Goals**

- 岗位经验跨换防/清史存续（记忆层），对话史只承担对话连续性。
- 团队动态可被空间阅读讨论；召唤一次到位。
- 全部复用既有面：capture 纪律、digest 渲染契约、邀请握手、防洪频控、熔断语义。

**Non-Goals**

- 不为团队建第二记忆服务/第二 scope 体系（`f/` 是 u/ 下普通 project，fd-memory 零契约变更）。
- 不自动全量蒸馏对话史（L2 选材沿 distiller 既有纪律）。
- persona 岗不在空间发言（无 serving 面；不假装）。
- 不做平台→机器的推送通道（桥是网关侧写入空间行；cell 上行白名单零变更）。
- 不把团队事件推给 IM 群桥（zhiyu-im-bridge 的出站是另一条线，本案只做站内空间）。

## Decisions

### D1 · namespace 用 `u/<owner>/f/<fleetId>` 而不是新 scope 族

`f/` 是 u/ root 下的普通 project——fd-memory 的三类 Scope（agent/pack/owner）零扩展，Grant 矩阵
零变更（owner 令牌天然 rw 自己的 u/）。团队共享=同 project 内 memberId 过滤，不需要 d/ 那样的
多 project 分房（壹座现役团队单 owner，无跨部署者隔离问题——那是 d/ 面对的问题）。

### D2 · 记忆段走 provider seam，与决策 digest 同款姿态

`fleet-context.js` 增 `memoryDigest` 注入缝：null=段缺席。理由：决策 digest（刀3）已验证了这个
模式的三个优点——依赖缺席不阻塞回合、测试可注入、上线可灰度。段预算计入既有 24KB 总量，
截断顺序：下级报数 > 决策 digest > 记忆段（记忆是接续用，报数是本轮输入）。

### D3 · capture 挂回合收束点而非回合发起点

五类事实里四类在收束时才确定（报数、拍板产生在回合内、健康迁移是派生、换防是独立动作）。
挂收束=一次写入、事实完整；健康迁移由状态派生面触发单独 capture（失联/恢复不是每个回合都有）。

### D4 · 空间侧做成「订阅」而非「团队成员」

团队不是能说话的单一实体——把团队塞进成员模型会迫使「谁代表团队发言」这个伪问题。订阅=事件源
声明，进消息流的是 system/event 行（既有 kind），不占在席、不占回合配额、不受邀请握手管辖。
召唤=批量邀入部署成员（既有 agent 形态）+订阅，一次动作两层效果。

### D5 · 频控复用防洪语义，熔断期丢弃不补发

报数防洪（72h 过期+合并上报）已验证「密集事件合并」的口径。事件行进空间同理：密集窗口合并为
计数+样例行。熔断期丢弃不补发（空间是讨论场，不是账本——账在驾驶舱与记忆里），恢复后下一条
标注丢失量，如实而不刷屏。

## Risks

- **digest 渲染器的 project 过滤**：`chat-memory` 渲染器按 owner root 渲染，若不支持 project 过滤
  参数，则在本项目内按 `f/` 前缀+memberId 预过滤后再送渲染（tasks 里有核对项）。
- **capture 放大量**：每次回合一条观测×岗位数×节奏——量级可控（客服班组 3 岗×6 回合/天≈20 条/天），
  且 L0/L1 便宜；L2 蒸馏沿既有日预算门自然限流。
- **事件行打扰**：订阅是显式动作+频控合并+可随时解除；不设默认订阅（新建团队不自动进任何空间）。


## Implementation Notes (apply 2026-10-30)

- **通路定案与 spec 一致但更省**：刀A 不需要新客户端——`server/cluster-memory.js` 的平台缝客户端
  （/pages+/digest，degrade-open、person token 每 owner 一铸）直接克隆为 `server/fleet-memory.js`；
  fd-memory 零契约变更证实（`f/<fleetId>` 就是 u/ 下的普通 project）。
- **capture 挂点实测**：回合+健康迁移挂 `recordFleetTurnEvent`（server.js 包裹，fire-and-forget）；
  拍板产生挂 escalate 成功点、裁决挂 resolve 成功点、换防挂 swap 的**真返回点**
  （首个锚点匹配了相邻 handler 的同名序列——anchor 后必须断言命中数并核对上下文）。
- **幂等键含内容**：固定时钟（测试/快速连发）下纯时间戳键会把两个不同事实误判为重放——
  键=fleet|member|kind|ts|title|body，重放（同事实再投递）仍幂等。
- **桥是拉取式**（1.2 定案）：每 tick 对每个订阅 owner 取样其自己 cell 的 overview
  （forged-identity 通道，与投影车道同一握手），差分出三类事实。零推送、零新上行字段。
  首见基线静默（订阅不倒历史）；决策差分以 top[0] 为新条目面孔（overview 按严重度排序）。
- **坑**：zhiyu store 的 messagesAfter 直接返回数组（不是 {items}）；fleet-room-bridge 模块
  引 express 需显式 import（gateway 内文件不共享 host 模块图）。
- 5.2 真机走查随滚版班。
