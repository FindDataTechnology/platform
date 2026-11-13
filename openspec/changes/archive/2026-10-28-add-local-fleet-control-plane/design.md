# Design: add-local-fleet-control-plane

## Context

explore（2026-10-28）坐实的现状骨架：执行面完整——runner 子进程本地拉起、
127.0.0.1 捆绑、pod 密度、seat id 由 first-run mint、`cloud-default` 哨兵防呆；
管理面三缝——roster 真源在公共 registry、写动作在云端、配对是唯一入口。本设计
只对「把管理面收回 cell」的技术选择与不动量边界负责。三缝收在同一层：**cell
本地落一张部署表 + 一个 registry 兼容 feed**，runner 与云 registry 协议一律不碰。

## Goals / Non-Goals

**Goals:**
- stock 桌面（未配外部 registry）开插件即有本地集群：本地 feed 作 roster，舰队页可写。
- feed/写面与云 registry 形状同构：runner 零改造、未来若做「云管本地」时混读不炸表。
- 部署/启停/移除的语义与容量闸诚实化；未配对云席也可全功能管理本机集群。

**Non-Goals:**
- 云控制台下发到本地（配对桥 v1 只读）；多本机席位分片；runner 调度策略改动。
- A 系（fleets/cron 公司式舰队）产品联动——归姊妹 change `polish-desktop-fleet-parity`。
- 离线 bundle 导入本身——归 `add-offline-pack-supply`；本 change 只消费「已安装」态。
- win/mac 之外平台；本地模型车道产品化（既有 baseURL 泄洪道不动）。

## Decisions

### D1 roster 真源 = cell 部署表 + 兼容 feed，runner 零改造

本机部署记录落 SQLite 新表 `local_fleet_deployments`
（agent_path 主键、pack_id、agent_id、enabled、config_overrides、created/updated），
cell 在回环透出 `/api/agents` 兼容读面，条目合成复用 `lib/agent-serving.js` 的
`servingEntryFor`/`composeAgentCard`/`listServingAgents`——同一合成函数既服务
云 registry 写、也服务本机 feed 读（此刻它的职责从「deploy 写器」升为「条目合成器」，
读/写两侧共用，漂移在源头被杀死）。runner 侧只换两个 env 指针，代码一行不动。
替代项：(a) 本地起一个真 registry 服务实例——引入第二个需要理解分片/租约/鉴权
的服务，桌面体积分分钟回本；(b) 教 runner 读本地目录/双源——分片防呆纪律
（`cloud-default` 哨兵）要在 runner 里再实现一遍，双真源必漂。都被否决。

### D2 令牌 = first-run mint 的回环 Bearer，不是新凭据类型

feed 鉴权用 `WANXING_LOCAL_FEED_TOKEN`：first-run bootstrap 幂等生成（与 seat id
同批同目录），descriptor 把它注给 runner 子进程 env，cell 自验。回环只绑
127.0.0.1；这不是账户凭据，不进 Connections UI、不上云、不可被渲染层读。
替代项「复用 pairing 令牌」把本地可用性与云配对耦合，违背「未配对也可管理」；
「无鉴权」则任何本机进程都能读/写 roster 读面，agent 清单属于部署信息不放行。

### D3 写面只写部署表，收敛交给 runner 既有轮询

deploy/stop/start/remove 只动部署表与（必要时的）config_overrides；运行时的
拉起/排空由 runner 的既有轮转 loop 看到条目增删后自收敛（桌面轮询节拍与云端同机制）。
v1 不做「cell 主动 push 通知 runner」——多一条 IPC 多一份挂断面，节拍内生效
（秒级）对桌面场景足够。写面返回的是**已落库事实**，不是运行时状态；UI 用 live
端点（既有 `/api/wanxing/fleet/live`）做随行刷新，杜绝假绿。

### D4 部署门三闸：可部署性 / 幂等 / 容量（按运行时组计）

可部署性：`listServingAgents(manifest)` 非空 + pack 处于已安装态 + 请求不带外部
`runner_id`（v1 本机只此一席）。幂等：同 (packId, agentId) 的 deploy 直接返回
既有记录（200 + 现有 agent_path），重试/双击不产生第二条。容量：
`AGENT_RUNNER_MAX_CHILDREN` 比较的**不是部署条目数而是 runner 的 child 进程数**
（spike 1.1 实测 `acquire()` 判据 `children.size < maxChildren`）；pod 模式
（桌面默认 `AGENT_RUNNER_POD_MODE=1`）下同一 pack 的全部 agent 共宿一个 child，
故「组」= pod 按 packId 归组、solo 按 agent 计。超限 409
`{ error: "capacity_exceeded", used, cap, unit: "groups" }`；同包第二个 agent
不额外占组。上限本身留给用户 settings 可改（本机机器自己负责），不 hardcode
进 spec。替代项「排队等待」在桌面没有容量回收的主动权人，静默排队=静默卡死，
否决。

### D5 云桥只读化，分区不混管

舰队页 UI 分为「本机集群（可写）」与「云席位（只读桥，需配对）」两区：
配对后云席条目仅展示（live 代理既有行为），部署写一律落本机；用户想把云席
agent 挪到本机 = 在本机区部署同一 pack（pack 已在本地装好的前提下），不做
「迁移」动作。配对从必经降为可选桥——`desktop-fleet-console` 原「目录只读」
要求就此改写。**BREAKING 不成立**是对外 registry 部署而言；对桌面 UI，「目录
区部署按钮恒禁用」这一可观察行为被有意的本 change 废除。

## Migration

- `local_fleet_deployments` 新表随 db.js 迁移幂等创建；**无存量数据回填**——
  本机部署从本 change 起才存在。云席位记录属云 registry 真源，cell 不搬家。
- 设置键新增幂等：`WANXING_LOCAL_FEED_TOKEN`（first-run mint）。
- 回滚 = 关 `WANXING_PLUGIN_ENABLED` 或恢复外部 registry 指针；feed 与写面是
  纯增量路由，摘除不影响 cell 其余面。

## Verification

- 先行 spike（任务 1，go/no-go 闸）：零改动 runner + 手工假 feed 走通编目→拉起
  链路，产出形状样张做 feed 合同测试的金样。
- 单测：feed 形状/分页/鉴权/孤儿剔除；写面三闸；合成函数复用等值。
- 合同测试：feed 金样 vs spike 样张；写面→feed→live 的节拍契约（用假轮询步进）。
- e2e：乘 `automate-nonweb-acceptance` installer-e2e 轨加一幕「装离线样例包→
  部署→live 见 agents→断公网仍工作→卸载收净」，windows 默认腿 + mac dispatch 腿。
