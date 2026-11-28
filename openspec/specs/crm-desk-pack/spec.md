## Purpose

商家 CRM 客服套件 pack：把 CRM 客服台 agent 桥以「连接自带凭据 + pack 订阅安装」形态产品化——商家在壹座连接面粘自己的 Chatwoot 凭据，订阅 pack 后 cell 组合出**自己租户**的 chatwoot 工具面与接待技能，发送经动作闸以商家自己的凭据执行；凭据全程 BYOK，租户隔离由 Chatwoot 账号作用域保证。

## Requirements

### Requirement: chatwoot 连接面板与凭据生命周期

连接中心 SHALL 提供 `chatwoot` 连接面板：用户粘贴自己 Chatwoot 账号的 API token（必填）与登录邮箱/密码（嵌入用，选填）。chatwoot 服务器行由平台基线提供（每 cell 一份，配置钉版本 dist 路径），连接面只管凭据：保存/轮换凭据 SHALL 在下次组合即生效（cell patch env 携带该用户 token）；清除凭据后，该用户下次组合 MUST NOT 再以用户凭据出现 chatwoot 条目——在带部署 env 的部署上 MUST NOT 回落到共享部署凭据（防跨租户暴露），仅机器 owner（无认证身份）可回落。token 与密码 MUST NOT 出现在日志、pack 内容或任何共享配置仓。

#### Scenario: 连接后进入自己的租户面

- **WHEN** 用户在连接面板粘贴自己的 Chatwoot token 完成连接
- **THEN** cell 下次组合出现 chatwoot stdio 条目且其 env 携带该用户 token，工具面为其租户的 98-leaf 标准面

#### Scenario: 清除连接不回落共享凭据

- **WHEN** 已连接的商家清除 chatwoot 连接（部署带共享 env）
- **THEN** 该商家下次组合不再出现 chatwoot 条目，动作提议被 preflight 拦截并给出去连接指引；其工具面 MUST NOT 出现共享凭据对应的 A 租户内容

### Requirement: CRM 客服套件 pack 形状与安装链路

「CRM 客服套件」pack SHALL 以谦面市场 pack 发布：manifest 含客服接待商家变体技能（account_id 经 profile 发现、不硬编码；含 BYOK 使用说明与失败纪律）与 MCP 引用（`registryName: "chatwoot"`，整面声明 fullSurface——有效面由平台操作员面收口为 98-leaf 标准面，pack 不另持名单副本）。安装 SHALL 走既有本地绑定通道：已连接用户即时绑定本地行；未连接用户记 awaiting-local-binding 并给连接指引，连接完成后绑定自动激活（无需重装 pack）。订阅安装后市场可搜到、安装报告如实、技能可经斜杠命令调用。pack MUST NOT 携带或转移任何秘密。

#### Scenario: 已连接用户一步安装生效

- **WHEN** 已连接 chatwoot 的商家订阅 CRM 客服套件
- **THEN** 安装报告绑定本地行，其聚焦角色工具面=操作员 98-leaf 标准面（整面声明被操作员面收口），技能可调用

#### Scenario: 先装后连自动激活

- **WHEN** 未连接的商家先订阅 pack 再完成 chatwoot 连接
- **THEN** 该 MCP 引用从 awaiting-local-binding 转为绑定，下次组合即生效，无需重装 pack

### Requirement: 多租户隔离与 BYOK 纪律

商家的全部 Chatwoot 访问 SHALL 以其自带凭据执行，租户边界由 Chatwoot 账号作用域保证：商家的工具调用与动作执行 MUST NOT 能读或写其他租户（含寻数 A 租户）的会话、联系人或报表。平台 MUST NOT 聚合存储商家 token 于任何共享服务或日志；连接面凭据按用户隔离存取。商家询问租户隔离机制时，文档 SHALL 如实说明「你的 token 只见你自己的 Chatwoot 账号」。

#### Scenario: 商家只见自家租户

- **WHEN** 商家用自己的 token 列会话、发消息
- **THEN** 返回与写入仅涉其 Chatwoot 账号的数据，不出现寻数 A 租户或其他商家内容

#### Scenario: 凭据不出现在共享面

- **WHEN** 检查 pack 内容、市场条目、日志与审计记录
- **THEN** 无任何商家 token 或密码明文
