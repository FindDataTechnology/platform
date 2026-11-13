# 无人值守部署的绑定，由部署者预铸并以部署密钥下发

## Why

绑定令牌的铸造链只认「人」：`connector-grants.js` 用**用户自己的账号令牌**作父凭证
（`connectorCredentials.liveToken(email)`，注释写明 "Without it there is nothing to attenuate
from, and we must not reach for a deployment token"），而连接器侧也明确拒绝服务身份铸造
（`tenant-routes.ts`：`Service tokens cannot mint PATs.` —— "A service token acts for someone
else; letting it mint would hand out credentials the service itself never owns."）。

于是**served agent / 定时岗位**这类无人值守的运行体永远拿不到绑定：链上没有“人”。这不是
权限 bug，而是“以谁的身份铸”没定，属 ② 归档时记的第 7.5 条挂账。

现成的地基刚好合适：平台已有 `deployment_secrets(pack_id, agent_id, name, secret_ref,
secret_value, deployer)` —— 值留在平台侧，下发给 runner 的只有不透明引用（`descriptor.secret_refs`），
且 `deployer` 列天然记录“是谁部署的”。绑定令牌放这里，等于把“部署者主权”（已拍的第④条）
直接落成机制。

## What Changes

- **铸造点前移到部署时**：部署一个声明了 `connector_bindings` 的包时，由**部署者本人**的会话
  按既有 `mintBindingToken`（父凭证 = 部署者的活动账号令牌）铸出绑定令牌，随后写入
  `deployment_secrets`（`name = connector_binding:<bindingKey>`，`deployer = 部署者`）。
  运行期不再铸造，连接器的鉴权模型一行不改。
- **判定口径复用 ②**：哪些绑定要铸，取该包 `connector_bindings` 声明中 `optional !== true`
  且解析态为 `satisfied` 的键；`unwired`/`undetermined` 不铸（与状态面同语义，不许猜）。
- **下发**：`deployment_secrets` 已有的 `secret_refs` 通道负责把引用送到 runner；具体如何
  在 served agent 的 profile 里拼出 `connector:<packId>:<bindingKey>` 行（`credentialRef`
  指向该部署密钥）留给 runner 侧接线，单独验收。
- **撤销与重铸**：部署者撤销绑定（或包卸载）时，对应 `deployment_secrets` 行随之删除；
  重新部署 = 用当时部署者的账号重铸（旧的先删，不并存）。

非目标：不放宽 `service_pat` 铸 PAT 的限制（那是“服务身份代表谁”的产品决定，须连接器侧一起
评审）；不做运行期自动续铸；不动 `deployer` 的所有权与计费语义。

## Impact

- 影响面：仅有 served/定时部署的包。个人交互式使用（用户自己点授权）路径完全不变。
- 安全姿态：令牌仍由某个真实身份的账号衰减而来（部署者），范围仍按绑定的
  `allowOperations`/`allowActions` 收窄；部署者离岗/撤销账号 → 该部署的绑定失效（需要重新部署），
  这是刻意的取舍，写进 spec 的判据里。
- 无新表（复用 `deployment_secrets`）；无 API 形状变更。
