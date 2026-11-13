# Design: dependency-security-round

## Context

- 仓库 7 份 lockfile（root / web / miniapp / app / dsh-matrix / facet/web / servers/fd-health-mcp），dependabot 按 manifest 分别计告警；GitHub 的 runtime/development 分类是 manifest 级（在 `dependencies` 树下即 runtime），**不代表打包产物真的包含它**——miniapp 的 swiper 就是典型（`@tarojs/components` 的依赖，但 weapp 目标把 `<Swiper>` 映射到原生组件，npm 包不进包）。
- 动作清单真相（`npm audit fix --dry-run`，root 235 项）：其中 ~200 项是 foreign-platform optional 二进制条目（sherpa-onnx / ripgrep / typescript / sharp / koffi / biome / libreoffice-kit / dsh-client-ui-* 系列）被重新物化到 lock——lock 体积噪声，对 `npm ci` 无行为影响；真正的版本动作约 60 项。
- 三个必须显式处置的「夹带」：`@hono/node-server 1.19→2.1.5`（MCP SDK 1.32.1 自带的配对）、`@noble/hashes 2.2.0→1.8.0`（两实例全在 electron-builder/app-builder-lib 构建链）、`remove tencentcloud-sdk-nodejs-{asr,tts,common}`（**extraneous**：不在 package.json 也不在 lock，10-18 语音实验残留；`grep -rn tencentcloud server/ scripts/ packages/ electron/ gateway/ services/ lib/` 为空）。
- 硬约束：dsh 家族精确钉 `0.2.0-rc.2`（2026-10-19 否决 0.2.1 final：合同 ④ 凭据热重载真回归），dsh-matrix 是冻结闭包（README：never hand-edit the lock）；`@deepseek-ai/dsh-mcp-client` 对 `@modelcontextprotocol/client` 精确钉 `2.0.0`，libreoffice-kit 对 fflate 精确钉 `0.8.2`。
- Taro：`@tarojs/components@4.2.1` 与最新 `4.3.0` 对 swiper **都精确钉 `11.1.15`**。
- canvas：是 unpdf 的 **optionalDependency**（`^2.11.2`），本机 `node_modules/canvas/build/Release/canvas.node` 不存在（Node 25 无预编译 + 无 cairo → optional 安装静默失败）；它的 `@mapbox/node-pre-gyp@1.0.11` 只调 `tar.create` ×1 / `tar.extract` ×2，而 node-pre-gyp 2.x 用同样两个调用跑在 `tar ^7.4.0` 上。
- CI：FDT 私有额度 2011/2000 已尽，本 commit 推上去不会有 GHA 跑——所有门本地过；修复随下一班列车（服务端镜像 `fd-build-snapshot` / 桌面 tag）才真正到达用户。

## Goals / Non-Goals

**Goals:**
- 5 份本轮持有的 manifest 上 critical 归零（dependabot 视角），范围内可修的 high 全部拿下。
- 每条未修告警都有归属（豁免 / 推迟 / 他人持有）且写进轮次记录，复查条件明确。
- 升级后全部本地测试门绿；夹带的 nested major 有对应测试门覆盖证据。

**Non-Goals:**
- `app/package-lock.json`（add-mobile-app 在途 change 持有，4 条告警原样列出移交）。
- 任何带 API 面的大版本（officeparser 8、pdfjs-dist 8、Taro 4.3、mammoth 降级建议）。
- dsh 任何版本移动；dsh-matrix lock 任何字节。
- 本轮出片 / 滚产；`.github/dependabot.yml` 分组配置。
- `@llamaindex/readers`（上游无修）与 canvas 替换（它是 readers→unpdf 的 optional，不是本仓直接依赖）。

## Decisions

**D1 — 每份 manifest 跑 `npm audit fix`（非 force），而不是手挑五个包做 overrides。**
npm 只在各父包声明范围内重解析，等价于「上游已经测过的配对」；手挑会把 20+ 条范围内可修的 high 留在桌上，且 overrides 是给「范围容不下」的场景用的工具，用在范围内修复上是误用。爆炸半径用 dry-run 动作清单 + 修后 `npm ls` 点名核对（tar / proxy-addr / @hono/node-server / @noble/hashes / extraneous）控住。
*备选*：`npm audit fix --force`——会把 dsh 推离 rc.2、officeparser/pdfjs 跳大版本，否决。

**D2 — tar@6.2.1 用 scoped override `"@mapbox/node-pre-gyp": { "tar": "^7.5.22" }`，不用全局 override，也不豁免。**
兼容性证据：node-pre-gyp 2.x 已在 tar ^7.4 上跑同样的 `create`/`extract` 两个调用；且 canvas 在本树是未安装成功的 optional，override 最坏情形=optional 安装以今天同样的方式失败。
*备选 A*：全局 `"tar": "^7.5.22"`——会静默压掉未来任何 ^6 消费者、掩盖真实不兼容，否决。*备选 B*：豁免——明明有干净修法却留一条 runtime manifest 上的 critical 常开，否决。
*解除条件*：unpdf 换到 `@napi-rs/canvas`（无 node-pre-gyp）或 readers 升级后 canvas 链消失 → 删 override。

**D3 — swiper 用 `miniapp/package.json` overrides `"swiper": "12.1.2"`，并用 weapp 产物字节级比对证明零影响。**
build:weapp 是唯一构建目标；Taro 在 weapp 平台把 `<Swiper>` 映射到原生 `<swiper>`，npm swiper 不进 bundle。override 前后各 build 一次，`dist/` 全文件 sha256 清单一致即证明。
*备选*：bump Taro 到 4.3.0——它仍钉 11.1.15，零收益还给 MP 提审前夕引入框架变更，否决。
*解除条件*：Taro 发布钉 swiper ≥12.1.2 的版本。
*已知局限*：若未来加 H5 目标，Taro H5 的 Swiper 实现基于 swiper 11 API，需重新评估。

**D4 — decompress 豁免。** dev-only，仅 `@tarojs/cli → download-git-repo → download → decompress` 这条 `taro init` 模板下载路径可达，`build:weapp` 不走；上游已停更无补丁。复查条件：`@tarojs/cli` 弃用 download-git-repo。

**D5 — 夹带的 nested major 接受并用测试门兜：** `@hono/node-server` 2.x（MCP SDK 1.32.1 自身配对；门 = `test:unit` 内 MCP/harness 相关 + e2e fast）；`@noble/hashes` 降级（仅 electron-builder 签名/asn1 链，构建期；门 = 下一班 tag 的 release 矩阵，本地 `predist` 不触及）。任一门红 → override 钉回并记为推迟。

**D6 — dsh-matrix 零改动，三条告警全豁免。** mcp client 2.0.0 与 fflate 0.8.2 都是 dsh 闭包内的精确钉；用 override 改它们等于改 dsh 自己的配对，与 rc.2 锁定决策冲突。复查条件：dsh 换版。

**D7 — electron 43.1.1→43.8.3、electron-builder 族 26.15.3→26.18.0 随 audit fix 一起走（范围内）。** 桌面专属门（release 矩阵 / win-install-smoke / GUI 自检）天然在下一班 tag 上跑；本轮本地门 = `test:unit` + web 构建；`package.json` 变更会改 resources 缓存 key，下一班重建 bundled Node 一次。

**D8 — 本轮不出片。** 修复在构建前是惰性的；为一个用户不可见的变更单独烧备用池分钟不值；任何下一班功能列车自然携带。台账记一笔「待列车」。

## Risks / Trade-offs

- [express 中间件族（qs 6.16 / body-parser 1.20.8 / multer 2.4 / compression 1.8.2）小版本行为漂移] → e2e fast + `test:unit`（file-serving / resources-api / skill-package-upload 等覆盖 multer 与 body 解析）；红则 override 钉回。
- [MCP SDK 1.32.1 + hono 2 改变 streamable-HTTP 行为] → `test-mcp-preflight` / `test-harness-adapter` / `test-tool-discovery`；prod MCP 服务器是独立进程，cell 侧客户端路径由此覆盖。
- [electron 43.8.3 桌面行为变化] → 只在下一班 tag 的矩阵/冒烟暴露；patch 线风险可接受。
- [lock 新增 ~200 条 foreign-platform optional 条目] → 纯体积噪声；`npm ci` 行为不变。
- [swiper override 对未来 H5 目标的隐患] → 记录在轮次记录与 override 解除条件。
- [本地 e2e fast 跑完整耗时] → 可接受；若超时则跑路由/上传/MCP 相关 spec 子集并如实记录。

## Migration Plan

无部署步骤。回滚 = revert 本 commit（5 份 lockfile + 2 份 package.json overrides + change 文档）。到达用户的验证在下一班列车：镜像 digest↔pod imageID 比对后，进容器 `npm ls proxy-addr tar` 看 2.0.8 / ≥7.5.22。

## Open Questions

无——所有会影响规格、方案或任务拆分的问题已在本轮地面真相里落定。
