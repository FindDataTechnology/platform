## MODIFIED Requirements

### Requirement: CRM 客服台发送动作注册

动作注册表 SHALL 注册 `crm.message.send`（底层工具 `messages_create`，宿主 server `chatwoot`，write 档 → 行内确认，target=cloud）：参数含会话 id 与消息内容，影响面模板呈现会话号与内容摘要。CRM 发送动作 SHALL 以**双凭据模式**执行：动作声明 `credentialRef: "chatwoot"`——已连接 chatwoot 凭据的用户以其**自己的**凭据执行（逐租户 BYOK，嵌入多租户形态）；未连接凭据的机器 owner（寻数 A 租户自用/自部署形态）SHALL 显式回落到部署级共享凭据（部署 env 注入）执行——回落是第一方例外，SHALL 在注册表声明中显式标注；已认证但未连接凭据的用户 MUST NOT 回落共享凭据，SHALL 在 preflight 被拦截并给出去连接指引。B 面（商家多租户）的用户凭据语义由此承接，A 租户共享语义保持向后兼容。发送类工具（`messages_create` / `messages_delete`）MUST NOT 进入 agent 可见工具面，agent 只能经 `propose_action` 提议发送；`messages_delete` 不注册受闸动作，MUST 以「不可达/未注册」如实失败。

#### Scenario: 发送提议走行内确认

- **WHEN** agent 经 `propose_action` 提议 `crm.message.send`（含会话 id 与内容）
- **THEN** 用户看到行内确认卡（含会话号与内容摘要），确认后才执行发送

#### Scenario: 共享凭据执行且审计无凭据

- **WHEN** 已连接凭据的用户批准一条 CRM 发送
- **THEN** 执行以该用户自己的 chatwoot 凭据调用 `messages_create`（写入其自己的租户）；未连接凭据的机器 owner 批准时以部署配置的共享凭据执行（写入 A 租户）；两条路径的审计记录均含提议者、批准者与参数摘要，不含任何凭据明文

#### Scenario: 未注册的删除动作不可达

- **WHEN** 提议 `messages_delete` 类动作
- **THEN** 闸以动作未注册拒绝，不调用任何工具、不进入确认档位

#### Scenario: 已认证未连接的用户被拦截而非回落

- **WHEN** 已认证但未连接 chatwoot 凭据的用户批准 `crm.message.send`
- **THEN** preflight 失败并给出去连接指引，不以其身份动用部署共享凭据
