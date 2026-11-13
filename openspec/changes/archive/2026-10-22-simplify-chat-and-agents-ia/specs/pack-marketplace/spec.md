## MODIFIED Requirements

### Requirement: Subscribing ends with a next-steps wizard

The subscribe success report panel SHALL append a next-steps footer that takes the user straight into a conversation with what they just installed — no manual re-selection step:

- 单角色功能集：footer 的按钮 SHALL 携带该功能集默认角色的 agent 标识导航到
  `/chat?preset=<agentId>`（openspec: web-chat-ui, 非 embed 导航的预设深链），
  对话页在连接就绪后自动选中该角色；hint 文案 SHALL 不再指示用户手动去
  「上方选择框」选人。
- 多角色且声明集群元数据的功能集：footer SHALL 以「去对话并载入整组」为
  主按钮，导航携带该集群的 lead 角色标识与整组载入意图，落地后按既有动态
  集群路径绑定会话并切到 lead（openspec: agent-preset-selection, 统一的
  「与谁对话」选人面）；无可用 lead（如全部角色安装失败）时按钮退化为普通
  「打开对话」。
- 无角色条目的功能集（纯技能/工具包）：footer 保持普通「打开对话」按钮
  （裸导航），hint 说明能力已就绪。

footer 保留与报告一致的关闭（dismiss）语义；报告本身的逐部件状态、脱敏与
关闭行为（openspec: pack-installation）不变。On the facet shell — where no
conversation view exists — the next-steps footer SHALL not render, and the
report panel itself SHALL be unchanged.

#### Scenario: the report offers the next step

- **WHEN** a subscription succeeds for a single-role pack and the report panel renders on 壹座
- **THEN** the panel shows the next-steps footer with an open-chat button carrying `preset=<default agentId>`
- **AND** activating the button navigates to `/chat?preset=<agentId>`, dismisses the report, and the chat auto-selects that role once connected

#### Scenario: cluster pack offers load-the-group

- **WHEN** a subscription succeeds for a pack declaring cluster metadata with a lead role
- **THEN** the footer's primary button is 「去对话并载入整组」 and lands the chat with the cluster bound to the session and the lead role active

#### Scenario: skill-only pack keeps plain navigation

- **WHEN** a subscription succeeds for a pack with no agent entries
- **THEN** the footer shows a plain open-chat button with no `preset` parameter

#### Scenario: the facet report ends without the wizard footer

- **WHEN** a subscription is recorded on the facet shell and the report panel renders
- **THEN** the report panel shows its per-part statuses and close affordance
- **AND** no next-steps footer or open-chat button renders
