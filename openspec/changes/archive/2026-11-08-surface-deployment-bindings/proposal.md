# 部署结果必须说出绑定的真实结局

## Why

`add-deployment-binding-grant` 让部署期由部署者预铸绑定令牌，服务端已把
`deploymentBindings.{granted,failed,revoked}` 放进部署响应——但**界面没有任何落点**。
后果是那句最危险的话：一个绑定没铸成，岗位照样显示「已部署」，而它接不到本该接的系统；
部署者要等到第一次调用失败才知道。铸造失败又恰恰是常态（账号没连、范围空、本部署没接连接器），
不是异常路径。

## What Changes

- 部署面板在提交后如实呈现三类结果：已就绪（数量 + 绑定键）、未就绪（数量 + 键 + 原因）、
  本次撤销的令牌数。原因按服务端的铸造拒绝码分档（`no_account` / `empty_scope` /
  `connector_not_configured` / 其他带码兜底），因为每一种的修法不同。
- 只呈现名字与键：令牌值不进浏览器（与 D6 一致）。

## Impact

- 受影响能力：`connector-bindings`（新增一条呈现要求）
- 代码：`web/src/components/packs/PackDetailDialog.tsx`、`web/src/lib/packs-api.ts`
  （`DeployResult` 增可选 `deploymentBindings`）、5 个语种文案
- 不改变任何服务端行为；不改动既有面板结构
