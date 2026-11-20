# Blueprint Studio Slice 1 原型（非权威实现底稿）

> 复产件，配套 `add-blueprint-studio` 的 apply 底稿。**非权威**：权威契约以
> `openspec/changes/add-blueprint-studio/` 的 spec delta 为准；规格的实现指引见
> `../blueprint-studio-implementation-notes.md`。工程栈与命名轨同仓存档
> `add-ai-native-lexicon`。

## 文件 → apply 时落点

| 原型文件 | apply 时落点 | 备注 |
|---|---|---|
| `blueprints-db.js` | `server/routes/blueprints-db.js` | 工厂注入（见校准①） |
| `blueprint-validate.js` | `server/blueprint-validate.js` | 校验链四段（见校准②） |
| `blueprints.js` | `server/routes/blueprints.js` | REST 面（批准/铸造两段纪律） |

挂载点：`server.js` 在 `createFleetRoutes(app, ctx)` 之后 `app.use(createBlueprintRoutes(ctx));`
（import 同仓其他特性工厂的同样写法）。

## 复产三处校准（按请求方口径落地）

1. **db 路径构造器注入**：`blueprints-db.js` 导出 `createBlueprintDatabase({ file } = {})`（签名镜像 `fleets-db.js` 的 `createFleetDatabase`），内部 `file || path.join(storeDir("data"), "blueprints.db")`。**不读环境变量**——生产默认文件、测试参注入 tmp 实例；路由 `createBlueprintRoutes(ctx)` 吃 `ctx.blueprintDb` 优先、缺省自建。
2. **商业集腿不跳过（consult 模式）**：`blueprint-validate.js` 第四段经 `lib/publish-tool-gate.js` 的**同步导出** `toolFaceErrors` + `toolClosureErrors`（errors 形状与 validatePackManifest 一致、`{error, entry}`）——reuse 不当第二造；异步带探针的 `toolGateErrors` **留在发布门**，本文件不调用。
3. **`parseFleetTemplate` 形状**：单对象 `{ ok:false, error }`（非数组）——本原型中使正确形态且未引用 `resolveFleetTemplateParams`（那是另一入口、errors 数组形状，蓝图 leg 不用）。

## 复产期发现的两处修正（已入原型）

- `blueprints-db.js` 的 `paths.js` import 深度纠错：本文件在 `server/routes/` 下需 `../../paths.js`（首版写 `../` 已被冒烟抓出）。
- shape 闸新增「内联物件下限」提示：过少物件时（skills/agents/mcpServers/bots 全空）报错**作者侧友好原文**，替代过铸时撞发布门才反馈的「a pack must contain at least one skill, MCP reference, agent, or bot」。

## 冒烟证据（2026-10-27，paas 依赖链真跑）

`/tmp/bp-sandbox` 内镜像仓布局 + symlink paas/node_modules 与 lib/fleet-template/paths 实测：

- 校验链：good 蓝图全绿 `ok=true`；`secret` 凭据键被 shape 闸捉；双 ref 被 `parseFleetTemplate` 捉（`duplicate member ref 'watch'`）；未声明 tool face 的 MCP 引用被 consult 腿捉（stage=`toolface`）；`allowTools` 声明后放行；`diffBlueprint` 字段级生效。
- 实体生命周期：create v1→edit v2 并清批准→错误 expectVersion 拒绝→approve→cast（版本/状态各段符合形状）。

首版两处冒烟发现的问题均已反馈进原型（上两节），请 apply 会话以本版本为底稿。

## 测试范式

路由接受 `ctx = { authEnabled, cellUserEmail, resolveUser?, blueprintDb?, publishClient? }`——`resolveUser` 与 `publishClient` 注入式（不重发真市场门），`blueprintDb` 注入 tmp-file 实例。配 `node --test scripts/test-blueprints.mjs` 的 run 点在 notes 文档 §3.4。

## 纪律再确认

- 批准两段纪律（对话级 + apply 重校验兜底）：`updateBlueprint` 版本+1 并清旧批准已实现；铸造闸仅在 `status='approved'` 且当前草稿重跑校验全绿时放行。
- 校验链无第二造：shape 闸→`parseFleetTemplate` 零翻译→`validatePackManifest`→tool-face consult。凭据键扫描不碰「target/registryName/allowTools/requiredGroup」契约白名单。
- 铸造 `_casting` 追溯齐头（blueprintId/version/approvedBy/approvedAt/diffSummary），市场条目可溯。