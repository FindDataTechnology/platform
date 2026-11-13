# add-connector-bindings

## Why

包已经在声明自己需要哪些外部系统：`fd-erp-vertical-templates/templates/supply-chain/connector-pack/pack.json` 的 `connector_bindings` 列了五条（金蝶云星空 / 客户 WMS / 支付渠道 / 供应商门户 / 承运商门户），每条写明 surface、direction、BYOK 凭证键。但全工作区检索确认：**这个字段没有任何代码消费者**。安装不校验、界面不提示、`provider_status` 是散文、`NOT_WIRED` 靠人自觉。

壹座侧的连接能力则处在另一个极端：一枚活跃账号的全权 connector PAT 注入全局 `connector` MCP 行，agent 拿到的是「本用户全部 SaaS 连接 × 目录 1571 个 provider」。包声明的窄面与凭证的全权之间没有任何一层。

对侧的 `scoped-pat-grants`（open-connector-mt）补上了「签得出带范围的 PAT」。本变更负责另外两件事：**范围从哪来**（包的声明）与**谁替用户解析它**（壹座的绑定台账）。

## What Changes

- **`connector_bindings` 从散文变机器字段**：每条绑定 SHALL 携带 `key`、`provider`（连接器 service id）、`allowOperations`（`(provider, operationType)` 粒度的授权单元）或 `allowActions`（精确 action id，可选加严）、`connectionHint`、`optional`、`alternativeProviders`。既有 `external_system` / `surface` / `note` 保留为人读字段。字段形状与 `fleet-packs/blueprints/schema.md` 既有的 `mcpServers[].allowTools` 同族——同一套「声明窄面、发布门裁定 ⊆ 实际能力」的纪律。
- **绑定台账（binding ledger）**：壹座 SHALL 按 `(user, pack, binding key)` 记录解析结果——解析到的 connector connection id、状态、最近解析时间。状态闭集 `satisfied` / `missing` / `stale` / `unwired`；`unwired` 专指「provider 在目录里但兑现不了声明的 surface」（如金蝶 12 个通用 action 覆盖不了发票开具回写），是有依据的如实报告，不得退化为 `missing`。
- **安装/启用门**：带 `connector_bindings` 的包在安装或激活时 SHALL 逐条解析；未满足的非 optional 绑定 SHALL 阻止「就当已接通」，并以一个授权弹窗列出全部声明绑定供用户一次授予（声明式授权）；optional 绑定未满足只降级并记录。
- **注入改单轨**：全局 `connector` MCP 行退役，改为按绑定注入 `connector:<binding>` 行，每行携带该绑定独立的 scoped PAT（对侧 `scoped-pat-grants` 铸造）。**BREAKING**：`connector-credentials` 的「活跃账号唯一且决定注入」语义取消——账号退化为「凭证来源」，绑定各自选账号，缺省主账号。
- **渐进授权（聊天车道）**：聊天车道的自由探索绑定从空范围起步；执行因范围不足被拒时，SHALL 归类为「范围不足」而非「凭据失效」，渲染「去授权：<provider> · <读/写>」卡；用户点选后 SHALL 重铸该绑定 PAT（范围并入）并在下一轮生效。复用 `chat-connect-guidance` 既有的 `connect` 指针通道，新增一个 scope 维度。
- **连接状态面接入绑定**：`GET /api/connections` 的 connector 条目 SHALL 追加绑定投影（按包分组的绑定状态与未解析项），设置面卡片 SHALL 展示「N 个包需要 M 个绑定，K 个未解析」并逐条深链到「去连接」。
- **存量迁移**：已有单账号用户 SHALL 平滑迁移为「主账号 + 一条内置自由探索绑定（保留今日行为，显式可见可撤）」，不丢失既有连接。

## Capabilities

### New Capabilities

- `connector-bindings`: 包声明外部系统面、壹座解析成绑定台账、按绑定铸造 scoped token 并注入、状态闭集与授权弹窗的完整语义。

### Modified Capabilities

- `connector-credentials`: 「活跃账号唯一且决定注入」→ 账号为凭证来源、绑定各自解析、按 `connector:<binding>` 多行注入；「设置面板卡片」扩为绑定视图。
- `connection-center`: 「只读连接状态聚合端点」扩出绑定投影；「设置分节」的 connector 卡片承载绑定状态与深链。
- `chat-connect-guidance`: 凭据类失败之外新增「范围不足」一类，指引目标从「去连接」扩为「去授权」，同一 `connect` 指针通道加 scope 维度。

## Non-goals

- **不做连接器侧改动**：铸造端点、策略求交、拒绝语义归对侧 `scoped-pat-grants`（open-connector-mt）。本变更只消费。
- **不做 served agent / 访客接入**：萬星 served agent 按部署者身份解析绑定属下一轮 change（③），其前置是 `SERVICE_OBO` 从 `allow-all` 翻到 `consent`。
- **不做桌面零粘贴**：桌面版（本地 origin）零粘贴需回环配对方案，独立 change（④）。本变更只保证绑定解析不依赖浏览器 origin。
- **不改 `fleet-packs/blueprints/schema.md`**：蓝图书新增字段需与该仓一起动，而 `fleet-packs/` 位于 finddata 根（非 git 仓，无 diff 兜底），单独裁定后再动。
- **不做按 provider 的目录策展 UI**：绑定声明从包来，不从目录逛出来。

## Impact

- **代码**：`connector-credentials.js`（slot 语义重读、去掉全局活跃注入）、`dsh-profile.js`（按绑定注入多行 `connector:<packId>:<bindingKey>`）、`credential-refs.js`（新增按绑定分发的 ref）、安装/激活路径（绑定解析门）、`web/src/components/settings/ConnectionsSection.tsx`（绑定视图）、`pack-store.js` / manifest 校验（`connector_bindings` 形状校验）。
- **API**：`GET /api/connections` 响应加绑定投影；新增绑定台账读写端点（解析、授权、撤销）。
- **DB / 存储**：绑定台账随既有凭据存储层落盘（与 `connector-credentials.js` 同键控与退化规则），`auth off` 退化到 machine-owner。
- **依赖**：对侧 `scoped-pat-grants` 的铸造端点（硬依赖，先落）。
- **迁移**：存量单账号 → 主账号 + 内置自由探索绑定；旧全局 `connector` 行下线需保证已装会话不因缺行而报错。
- **验收**：`pack-store` 校验用例（坏绑定声明被拒）、绑定解析用例（四态各一）、注入用例（多行各自独立 token、失效只落该绑定）、授权卡用例（范围不足 → 点击 → 下一轮通过）、迁移用例（存量不丢）、`openspec validate add-connector-bindings --strict`。
