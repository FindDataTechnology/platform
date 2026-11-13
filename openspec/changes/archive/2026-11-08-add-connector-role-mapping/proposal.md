## Why

垂直包现在只能声明**具体厂商**（`provider: "kingdee"`）。凡客户用的系统没有稳定品牌或不在目录里，包就只能写业务角色名（`provider: "wms"`、`carrier-portal`、`supplier-portal`）——而解析层按 service id 查目录，角色名必然落到 `unwired`，**且永久**：客户接任何账号都关不上那条。非 optional 时更糟，安装门永久挂一条用户无从处理的项（2026-11-08 供应链包就是这样，见 `fd-erp-vertical-templates/docs/connector-onboarding-supply-chain.md` §4）。

写死真厂商（`wms → wangdian`）只服务「恰好用这家」的客户，换一家就要改包重发；而「客户自己的 WMS 是哪个」本来只有客户知道。缺的是一层：**包声明要什么（角色），客户声明自己用哪个（系统）**。

## What Changes

- **声明新增角色形态**：绑定可带 `providerRole: true`，此时 `provider` 是角色名（业务语义词，非连接器 service id），角色名即映射键。未带该标记的绑定行为完全不变。
- **每用户角色映射**：平台按 `(用户, 角色)` 维护一条映射 → 连接器 service id。映射落库、幂等写入、可改可清。
- **候选来自用户已连通的连接**：修复路径是「先在自己的连接器里连上你的 WMS，再回来选」。不做全目录浏览——连接器租户侧没有目录检索端点（只有逐 provider 的 `catalog-coverage`），而候选本来就该是「你有账号的系统」。
- **新台账状态 `unmapped`**：角色已声明但用户还没选系统。它既不是 `unwired`（目录能力缺口，用户接账号也补不上），也不是 `missing`（用户已选定但没连）——三者的修复动作不同，界面给的动作也不同。计入待处理（非 optional 时包不算「已接通」），计数单列。
- **映射后的解析不变形**：映射到某 provider 后按既有规则校验目录覆盖与连接存在；覆盖不足报 `unwired` 并指明缺口（界面提供「换系统」重映射），有映射但无该连接报 `missing`。**MUST NOT** 在映射的 provider 不可用时静默改用 `alternativeProviders`——那等于替用户改选。
- **状态面与路由**：`/api/connections` 投影增加 `providerRole`、`role`、`unmapped` 计数与候选列表（仅已连通且目录覆盖所声明操作类的 provider）；新增映射读写端点。
- 无 **BREAKING**：不声明 `providerRole` 的包、以及所有既有台账行语义不变。

## Capabilities

### New Capabilities
- `connector-role-mapping`: 角色到 provider 的每用户映射——声明形态、候选来源、映射生命周期（选定/改选/清除）、与绑定解析和注入的接合点。

### Modified Capabilities
- `connector-bindings`: 台账状态闭集增加 `unmapped` 并定义其语义与不退化规则；解析在 `providerRole` 绑定上经角色映射取 provider；安装门与状态投影计入 `unmapped`。

## Impact

- 代码：`connector-bindings.js`（解析分支、状态常量）、新迁移（映射表）、`server/routes/connector-bindings.js`（映射端点）、`server/routes/misc.js`（连接面投影与计数）、web 连接器卡的绑定视图（选择与改选入口）。
- 数据：新增映射表；既有台账行不改写（`providerRole` 是声明属性，回填只影响后续解析）。
- 对侧连接器：**零改动**，只用既有两个自省面（`catalog-coverage`、`connections`）。已确认租户侧无目录浏览端点，方案不依赖它。
- 对侧模板仓（另立 change，不在本 change 内）：`providerRole` 绑定需要允许非 optional（用户可自行闭环）并放宽当前「角色名只能 optional」的机器门。
- 存量：供应链包的三条角色绑定在映射层落地后从永久 `unwired` 变成可闭环；具体改用哪些角色绑定、是否恢复非 optional 由模板仓的 change 决定。
