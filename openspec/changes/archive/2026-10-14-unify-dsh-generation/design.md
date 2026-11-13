# unify-dsh-generation — Design

## 背景与实证（2026-10-14 explore + grill 定案）

上游 `0.2.0-rc.2`（dist-tag latest/next 双标记）关键事实，全部已在本机验证：

- **家族统一**：dsh / dsh-base / sdk-client / sdk-protocol / sdk-jsonrpc-server / agent / llm / scope / session 等全家族同版本号发布。现行 rc.2/rc.5/rc.1 三代分裂不存在。
- **零 peerDependencies**：dsh@0.2.0 把全家族以**精确钉版硬依赖**发布（dsh-base 93 行 deps）。历史"18 行仅 peer 可达插件"问题类别消灭；矩阵 overrides 的存在理由（抹平双代）消失。
- **干净解析**：8 个平台真实 import 包 + 单版本号的根式 manifest 在 /tmp 无 `--legacy-peer-deps` 解析成功（exit 0）。
- **符号面兼容**：dsh-sdk-client 0.0.1-rc.1 → 0.2.0-rc.2 的 `lib/index.js` 导出集逐符号一致（`DeepSeekHarness, HarnessClient, HarnessSession, JsonRpcResponseError, RequestTimeoutError, SdkProtocolError, TransportClosedError`），仅新增 `createProcessDeepSeekHarness`/`createProcessHarnessClient` 两个工厂。平台 import 的 7 个符号（HarnessClient、TransportClosedError、createScope、scopeOf、defineTool、SystemPrompt、SessionId、HarnessSdkJsonRpcServer）全部存活。
- **hmr 家族化**：`@deepseek-ai/dsh-hmr@0.2.0-rc.2`（依赖 chokidar/picomatch/babel code-frame，无 registerConfig 面）；dsh-app-boot@0.2.0-rc.2 依赖表中无 cordis-plugin-hmr。1.0.16 钉版退役。
- **上游最新陷阱仍在**：dsh-base/sdk-protocol 的 latest dist-tag 停在首版（ADR-0007 备忘）——"跳最新"永远操作化为显式读版本清单取 lockstep rc，不用 dist-tag。

## D1 — 版本政策：一次跳 0.2.0-rc.2，节奏不变

- 目标版本 `0.2.0-rc.2`（0.2.1-alpha.2 不进生产）。
- 跳后维持 ADR-0007 窗口：每 3-4 周跳当时最新绿 rc，中间版本跳过；跳版触点收敛为 dsh-matrix 意图条目一处 + lock 重生成 + 合同试跑 + 剪枝名单复核。
- **门 = 九合同 candidate 试跑全绿才合并**（`npm run dsh:contracts -- --tree <0.2.0 scratch> --bin <dsh>`）。重点面：⑥ platform-sdk-rpc（PermissionPresetService.set 唯一内部 API）、⑦ live model/set、⑧ session-cancel、⑨ multi-session-concurrency（后三条即昨日上产的 wire-dsh-live-runtime-control 的线协议安全网）。subagent 族（dsh-tool-subagent 等）列观察项不作验收门——多 agents 定义已定为平台级编排（roadmap 2026-10-14 节），dsh 内部 subagent 非承重面。
- ⑥ fail 归因流程沿用 README：internal-API 标签 ≠ 自动不能跟，评估方法表替代或锁旧等待。

## D2 — 剪枝机制：装后 prune + boot 门允许缺席名单

体积账（/tmp 实测）：0.2.0 朴素闭包 516MB（vs 现行 283MB，+233MB）。增量主成分与处置：

| 大件 | 体积 | 事实依据 | 处置 |
|---|---|---|---|
| `libreoffice-kit-*` 平台二进制 | ~159MB | dsh-base 0.2.0 的 95 行插件表零 office 行；壹座 office 走自有 python 层（requirements-office.txt） | **剪** |
| `dsh-web-app` + `client-ui-*` | ~33MB | 平台 profile 只装 dsh-base；web-app 只作 dsh CLI 依赖入场，壹座永不渲染 dsh 自带 UI | **剪** |
| pi-ai 链（pi-ai+openai+anthropic+google） | ~49MB | **承重**：dsh-profile.js:284 写 `llm-pi-ai` providers（volces 线 `api: "openai-completions"` 惰性引 openai SDK）；loader boot 期静态 import dsh-llm-pi-ai（dsh-base patch `llm-pi-ai` 行启用） | **留** |
| `@opentelemetry/*` | ~35MB | dsh-base patch `session-telemetry-otel` 行启用 | **留** |
| sharp/@img、node-pty | 27/26MB | attachment 处理、终端工具 | **留** |

剪后 ≈324MB。机制选择（否决项）：

- ~~lock 手术~~：README 明令 lock 是机器产物不手编；且 npm ci 会按 manifest 重装。
- ~~npm overrides 占位~~：overrides 换版本不删包，占位 stub 引入新 fragility。
- ~~`--omit=optional`~~：会连真需要的平台匹配二进制等 optional 一起杀。
- **选定**：镜像构建 `npm ci` 后按 `dsh-matrix/prune.json`（名单+理由）`rm -rf` 目标子树；`lib/dsh-matrix-verify.js` boot 门读同一名单，名单内缺席放行（日志标剪枝标记），名单外缺席照旧拒启。合同②对剪后树重跑（名单内条目豁免解析断言）。

镜像 dsh 载荷净变化 +41MB（324 vs 283；根树 -50MB 归后续 change）。**朴素跳版 +233MB 是本设计显式拒绝的路径**。

## D3 — 根 manifest：原位统一，行数收敛延后

- 根 `package.json` 41 行 dsh 行逐行 bump 到 0.2.0-rc.2；**行数不动**（41→8 收敛是桌面机械面，归 `single-source-desktop-runtime`——现在砍行会让桌面失去运行时来源）。
- bump 时逐行核对 0.2.0 是否仍发布同名包：已确认 `cordis-plugin-hmr` 消失（其职能由家族内 dsh-hmr 承接，该行删除）；其余行名若在上游被吸收/改名，以"平台真实 import 的 8 包 + dsh 本体"为底线核对处置，实现任务里逐行落账。
- 摘 `--legacy-peer-deps`：Dockerfile 两处安装、release/ci、Jenkinsfile。裸 `npm ci` 成功本身即回归探针（若再出 peer 冲突会当场爆）。
- e2e/harness：DSH_BIN rehearsal 重锚 ~/.dsh 的既有坑（memory 在册）纳入任务清单复核。

## D4 — 桌面临时膨胀的显式接受

根树 bump 后，桌面打包（electron-builder 打全量 node_modules）将携带 0.2.0 全家族闭包（~516MB）。本 change 接受该过渡成本，收敛路径已立项：`single-source-desktop-runtime`（predist 从矩阵装剪后闭包 ≈324MB）+ 远期首启下载 explore。理由：版本统一的战略收益（多 agents 前消灭代差）不因桌面包过渡膨胀而停摆；桌面分发非本 change 的验收面。

## D5 — 适配层 lint

- 名单文件入库（建议 `dsh-matrix/adapter-files.json` 或 scripts 内单文件，实现定）：现存集合 = dsh-bridge.js、dsh-profile-template/*.js 七桥、agent-runner/index.js、scripts/{dsh-contracts.mjs, test-*, probe-*}（探针与合同为开发工具面）。
- lint 实现：grep 级（`from "@deepseek-ai/` 与 `require("@deepseek-ai/` 的文件集合 vs 名单 diff），接进现有 CI lint job。不引入 AST 依赖。
- 名单变更与 dsh-matrix 变更同 PR 评审轨迹（spec 场景钉死）。

## D6 — 决策落盘

- 新 `docs/adr/0023-unified-generation-jump-and-prune-allowlist.md`：统一代跳跃 + 允许缺席剪枝政策 + ADR-0007 局部 superseded（hmr 钉版、overrides 抹平、18 行 peer 历史）。
- ADR-0007 头部注记指向 0023；跟随者策略主体（矩阵锁死、合同闸门、节奏、方法表冻结）不变。
- dsh-matrix/README.md 升级步骤节同步改写（去 hmr pin 语句、加剪枝名单复核步骤）。

## D7 — 0.2.0 适配切片（2026-10-14 合同门归因后扩入，用户已接受）

合同门首跑 6/9：⑧⑨①②③⑤ 过（活控制线协议完整存活）；④⑦⑥ 挂于两处上游重设计，均需平台适配层迁移（单向变化，任何 0.2.0+ 都要适应，等待不减工作量）：

**D7.1 settings → profile patch 行**（修④⑦）：0.2.0 的 dsh-settings 在 boot 时把 home 根 `settings.yaml` 一次性导入后改名 `.imported`；settings 常驻 **profile patch**（`profiles/<name>/cordis.patch.yml` 的行 config，经 ConfigEditor/Loader）。迁移：`writeLlmProfile` 的写入目标从 settings.yaml 改为 cordis.patch.yml 的 `{id: llm-pi-ai, config: {providers}}` 行（upsert 进 patch 数组，保留 scaffold 的 insert 行）；dsh-hmr 只 watch profile 自有 patch 文件（`profile.patchPath` + home 根 PROFILE_PATCH_FILENAME）——恰好覆盖，中会话热刷新由 watch→reconcile 承接。**credentials 零迁移**（`$DSH_HOME/.credentials.yaml` 文件契约 0.2.0 原样保留，dsh-credentials-local 头注实证）。

**D7.2 preset → 声明式行注册**（修⑥）：因果链——`resolveShippedPresetRoot()` 找 `<dsh>/config/agent-presets`（0.2.0 已删）→ roster 行引用的包 `@deepseek-ai/dsh-agent-presets` 不存在 → loader 静默跳行 → presets/list 空。0.2.0 模型：`dsh-agent-preset-registry` 提供 `agentPresets` 服务（config 仅 `{default, selectedDefault}`，**roots 概念删除**）；preset = `dsh-agent-preset` 声明行 `{id, name, description, order, plugins: [组合行]}` 自注册。迁移：`writePresetsPatch` 改写为「registry 行（default: standard）+ N 个声明式 preset 行（standard=0.1.1 shipped 组合的 16 行翻译，catalog/用户预设同形）+ platform-sdk-server 桥行（不变）」；`resolveShippedPresetRoot` 退役；catalog 预设从 `.agent-presets/<id>/agent.cordis.yml` 目录组合改为同 patch 行生成。**bridge 三 API 存活**（`ctx.get("agentPresets")` 服务名不变、`list()` 不变、`mount(ctx,id)` 不变）——platform-preset-bridge.js 预期零改动。

**D7.3 合同④⑦改写**：④ 热重载断言改「cordis.patch.yml 的 llm-pi-ai 行 config 变更 → 名册热刷新」（credentials 轮换半边不动）；⑦ 的模型声明写入同机制。

**验收**：九合同全绿（原 1.3 门收口）；standard 组合的 16 行包名已核全存在于 0.2.0（persona/agent-instructions/6 工具/skill×2/3×cordis:group/ask-user/todo/web）。

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| ⑥ 内部 API fail | 既有归因流程；锁旧 = manifest revert，无半态 |
| 跳版破坏昨日上产的 live-control | ⑧⑨合同即其验收面；fail 则不合并，等待或适配二选一有明确判据 |
| 剪错包（动态 import 晚期才炸） | 首刀两件均为"插件表零引用"实证；合同+boot 冒烟双门；prune.json 随版可 revert |
| 上游 rc 破损 | 合同试跑在 scratch 树先行，绿了才动生产 |
| 桌面临时膨胀 | D4 显式接受，收敛 change 已立项 |

回滚线：manifest+lock revert → 镜像重建 → GitOps 回滚（paas-release 标准流程）；单镜像三角色（cells/facet/runner）一次回滚全覆盖。
