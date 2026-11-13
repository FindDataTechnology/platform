# fleet-memory Specification (Delta)

## MODIFIED Requirements

### Requirement: 人令牌经 /hook 写入其 namespace，platform 族边界如联邦契约

fleet-memory 服务的人令牌（u/ 族）SHALL 同时被 `/hook` 兼容端点与 MCP 面接受，两者写入同一 namespace 语义（互见）；`platform` 族令牌为纯铸造面（铸造 person 令牌 **与 deployment 令牌（add-agent-memory-foundation：绑定 `d/<packId>/<agentId>`，铸造时落 root_owner 绑定记录，供 oversight 判定）**；capture//hook/MCP 全拒），权限矩阵为：deployment=`d/<packId>/<agentId>` 成员读写（agent + 所属 pack Scope）；pod=`d/<packId>` 集群共享区读写；person=`u/` root 读写（MCP+/hook）**＋对自己名下部署根的审计式只读监督（add-agent-memory-foundation：可读监督面列分区/读页/digest 含成员私有分区，零写权，逐读审计；实现契约见 openspec: agent-memory-foundation）**；runner=任意 `d/` capture-only + 代铸 deployment 与 pod；platform=代铸 person 与 deployment only；local collector 令牌族（fsc_）仅 stats 面，与记忆令牌族互不相通。

#### Scenario: 令牌族权限矩阵全覆盖

- **WHEN** 以五种令牌族（deployment、pod、person、runner、platform）分别请求 capture、/hook、MCP、project 读写面、铸造面
- **THEN** 每格结果与矩阵一致（拒绝均 403 结构化），无越界写入

#### Scenario: owner 监督只读落入矩阵

- **WHEN** person 令牌对自己名下部署根发起列分区与读页请求，并对同一根发起写入
- **THEN** 读成功且逐次落审计行；写 403 结构化拒绝（矩阵其余格不变）

#### Scenario: platform 代铸 deployment 令牌且绑定 owner

- **WHEN** platform 令牌调用铸造面请求 deployment 令牌（`d/<packId>/<agentId>`），再以该 deployment 令牌写 own 分区
- **THEN** 铸造成功且 root_owner 绑定落库；写入落该成员私有分区（platform 自身碰数据面仍全拒）
