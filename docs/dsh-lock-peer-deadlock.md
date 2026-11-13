# dsh lock / peer 死结 — 交接单（给桌面/dsh-matrix 车道）

2026-10-08 由 add-doc-studio 的镜像构建链撞到并定位。本文件是**诊断与交接**，不是修复记录。

> **2026-10-09 更新（镜像线修复）**：`/opt/dsh` 矩阵安装行的 `--legacy-peer-deps`（59da7fd 加）已**撤除**并实证——见文末「矩阵行修复实录」。根树（`/app/node_modules`）的 flag 仍必须保留，且根树还剩一个独立缺口（llm-deepseek 的 rc.5 peer 闭包），详见下文。

## 现象（三处同一病根）

| 位置 | 症状 |
|---|---|
| 干净 `npm ci` | ERESOLVE（CI ci.yml、Dockerfile builder 层） |
| `npm ci --legacy-peer-deps`（现已在 release.yml / ci.yml / Dockerfile 三处） | 能装能构建，但**漏装 rc.2 peer 闭包** → CI 单测 `test-agent-notify-bridge` 报 `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-credentials`；镜像内 dsh-matrix 启动门拒（`missing: @deepseek-ai/dsh-*(lock: 0.1.1-rc.2)` 全列），boot 冒烟红 |
| `npm ci --force` / `npm install --package-lock-only --force` | EUSAGE：`lock 与 package.json 不同步`（cordis-plugin-loader@1.0.5、dsh-brand@0.1.1-rc.2 等不在 lock 内） |

## 根因（已实证，非猜测）

两代 dsh 包无法共存于**同一依赖树**：

```
dsh-brand@0.1.1-rc.2   peer → dsh-invariants@^0.1.1-rc.2
dsh-llm@0.0.1-rc.5     peer → dsh-invariants@^0.0.1-rc.5
dsh-llm@0.1.1-rc.2     peer → dsh-brand@^0.1.1-rc.2
```

`npm view` 三处 peer 已核对。rc.2 的 anonymous-user-id/command-feedback/dsh-base 系与 rc.5 的 tools/llm/sdk 系各自要不同代的 invariants/brand，而 npm 的扁平化在同一树里只能留一个版本 → 严格 `npm ci` 必拒。

**已排除的假设**（别再试）：版本字段不同步（已同步 1.3.5）、直接依赖缺失（0/51）、registry 缺包（`0.1.1-rc.2` 存在）、flag 级绕过（见上表，三条全堵）。

## 可行解（按推荐顺序）

1. **上游对齐代际**：把 rc.5 系（dsh-llm/sdk/session 等）统一升到 rc.2 线，或反之；两代不再混装，tree 自然可解析。这是唯一治本解。
2. **显式钉版 + 嵌套解析**：对必须两代共存的包显式声明并使用 `overrides`，或接受 npm 的嵌套多版本布局（lock 里两个 invariants 各挂其子树）。需 `npm install` 重生成 lock 并验证 `npm ci` 通过。
3. **回退"peer 闭包钉死"改动**（4e348c3 那一轮把一批 dsh 包挪进 peerDependencies）：若这些 peer 本不该是 peer，改回 dependencies 即解——这属于该车道的设计决策。

## 修好后请做

- 撤掉三处 `--legacy-peer-deps`（`.github/workflows/release.yml`、`.github/workflows/ci.yml` 两处、`Dockerfile` builder 与 /opt/dsh 两处），它们是症状级缝合，留着会掩盖未来的真依赖问题。
  - **更新（2026-10-09）**：Dockerfile 的 **/opt/dsh 行已撤**（见下）。根树行（`npm ci --omit=dev … --legacy-peer-deps`）**必须保留**——根树同时声明两代（dsh rc.2 运行时 + llm/sdk rc.5 服务），干净安装是必然 ERESOLVE，撤了构建就红。release.yml / ci.yml 的根树同此理。剩下的**真**缺口是根树 rc.5 peer 闭包（见「根树缺口」）。
- 验证标准：`npm ci`（无 flag）绿 + CI 全绿 + 镜像 boot 冒烟绿（`/api/config` + dsh-contracts）。
- 镜像构建可走 `scs001/platform-image-verify` 的 `image-publish` 工作流（公开仓免费 runner，TCR 凭据已配 Secrets，推 hkccr → relay 回灌 ccr）；私仓无 GHA 额度期间它就是构建通道。

## 矩阵行修复实录（2026-10-09，add-doc-studio 镜像线）

**根因修正**：矩阵树（`dsh-matrix/`）与根树是**两个不同的解析宇宙**。矩阵 `package.json` 的 `overrides` 把 rc.2/rc.5 统一成一代，所以矩阵锁**不需要** flag 就能解；59da7fd 把 flag 抄到矩阵行反而制造了缺陷——**npm 11（node:25 自带）在 `--legacy-peer-deps` 下会跳过 lock 里所有 `"peer": true` 条目**，24 个 dsh rc.2 插件闭包（dsh-scope/dsh-session-telemetry/dsh-shell/dsh-spill/dsh-timeout/dsh-workflow… + loose-envify/scheduler）全部不落盘，boot 硬门随即拒绝启动（image-publish run 37784214791 / 37836417702 的 `missing:` 清单就是这 24 个的子集）。

**实证矩阵**（`lib/dsh-matrix-verify.js#diffMatrixTree` 对每个树跑一遍）：

| 安装方式 | 门结果 | missing |
|---|---|---|
| npm 10.9.9 + flag | pass | 0 |
| npm 11.6.1 / 11.12.1 + flag | **fail** | 24（= 镜像 boot 失败清单） |
| npm 10.9.9 / 11.6.1 / 11.12.1 **无 flag** | **pass** | 0 |

即：flag 是缺陷，且只在 npm 11 下发作（本地 npm 10 试验因此假绿——这也是当初 59da7fd「与 release/ci 同款」类推失效的原因）。修复=撤 flag（Dockerfile 矩阵行），已合入。

**残留 2 个可选条目**：`@emnapi/runtime` / `@img/sharp-wasm32` 在 darwin 树里 missing——它们是 sharp 的 wasm 回退，父链（freebsd/wasm32 门）在本平台全不适用；linux/x64（镜像目标平台）下父条目不装，故 gate 的 `platformMatches` 之外这两个仍会记 missing。**但**：镜像构建在 linux/x64 下 sharp-linux-x64 父链成立、两者随闭包落盘（我的 linux 模拟里 wasm32 未装是因为该模拟的父条目也门掉了）——真实镜像 boot 冒烟已过（见 CI），故不是缺陷。

## 第二缺陷：boot 就地改写冻结树（2026-10-09 修复，328b42b）

矩阵行撤 flag 后 boot 冒烟转绿，**首个把 dsh-contracts 跑通的构建**随即暴露下一层：
`dsh-contracts: 1/6 PASS`，② 报 4 包 "resolves outside the candidate tree
(/app/node_modules/...)"，其余五条 "JSON-RPC input closed"（子进程握手即死）。

根因不在矩阵锁而在**平台自己的 boot**：镜像里 `profiles/platform/node_modules`
是指向 `/opt/dsh/node_modules` 的符号链，而 c349578（桌面 v1.3.6 修「healer
残留」）给 `linkProfilePinnedModules` 加了「先清后链」——`rmSync(link)` 穿过
符号链删掉的是**矩阵真包**，再链上 `/app/node_modules` 的 rc.5 副本：冻结树
被就地改写、两代混装。契约②（设计如此）把它抓为 "ancestor install shadowing"。

本地复现链：变异树（按上述方式替换 4 包）→ `dsh-contracts --tree` = **1/6，
同一批 4 包，同一 JSON-RPC closed**，与镜像日志逐字对齐。

更深的隐患：同一容器**第二次** boot 时矩阵硬门会把这 4 条符号链读成
missing → 拒启（崩溃环）。prod 现镜像（sha-9f41c5a）早于 c349578，尚未中招。

修法（328b42b）：moduleDir 自身是符号链 ⇒ 部署供给的树，既有条目一律不动
（缺项仍补链）；真实目录 ⇒ 我方管辖，残留照清（桌面语义不变）。回归
`scripts/test-dsh-profile-links.mjs` 4 案 + 隔离复验（ensureDshHome 后矩阵四包
仍是真目录；同布局 dsh-contracts 6/6）。

## 第三缺陷：应用树 dsh 二进制不可 boot（2026-10-09，f2af032 prod 事故，镜像侧已修）

prod 滚上 sha-f2af032 后**每 cell 的 dsh 子进程**死在：
`ERR_MODULE_NOT_FOUND: @deepseek-ai/cordis-plugin-loader imported from
/app/node_modules/@deepseek-ai/cordis-plugin-group/lib/index.js` → agent init 失败
（chat 显示 No model）；`/api/config` 仍 200（浅路由），已回滚到 9f41c5a。

链路：4e348c3 把 `@deepseek-ai/cordis-plugin-group` 提为根依赖 → npm 提升到应用树
顶层并**删掉嵌套副本**，但其 peer `cordis-plugin-loader` 仍只在 dsh 嵌套树 →
嵌套 `dsh-app-boot` 的 `import Group from "@deepseek-ai/cordis-plugin-group"`
落到顶层副本，group 再导入 loader 即炸。同轮 dsh-bridge 改为**优先 spawn 应用树
dsh 二进制**（桌面打包场景），镜像里于是必撞。本地逐字复现：
`node node_modules/@deepseek-ai/dsh/lib/bin.js --help` 同错。

**镜像侧修法（已合入）**：`ENV DSH_BIN=/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`
——把运行时钉回冻结矩阵树（boot 硬门 + dsh-contracts 6/6 验证的正是它；旧镜像
本就走 PATH→/opt/dsh，无 bundled 优先，此钉=恢复既有行为）。实证：钉后
`/api/ready {"ready":true}`，不钉 503（同错）。

**盲点修复（已合入）**：两管线冒烟补 `/api/ready` 门——`/api/config` 是浅路由，
agent 死了也 200；`/api/ready` 仅在 dsh 握手完成后翻 200。

**应用树侧（桌面线，未修，建议一行）**：把 `@deepseek-ai/cordis-plugin-loader`
也声明为根依赖（`"1.0.5"`，紧邻 group 行）。已实证：临时 symlink 后应用树
dsh 二进制即 boot 成功（`--help` exit 0）。不改则 dev `npm start`、快照 CI 的
dsh 单测、桌面打包树都带着这颗雷。lock 重生成预期 delta=loader 从嵌套移到顶层
（1 增 1 删，无版本变化）。

## 第四缺陷：模块身份双实例——全工具调用挂（2026-10-09，已修 e504ffd）

镜像侧 `DSH_BIN` 钉好后（sha-e956091）agent 起得来、纯文本回合正常，但**任何
工具调用**都死在 `Cannot read properties of undefined (reading 'prepare')`。
浏览器实测复现（bash echo 必挂、无工具对话正常，极易误判为"技能问题"）。

根因=**上一版修复自己引入**：328b42b 的「部署供给的树只补缺项」把
`dsh-tools`/`dsh-session`/`schemastery` 链进 cell 的 profile 模块目录，
目标是**应用树**副本（dsh-tools rc.1 / dsh-session rc.5），而运行时从矩阵树
（rc.2）boot → 同一包两份实例 → `TOOL_RUNTIME_SCHEDULER` 是两个不同的
Symbol → `ctx.tools[SYMBOL]` 取不到 → `undefined.prepare`。

修法（e504ffd）：moduleDir 是符号链 ⇒ 部署供给，**一个条目都不写**（缺项也
不补——矩阵闭包完整，dsh boot healer 自会维护 `profiles/node_modules` 扁平
回退）；并清除**自身旧版注入**的应用树链（只删目标在 APP_NODE_MODULES 下的
符号链）。回归测试扩到 5 案（新增第 5 案：毒链被清、部署真目录与第三方链不动）。

**宿主状态需手工疗一次**（旧镜像不含修复代码，回滚也不会清）：
```bash
kubectl -n fd-prod exec deploy/platform -- sh -c \
  'rm -f /opt/dsh-home/profiles/platform/node_modules/@deepseek-ai/{dsh-session,dsh-tools,schemastery}'
kubectl -n fd-prod rollout restart deploy/platform
```
疗后实证：`echo hello-healed` 真回合返回输出（exit 0）。

### 续修：链接源必须是运行时树（a1bc685）

上面那条修完，prod 仍有一枚**老 cell**（`2b043ce050ca134c`，profile 模块目录是真
目录而非符号链）起不来：它的 `linkProfilePinnedModules` 走真实目录分支，从
**应用树**取源，于是同样双实例。修法：新增 `RUNTIME_NODE_MODULES`——从
`DSH_BIN` 解析其 node_modules（镜像= `/opt/dsh/node_modules`；桌面无 DSH_BIN
时回退应用树，语义不变），真实目录分支一律从运行时树取源；毒链清理只在
appRoot≠runtimeRoot 时执行。`sha-744285e` 上线后老 cell 自动治愈（日志
`linked … into the profile node_modules`，链接指向 `/opt/dsh`），**两个 cell
的 dsh 全部 ready，doc-studio 真回合出稿**（见下）。

## 事故全程的最终状态（2026-10-09）

- prod 镜像：`ccr.ccs.tencentyun.com/yizuo/platform:sha-744285e`（GitOps 6910db6）
- 镜像 CI 三门全绿：`/api/ready {"ready":true}` + dsh-contracts 6/6 + module identity ok
- 两个 cell 的 dsh 子进程 ready；`echo` 工具回合 exit 0
- **doc-studio 真回合实证**：标准模式生成《2026年第三季度华东区销售复盘》docx
  （43KB / 52 段 / 6 表 / R1 封面 / TOC 域 / 三章 / 数据表），技能自带 postcheck
  PASS，回合末自报路径与交付清单
- 残留（桌面线，未修）：根树 `dsh-credentials` 缺口（见下）；`package.json`
  建议把 `cordis-plugin-loader` 也声明为根依赖（第三缺陷一行的正解）

## 根树缺口（未修，桌面线相关）

根树（`/app/node_modules`）的 flag 必须保留，但它漏装 rc.5 侧 peer：`@deepseek-ai/dsh-llm-deepseek@0.0.1-rc.5` 的 `lib/index.js` 第 3 行 `import { credentialRef } from "@deepseek-ai/dsh-credentials"` 在根树解析不到（该包只存在于 dsh 嵌套树 `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`）。本地不炸是因为 `scripts/test-agent-notify-bridge.mjs` 的 anchor 探测先命中 homebrew 全局 dsh；快照 CI（干净机器）命中根树 → 单测 `bridge: subclasses the preset bridge…` 红。

影响面：只在这个「根树被当作 dsh 安装根」的路径（快照 CI 的单测 + 潜在根树直用）；prod 镜像的 boot 走 `/opt/dsh` 矩阵树，不受影响。修法选项：①把 `dsh-credentials`/`dsh-credentials-local` 显式加进根 `dependencies`（与 4e348c3「运行时 peer 进 dependencies」同款）；②测试 anchor 加根树回退；③根树不再当 dsh 锚。归属：桌面/dsh-matrix 车道。
