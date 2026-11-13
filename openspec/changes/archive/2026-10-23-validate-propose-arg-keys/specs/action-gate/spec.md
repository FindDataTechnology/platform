## ADDED Requirements

### Requirement: 提议参数按注册表声明校验与归一

注册表每个受闸动作 SHALL 逐字声明底层工具接受的参数名集合（`argKeys`）与其中的必填子集（`requiredArgs`），以工具源码签名为唯一真源；动作 MAY 为某参数声明别名（`argAliases`）。闸在接受提议时 SHALL 把模型给出的键名归一到声明名（逐字 → 驼峰/下划线对偶 → 声明别名），丢弃声明之外的键；归一后仍缺必填键（空白字符串视同缺失）的提议 SHALL 以 400 拒绝、MUST NOT 落为 pending 行，拒绝体 SHALL 列出缺失键与该动作的完整期望键名，使模型可在同一回合自纠。该校验 SHALL 位于 preflight 之后：缺凭据的提议仍先得到连接指引。平台提供给副驾的 `propose_action` 工具 SHALL 在其参数描述中逐动作列出声明键名并标明必填，MUST NOT 把参数描述为对闸不透明。

#### Scenario: 模型按惯用拼写提议可见性变更

- **WHEN** 副驾对 `facet.pack.visibility` 提议 `{ packId, packName, visibility }`
- **THEN** 落账参数为 `{ id, visibility }`（`packId` 归一为 `id`，`packName` 丢弃），影响面文案含该包 id 而非「undefined」

#### Scenario: 缺必填键的提议不落库

- **WHEN** 副驾对 `facet.pack.visibility` 提议 `{ packName, visibility }`，不含任何可归一为 `id` 的键
- **THEN** 闸返回 400，拒绝体列出缺失的 `id` 与期望键 `id, visibility`；`action_proposals` 不新增行，副驾可见的工具结果含该键名清单

#### Scenario: 缺凭据先于缺参数

- **WHEN** 用户未连接该线凭据，且提议体同时缺必填键
- **THEN** 闸以 preflight 失败拒绝并给出连接指引，而非参数键名清单

#### Scenario: 萬星动作驼峰拼写落到上游下划线参数

- **WHEN** 副驾对 `wanxing.agent.pause` 提议 `{ packId, agentId }`
- **THEN** 落账参数为 `{ pack_id, agent_id }`，与 `wanxing_agent_pause(pack_id, agent_id)` 签名一致，影响面文案不含「undefined」
