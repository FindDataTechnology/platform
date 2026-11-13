## Why

`dsh-plugin-supply` 规定"只烘入、运行期不装"，但它管的是**来源**，没管**贡献内容**。合成 profile 的那一步只去重我们自己写入的两行——`dsh-profile.js:316` 的过滤条件是 `r.id === "llm-pi-ai" || r.id === "spill-policy"`，其余补丁行"原样保留"。而 `cordis.patch.yml` 的语义是"bundle 层之后应用的补丁层"，所以**任何被烘入的 bundle 贡献的插件行都会原样进合成树**。

后果不是理论上的：一个换了 id 的插件（`{id:"vendor-llm", name:"@acme/dsh-llm-router"}`）能注册自己的 LLM 路由——绕过"模型必须走萬星词元"的裁决，且不进计费台账；一个自带工具注册的插件绕开 `capByOperatorFace` 与席位级工具面；一个读环境变量的插件能碰到 scoped relay token。

今天这套闸门全都假设"扩展是声明式的"（包 manifest 不带端点、不带凭据），而插件是代码。所以供给面每放开一格，这些假设就漏一格。本变更把三条假设升级成**运行期可判定的断言**，先把门关上，再谈供给。

## What Changes

- **路由独占断言**：profile 合成完成后校验——合成树里任何 `llm` / `provider` 形态的插件行，只允许来自平台自身的写入；出现第三方来源的行即**拒绝启动**并指名该行。fail closed，不降级。
- **工具面封顶覆盖插件**：插件贡献的工具其服务名 SHALL 参与同一次 `capByOperatorFace` / 席位级 `agents[].resources.mcpTools` 裁剪；未在席位声明里出现的插件工具 SHALL 不可调用（403 + 台账一行），而不是"默认全开"。
- **凭据面机器检查**：把审校手册的 S6（"零平台凭据材料"）从人读升级为出片期机器检查——profile patch 与 bundle 声明里出现平台凭据键名（relay token / registry admin / sub2api）即拒绝出片。
- **供给声明收紧**：烘入白名单的每个 bundle SHALL 声明它**可能贡献的服务类别**；声明类别之外的贡献（自注册 llm 路由、自建凭据通道、自起渠道进程）在合成期即被拒。
- **拒绝可归因**：三种拒绝都 SHALL 落一条具名记录（哪一行、哪类越界、哪个 bundle），而不是只打印一句"启动失败"。
- **不改**：`dsh-plugin-supply` 的"运行期不装/不构建"不变；bundle 白名单机制不变；`writeLlmProfile` 的产物形状不变；已烘入 bundle 的启用/停用语义不变。

## Capabilities

### New Capabilities

- `plugin-supply-gates`: 被烘入 bundle 的**贡献面**约束——路由独占断言、工具面封顶覆盖插件工具、凭据键机器检查、贡献类别声明与越界拒绝、拒绝的具名可归因。

### Modified Capabilities

（无。`dsh-plugin-supply` 的既有要求全部继续成立；本变更只新增对"贡献内容"的约束。）

## Impact

- **dsh-profile.js**：合成后新增 `assertRouteExclusivity(composedRows)`（纯函数 + 可注入），在写盘前与启动前各调一次；越界抛具名错误。
- **dsh-bridge.js**：启动路径把该断言接到 ready 之前；失败按"启动失败"处理（不进入半可用态）。
- **lib/full-mode-tool-scope.js**：`presentServers` 来源扩到"插件贡献的服务名"；`capByOperatorFace` 语义不变（仍是求交，空交集仍是空）。
- **server/agent-session.js** / 席位工具面：插件工具未在席位声明时从可用集合中剔除。
- **lib/scoped-relay-token.js** / 出片脚本：新增凭据键扫描（patch + bundle 声明），命中即非零退出。
- **bundle 声明**：白名单条目增 `contributes: ["tool"|"skill"|"ui"|"service"]` 与 `forbids` 默认集（`llm` / `credential` / `channel`）；`dsh-matrix` 与 profile 模板两处同步。
- **测试**：新增 `scripts/test-plugin-route-exclusivity.mjs`（第三方 llm 行必须被拒，正反两例）、`scripts/test-plugin-tool-face-cap.mjs`（插件工具未声明 = 403）、`scripts/test-plugin-credential-surface.mjs`（凭据键命中即拒出片）、`scripts/test-plugin-contribution-class.mjs`（类别外贡献被拒）。
- **兼容性**：三条断言只对被烘入的 bundle 生效，今天白名单里的 bundle 全部属于"工具/技能/UI"类别，预计零拒绝；任何拒绝都说明白名单里有未审的贡献类别——这正是闸门的意义。
