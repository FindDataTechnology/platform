# 轮次记录：dependency-security-round（2026-10-21）

数据源：`gh api repos/FindDataTechnology/fd-craw-private/dependabot/alerts?state=open`（推送前快照 151 条）+ 各 manifest 本地 `npm audit`。推送后的 dependabot 复核见文末。

## 1. 前后计数

| manifest | dependabot 前 | 本地 npm audit 前 → 后 | 手段 |
|---|---|---|---|
| root `package-lock.json` | 93（2c/49h/37m/5l） | 47（2c/22h/23m）→ **27（0c/8h/19m）** | `npm audit fix` + overrides(`@mapbox/node-pre-gyp.tar ^7.5.22`) + `npm update brace-expansion glob 前者` |
| web `web/package-lock.json` | 9（0c/5h/4m） | 11（0c/6h/5m）→ **3（0c/0h/3m）** | `npm audit fix` |
| miniapp `miniapp/package-lock.json` | 40（3c/17h/18m/2l） | 59（1c/29h/29m，npm DB 更严）→ critical 仅剩 decompress | `npm audit fix` + overrides(`swiper 12.1.2`) + `npm update glob` |
| facet `facet/web/package-lock.json` | 2（0c/1h/1m） | → **0** | `npm audit fix`（vite 6.4.4） |
| dsh-matrix | 3（0c/1h/2m） | 零改动（豁免 ×3） | 不动冻结闭包 |
| app（add-mobile-app 在途） | 4（0c/2h/2m） | 不适用 | 移交归属 change |

root lock 条目 1178 → 1160（extraneous 清除 + 去重净减；dry-run 预告的 ~200 条 foreign-platform optional 物化未发生膨胀）。

## 2. 两条 critical 的清法（root）

- **proxy-addr 2.0.7 → 2.0.8**：express 4.22.2→4.22.3 顺带，`npm ls proxy-addr` 单一 2.0.8。
- **tar@6.2.1（canvas→@mapbox/node-pre-gyp@1.0.11 链）→ 7.5.22**：`npm audit fix` 不动它（npm 只修 builder 链上两个 7.5.20 实例）；scoped override 清掉。兼容性证据：node-pre-gyp 2.x 用同样的 `tar.create`/`tar.extract` 调用跑在 `tar ^7.4.0`；canvas 是 unpdf 的 optional（`^2.11.2`）且本机从未装成（无预编译/无 cairo），override 最坏情形 = optional 以今天同样的方式静默失败。解除条件：unpdf 换 @napi-rs/canvas 或 readers 升级使 canvas 链消失。

## 3. miniapp 三条 critical

- **swiper 11.1.15 → 12.1.2（override）**：`@tarojs/components@4.2.1` 与最新 `4.3.0` 都**精确钉 11.1.15**，上游无修，普通升级永远不可达。weapp 唯一构建目标把 `<Swiper>` 映射原生组件——**override + audit fix + glob update 后重建，dist 36/36 文件 sha256 与基线字节级一致**（/tmp/weapp-before.sha 比对）。局限：未来若加 H5 目标需重评（Taro H5 的 Swiper 基于 swiper 11 API）。解除条件：Taro 发布钉 swiper ≥12.1.2 的版本。
- **shell-quote 1.10.0 → 1.12.0**（launch-editor `^1.8.4` 范围内，随 audit fix）。
- **decompress 4.2.1 豁免**：仅 `@tarojs/cli → download-git-repo → download → decompress` 这条 `taro init` 模板下载路径可达，`build:weapp` 不走；上游停更无补丁（npm 标 fixable 系其「修复」=降级 @tarojs/cli，不可取）。复查条件：@tarojs/cli 弃用 download-git-repo。

## 4. 夹带的传递大版本（nested major，显式审查项）

| 跳变 | 路径 | 判定与门 |
|---|---|---|
| `@hono/node-server` 1.19.14 → **2.1.5** | `@modelcontextprotocol/sdk` 1.29.0→1.32.1（范围内）自带配对 | 接受；门 = test:unit 全量（MCP/harness/preflight 系列）+ e2e fast |
| `@noble/hashes` 2.2.0 → **1.8.0**（降） | electron-builder/app-builder-lib 26.15.3→26.18.0 构建链 | 接受；纯构建期（签名/asn1），门 = 下一班 tag 的 release 矩阵 |
| `electron` 43.1.1 → **43.8.3**、electron-builder 族 → 26.18.0 | 直接 devDep 范围内 | 接受；桌面专属门（矩阵/win-smoke/GUI 自检）在下一班 tag 天然执行 |

extraneous 清扫：`tencentcloud-sdk-nodejs-{asr,tts,common}`（10-18 语音实验残留，`grep -rn tencentcloud server/ scripts/ packages/ electron/ gateway/ services/ lib/` 零引用）随重装消失；`@img/sharp-wasm32`/`@emnapi/runtime` 两个 optional 磁盘残留不进 lock，`npm ci` 不会装。

## 5. 豁免 / 推迟清单（全部复查条件）

- `@deepseek-ai/dsh*` ×5 high + `@modelcontextprotocol/client` 2.0.0（root + dsh-matrix）：rc.2 锁定决策（2026-10-19 否决 0.2.1 final：合同 ④ 凭据热重载真回归）；dsh-matrix 内两者均为精确钉。复查 = dsh 换版。
- dsh-matrix `fflate` 0.8.2（libreoffice-kit 精确钉）。复查 = dsh 换版。
- `officeparser` 7.8.0（仍在 6.1.0-7.8.0 伤域，修复 = 8.2.0 major，API 面）、`pdfjs-dist`（修复 = 8.2.0 major，经 unpdf）。复查 = 下游大版本升级轮。
- `@llamaindex/readers`（上游无修）及其 optional canvas 链。
- electron-builder 26.18.0 族 moderate（roarr/global-agent/sprintf-js 链；npm 建议降 26.5.0，否决）。
- miniapp dev 链钉死项：adm-zip 0.5.18（→0.6.1）、serialize-javascript 6.0.2（→7.0.3）、webpack-dev-middleware 5.3.4（→7.4.6）、webpack-dev-server 4.15.2、got 8/9、uuid 8.3.2、esbuild 0.21.5、decode-uri-component 0.2.2、glob 10.2.6（plugin-doctor 钉）、postcss 7.0.39 实例。复查 = Taro 升级轮。
- miniapp `webpack` 5.91.0 → 5.104.1（**范围内可升但推迟**：会改 weapp 包字节，与提审窗前的眼验版本漂移；随下个 MP 构建周期 + devtools 眼验一起做）。
- 无补丁项：braces ≤3.0.3、node-forge ≤1.4.0、html-minifier、git-clone、csv-parse（root moderate）、sprintf-js/argparse/mammoth（web，npm「修复」=降级否决）。
- **app/ 4 条**（braces/node-forge high + decode-uri-component/uuid medium）→ 归属 **add-mobile-app**（在途 change，本轮不动其任何文件）。

## 6. 既有基线红（与本轮无关，证据链）

| 项 | 状态 | 归属 |
|---|---|---|
| biome lint ×7（cell-memory.js、lib/publish-tool-gate.js、scripts/preflight-pack-tool-gate.mjs、scripts/lib/runtime-dirs.mjs、ClusterComposerModal.tsx ×3、两个 test 的 unused 参数） | 基线红；biome 2.5.11 未被本轮改动 | 各原作者会话 |
| web typecheck：PackDetailDialog.tsx `manifest.cluster` TS2339/TS7006 | bf3f5916（10-20 集群代码被 add -A 卷入）起红 | agent-cluster-platform（在途） |
| test-official-packs-lint：tool_risk 宇宙 12≠14 | 7c6bc0b9 加两条闸动作未同步测试 | add-pack-subscribe-actions（在途） |
| miniapp typecheck：TS2550 replaceAll（2a747fc8，10-15 引入；tsconfig 停 ES2020） | **本轮以独立 commit 修**（target ES2021，web 已 ES2022） | 已核销 |
| test-external-source-endpoints 写路径断言漏 update POST | **本轮以独立 commit 修**（chat-interaction-round2 当日欠账） | 已核销 |

## 7. 测试门记录

- `test:unit`（root，~200 文件）：首轮 2 红，均为上表基线项（write-boundary 已修；official-packs-lint 留归姊妹 change）；修复后定向 6/6 绿；终末全量复跑结果见 tasks 5.x 勾注。
- `web:build:e2e` ✓（4.93s）。
- **e2e fast 全量：486 过 / 15 红 / 5 跳（25.2m）→ 复跑（`--last-failed` 空载）13 过 / 2 红**：13 个首轮红系负载噪声 + 树上姊妹会话在途 WIP（`dsh-profile.js` 当时确有 `writeUserQuestionsPatch` 重复声明 SyntaxError、`server/routes/clusters.js` 在改——复跑即绿佐证非本轮所致）。确定性 2 红以 **HEAD 干净 worktree 二分**定归属：
  - `full-mode-tool-scope.spec.js:138`（并集物化 `[]`）：干净 HEAD + 改前 lock **同样红** → **main 既有红**，归 mcp-tool-scope 后续线（warn 观察窗/turn-trace 未做），非本轮。
  - `resources-binding.spec.js:265`（binding-bar 不可见）：基线两轮绿；**干净 HEAD 源码 + 本轮 lock 全新 `npm ci` 后 7/7 绿** → 失败仅在主工作树（姊妹 WIP / 原位 audit fix 的 node_modules 残态）复现，**与本轮 lockfile 无关**。
- miniapp：typecheck ✓（ES2021 后）、`build:weapp` ✓ ×2、`test:markdown` 10/10 ✓、dist 字节一致 ✓。
- facet/web build ✓（2.04s）。`lint`：基线红 ×7（见上表），本轮触碰文件零新增。
- dsh-matrix：`git diff --stat dsh-matrix/` = 0。

## 8. 推送后 dependabot 终计（f744f7f6 上 origin 后 ~90s）

open **151 → 55**。按 manifest：miniapp 41（critical 仅 decompress ×2=豁免在案；余为 dev 链钉死项/无补丁项）、root 6（mcp/client high+medium、fflate medium=dsh rc.2 闭包；pdfjs-dist high=大版本推迟；csv-parse、sprintf-js medium=无补丁）、web 1（sprintf-js 链）、dsh-matrix 3（豁免 ×3）、app 4（移交 add-mobile-app）。**5 份持有 manifest 的 critical 全清（decompress 豁免除外）**——目标达成。


