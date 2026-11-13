## ADDED Requirements

### Requirement: 受闸动作可执行于 stdio 操作服务器

动作注册表中的动作 SHALL 能把其宿主 server 声明为一个 stdio MCP 服务器（操作员基线条目，含 env 声明）。执行器在批准后 SHALL 以 stdio 子进程方式连接该 server 执行底层工具：每次执行一个连接（initialize → callTool → close），子进程 env 由该 server 条目声明的 env 名单从部署环境变量解析（与 cell patch 同一解析口径）。执行所遇失败 SHALL 如实分类（凭据无效 / 网络不可达 / 上游错误 / 参数被拒 / 不可路由），MUST NOT 伪装成功。宿主 server 条目所需 env 缺失时，preflight SHALL 拒绝提议并给出可读原因（未配置），MUST NOT 进入确认档位。

#### Scenario: 批准后在 stdio 服务器上执行工具

- **WHEN** 用户批准一个宿主为 stdio 操作服务器的受闸动作
- **THEN** 执行器拉起该 server 子进程（env 按声明注入）、调用底层工具、关闭连接，审计台账新增执行记录

#### Scenario: 宿主 env 缺失时提议被拦截

- **WHEN** 某 stdio 宿主 server 的声明 env 在部署中缺失时提议其动作
- **THEN** preflight 失败并提示该服务器未配置，动作不进入确认档位，不拉起子进程

#### Scenario: stdio 执行失败如实分类

- **WHEN** 批准的 stdio 动作执行中子进程退出、连接失败或工具报错
- **THEN** 提案标记为执行失败并带原因分类，不出现假成功，审计保留失败原因

### Requirement: CRM 客服台发送动作注册

动作注册表 SHALL 注册 `crm.message.send`（底层工具 `messages_create`，宿主 server `chatwoot`，write 档 → 行内确认，target=cloud）：参数含会话 id 与消息内容，影响面模板呈现会话号与内容摘要。CRM 发送动作 SHALL 以部署级共享凭据执行（A 租户为寻数自用第一方账号，平台用户共享同一收件箱属预期）——这是「谦面/萬星动作以用户自己的凭据执行」条款的第一方例外，SHALL 在注册表声明中显式标注；B 面（商家多租户）接入时再引入逐租户 BYOK 凭据语义。发送类工具（`messages_create` / `messages_delete`）MUST NOT 进入 agent 可见工具面，agent 只能经 `propose_action` 提议发送；`messages_delete` 不注册受闸动作，MUST 以「不可达/未注册」如实失败。

#### Scenario: 发送提议走行内确认

- **WHEN** agent 经 `propose_action` 提议 `crm.message.send`（含会话 id 与内容）
- **THEN** 用户看到行内确认卡（含会话号与内容摘要），确认后才执行发送

#### Scenario: 共享凭据执行且审计无凭据

- **WHEN** 用户批准一条 CRM 发送
- **THEN** 执行以部署配置的 chatwoot 凭据调用 `messages_create`，审计记录含提议者、批准者与参数摘要，不含任何凭据明文

#### Scenario: 未注册的删除动作不可达

- **WHEN** 提议 `messages_delete` 类动作
- **THEN** 闸以动作未注册拒绝，不调用任何工具、不进入确认档位
