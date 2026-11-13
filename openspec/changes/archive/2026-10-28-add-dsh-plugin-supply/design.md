# 设计：add-dsh-plugin-supply

## Context

2026-10-27 spike 实证（全部可复跑，scratch 树 `/tmp/dsh-021-rc4` 配方在案）：

- **服务已在场**：`@deepseek-ai/dsh-base` 的 bundle patch（`cordis.patch.yml:20`）
  组合 `plugin-manager`（gate `!profileContext`，profile 启动下为启用），cordis
  服务键 = `pluginManager`；`dsh-app-boot` 在 profile boot 下设 `profileContext`。
  `tool-plugin-manager`（agent 工具）默认 `disabled: true`。
- **版本门口径**（`dsh-app-boot` `evaluatePluginCompatibility` 实读）：插件自带
  `engines.dsh` 只看它；否则**每个** `@deepseek-ai/dsh` / `dsh-*` peer 必须满足
  运行时版本（prerelease 参与）。非该 scope 的 peer 不查 → 第三方 bundle 在
  0.2.0-rc.2 矩阵上今天可装；官方家族（browser-use 等钉 `dsh-brand` 同代）必须
  矩阵≈家族代（挂账 `port-dsh-0.2.1`）。
- **解析锚**：loader 从**profile 目录**向上解析（实测 `Cannot find package …
  imported from profiles/platform/`）；cell 的 `linkProfilePinnedModules` 把部署
  共享树链进 fresh `DSH_HOME/profiles/platform/node_modules` 正是此机制。
- **启停写语义**（官方 README）：toggle = 在 profile `cordis.patch.yml` 的最后一个
  匹配覆盖里改 `disabled`，无匹配则追加覆盖；层优先级 = bundles → cordis.patch.yml
  → `--patch` 覆盖。平台 `--patch` 覆盖层（llm/mcp/presets/permissions…）不含
  bundle 行，不与此冲突。
- **生效通道**：`dsh-hmr` 在 profileContext 下启用，watch profile manifest 与
  home/profile patch 文件后串行化 hot recompose；若确认 watch 面覆盖 cordis.patch.yml
  则 toggle 热生效，否则落既有 `dshBridge.restart()`（session id resume）——
  与 set_model 生效族同源。
- **CLI 路死**：npm 装的 `dsh` 拒绝 plugin 包管理请求（README 明示）；cell/桌面
  无 pnpm；构建脚本审批（pendingBuilds/allowBuilds）只有官方 Web UI 有入口。

## Goals / Non-Goals

**Goals:**
- 把 profile 内既有的 `pluginManager` 服务接出为平台 RPC + REST + UI，v1 覆盖
  「只读清单 + 启停」两动作。
- 白名单供给全走部署期烘焙（matrix/lock + template bundles），运行时零包管理。
- 生效与隔离语义对齐既有族（model 切换 / per-cell profile）。
- 为官方家族 bundle 留好通道：0.2.1 移植落地后官方 browser-use 以同一面供给。

**Non-Goals:**
- 运行时自助装包（pnpm 供给、构建脚本审批 UI、版本门豁免 UI）——挂账。
- agent 自助装包 / `tool-plugin-manager` 开闸——本版保持关闭。
- 自助安装第三方 bundle 的安全审查面。
- 与 pack/技能/市场体系的词汇与 UI 合并（dsh 插件是独立层，见 D5）。

## Decisions

### D1：接出走模板桥 RPC，不走 CLI / 直改 YAML

`dsh-profile-template/` 新增 `platform-plugin-supply-bridge.js`（照
platform-permission-bridge 族：子类 `HarnessSdkJsonRpcServer`，ctx 内取
`pluginManager` 服务），暴露：

- `plugins/list` → 调服务的 bundle 清单语义（含 enabled/相位/错误元数据；
  相位不足时以 loader entries 投影补齐）。
- `plugins/set_enabled` → `{ entryId, name, enabled }` 三元入参，走服务的
  toggle 写语义，落 profile `cordis.patch.yml`。

**备选**：(a) `dsh plugin` CLI——npm 安装被拒，死；(b) server.js 直接改
cordis.patch.yml——绕过服务的匹配/排序/审计语义，且 HMR 触发面不确定，
双写真相；(c) 复用 agent 工具 plugin_manager 通道——agent 面本版关闭。
服务桥是唯一单真相路径。

### D2：白名单 = matrix 烘焙 + template bundles 声明，runtime 零安装

运营供给一个 bundle 的三件事，全部发生在部署期：
1. `dsh-matrix/package.json` 增意图行 + 重生成 lock（peers 时代前的现流程）；
2. `prune.json` 复核（新包闭包内被 dsh-base 插件表零引用的部分照剪；
   白名单 bundle 本体显式移出剪枝名单——boot 门 `dsh-matrix-verify` 同评审）；
3. `dsh-profile-template/package.json` 的 `dsh.profile.bundles` 追加声明
   （顺序即层序，追加在尾）。

cell 侧 `linkProfilePinnedModules` 需把白名单 bundle 闭包纳入钉链
（实施任务：确认现链是名单制还是整树；名单制则扩展名单）。

**备选**：运行时 pnpm 装包进每 cell profile——pnpm 供给/审批 UI/构建脚本
信任模型三大阻断，挂账。桌面 predist 与镜像同源，无新增路径。

### D3：生效 = HMR 优先、restart 兜底，拒绝语义同 set_model

实施第一任务实证 HMR watcher 是否覆盖 home/profile patch 文件改动触发热重组
（README 语义说覆盖；实证为准）。覆盖则 toggle 热生效（零重启，体验优于
model 切换）；未覆盖则 `dshBridge.restart()`（presets/skills patch 同族先例，
session id resume）。流式中拒绝（`isStreaming` 守卫），与 set_model/set_preset
同族。

### D4：隔离 = profile 自身，云桌面同构零特判

toggle 只写各 profile 的 `cordis.patch.yml`：云 cell 每用户独立 DSH_HOME →
per-user；桌面每机 → per-install；无共享资产改写、无跨用户泄漏。不引入
角色门（cell 内天然单用户）——与 SSO overlay 无交互。

### D5：分层与词汇——dsh 插件 ≠ MCP ≠ skill ≠ pack

dsh bundle 是运行时组合层（cordis patch 层），与 MCP（工具供给）、技能
（prompt 供给）、pack（产品形态）四层各司其职。UI 命名「插件」（英文 Plugins），
与官方 Plugins 页对齐；不与 extension-marketplace 合并（后者是 MCP/skill 目录市
场，v1 不混入 bundle 条目）。

### D6：agent 面 `tool-plugin-manager` 本版关闭

dsh-base 默认关闭即正确终态。未来开闸（agent 自助装包）需审批闸设计 +
构建脚本信任模型 + cell 沙箱评估，独立立项。

### D7：spec 落点——新能力 `dsh-plugin-supply`，UI 并入 extension-management-ui

机制契约独立成 spec（参照 agent-preset-selection / permission-mode-selection
同族独立能力）；Settings 第三区块并入 extension-management-ui 的既有
「区块归属」requirement。

## Risks / Trade-offs

- **HMR 热重组面不确定**：①实证后若必须 restart，体验退回 set_model 族
  （可接受）；②HMR 对 `--patch` flag 层不 watch（README 明说 HMR 只看
  manifest+home/profile patch），正好我们的 toggle 只写 cordis.patch.yml——
  语义自洽，但叠加代际行为要合同钉住。
- **白名单 bundle 剪枝误伤**：新 bundle 闭包若被 prune.json 泛匹配剪掉
  → boot 门拒启或静默缺席。缓解：prune 复核入任务、boot 门证据链同评审、
  合同一条「白名单样例 bundle 可组合」。
- **toggle 打破会话**：启停某 bundle 可能卸载会话依赖的服务（如该 bundle
  提供的工具）。缓解：v1 白名单 = 运营已验证集合；restart 兜底会 resume
  但组合已变——与 preset 切换同风险级，spec 只钉「不静默」。
- **0.2.1 移植连带**：0.2.1 预设行化为插件行后，白名单机制不变但官方家族
  解锁；plugin-supply 桥要在 rc.4 候选树复跑合同（挂 port-dsh-0.2.1 的首验任务）。
- **npm install 时的构建脚本**：烘焙期（matrix npm ci）会跑 bundle 的构建脚本
  ——白名单即人工审核闸，运营手册写明此一闸即供应链审查点。
