# fleet-room-bridge — Delta

## MODIFIED Requirements

### Requirement: 一键带队召唤批量邀入部署成员

空间召唤面 SHALL 提供从自己团队清单的一键召唤：将该团队当前可召唤的部署成员（`packId:agentId`，
既有 agent 成员形态）批量发起邀请（沿既有邀请握手与策略应答），并默认建立该团队的事件订阅；
召唤 SHALL 如实呈现哪些成员可召唤（有 serving 部署）、哪些不可（persona 岗无 serving 面——
SHALL NOT 假装其在空间可对话，呈现为「在驾驶舱可见/行动」的指引）。邀请结果逐成员如实
（接受/拒绝/待答），部分失败不掩盖。

「可召唤面」的判定语义 SHALL 为：团队编队上报中 `targetKind` 为 a2a 的岗位，且其 serving 部署
路径能在部署台账中对齐到一行现役部署——此时该岗以该部署的 `packId:agentId` 为席位引用、
该部署的部署者为代表（onBehalfOf）成为可召唤成员。部署台账中无对齐行的 a2a 岗（含外部
serving 地址不属于部署台账的）SHALL 如实排除在可召唤之外，不虚构席位引用。部署台账面
不可达时 SHALL 诚实降级为空可召唤面（如「面暂不可用」，与事件采样同款纪律），MUST NOT
报错打断空间。

#### Scenario: 一键召唤部署成员

- **WHEN** 主人对自己拥有的一支含两个部署成员的团队执行一键召唤
- **THEN** 两个部署成员的邀请按其策略发起，事件订阅建立；persona 岗呈现为「去驾驶舱」指引而非假邀请

#### Scenario: 部分失败不掩盖

- **WHEN** 两个部署成员一个接受一个按策略拒绝
- **THEN** 空间如实呈现一进一拒，订阅照常建立

#### Scenario: 召唤计划对现役部署岗位非空

- **WHEN** 一支团队含 a2a 部署岗且其 serving 部署路径与部署台账对齐，主人执行召唤计划（dryRun）
- **THEN** 计划的 summonable 逐成员携带 `packId:agentId` 席位引用与其岗位名，persona 岗仍呈现在 cockpitOnly

#### Scenario: 外部 serving 地址与无对齐行如实排除

- **WHEN** 某岗的 serving 部署地址不属于部署台账（外部服务），或台账中该路径无现役行
- **THEN** 该岗不出现在 summonable，也不假装可召唤（按计划语义归入不可召唤侧）

#### Scenario: 部署台账面不可达时诚实降级

- **WHEN** 部署台账面不可达（网络/配置缺失）
- **THEN** 召唤计划仍 200 返回，summonable 为空、cockpitOnly 照常如实，不返回错误
