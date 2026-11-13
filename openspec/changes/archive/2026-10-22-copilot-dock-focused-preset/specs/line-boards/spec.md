## MODIFIED Requirements

### Requirement: 看板定义副驾的动作边界

看板 SHALL 声明该线上可执行的动作集合，每个动作 SHALL 标明名称、风险等级与目标对象；该集合 SHALL 是动作闸注册表在该线的子集。动作闸 MUST NOT 提议或执行注册表之外的动作。以聚焦 pack 预设运行的副驾会话，其可见工具面 SHALL 只含预设声明的读工具与 `propose_action`，看板未声明的写操作因此不出现在其工具面。

从线看板打开的副驾 dock SHALL 注入该线的聚焦助手预设（见 `web-chat-ui`「副驾 dock 注入聚焦预设并在关闭后恢复」），使「副驾在闸内」成为默认而非约定。某线的聚焦助手 SHALL 由壹座按形状从已安装 pack 中解析：每条 MCP 引用都声明非空工具白名单、白名单不含动作注册表登记的任何写工具、引用的服务器全部属于该线、且 pack 至少有一个已安装的 agent；解析 MUST NOT 依赖特定 pack id 或 pack 名称。该线无可用聚焦助手时，dock SHALL 以未聚焦态明示，MUST NOT 伪称副驾处于闸内。

#### Scenario: 板上没有的动作闸也不执行

- **WHEN** 副驾或看板对「删除包」发起提议（谦面看板未声明该动作）
- **THEN** 动作闸以动作未注册拒绝，不调用任何底层工具

#### Scenario: 聚焦副驾会话看不到写工具

- **WHEN** 以「谦面助手」聚焦预设打开副驾会话
- **THEN** 可见工具面只含该 pack 声明的读工具与 `propose_action`，不含 `facet_market_pack_visibility` 等写工具

#### Scenario: 按形状解析该线的聚焦助手

- **WHEN** 已安装「谦面助手」pack（只引用 `facet-market-mcp` / `facet-ops-mcp`、每条引用都声明只读白名单、含一个已安装 agent）并请求谦面线的聚焦助手
- **THEN** 解析返回该 pack 的 agent；同一请求对萬星线返回空，因为它未引用萬星线的服务器

#### Scenario: 含写工具的 pack 不是聚焦助手

- **WHEN** 某 pack 的白名单含 `facet_market_pack_visibility`
- **THEN** 它不被解析为任何线的聚焦助手，即使其余规则都满足

#### Scenario: 无聚焦助手时明示未聚焦

- **WHEN** 该线没有任何满足形状的已安装 pack，用户从该线看板打开副驾
- **THEN** 副驾上下文条显示未聚焦及原因，dock URL 不携带预设参数
