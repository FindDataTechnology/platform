# dsh-contracts Specification

## Purpose

把平台对 dsh 上游的行为依赖编码为可断言的合同套件：对任意候选 dsh 安装试跑（候选模式），报告每条合同 pass/fail，作为版本跟随（ADR-0007 每 3-4 周跳最新绿 rc）的升级闸门与镜像/PR 的验证面。

## Requirements

### Requirement: 候选模式 runner 接受任意 dsh 安装并输出逐条合同报告
系统 SHALL 提供一个独立 runner（npm 脚本），其目标 dsh 安装由参数指定（候选模式：scratch npm ci 树、镜像内 /opt/dsh、或任意手工安装路径），在该安装上物化隔离的临时 profile home、spawn dsh 子进程并驱动 initialize 握手，随后逐条执行合同断言，输出逐条 pass/fail 与失败原因的报告；任一合同失败 SHALL 使退出码非零，全部通过为零。runner SHALL NOT 读写部署的真实 DSH_HOME，也 SHALL NOT 依赖任何平台运行中的服务。对剪枝后的候选树（存在允许缺席名单内缺席），合同② SHALL 跳过名单内条目的解析断言。

#### Scenario: 对矩阵 scratch 树全绿
- **WHEN** 对从 dsh-matrix lock `npm ci` 出的 scratch 树运行 runner
- **THEN** 六条 v1 合同逐条报告 pass，退出码 0

#### Scenario: 候选版本破坏合同时逐条指认
- **WHEN** 对一个破坏任一合同的候选安装运行 runner
- **THEN** 被破坏合同报告 fail 并携带失败现场（子进程崩溃输出或握手失败），其余合同照常执行并各自报告，退出码非零

#### Scenario: 不触碰真实部署状态
- **WHEN** runner 在开发机上运行而机器存在 ~/.dsh
- **THEN** 全部物化发生在临时目录（用后清理），~/.dsh 内容不变

### Requirement: 六条 v1 合同钉住平台依赖的上游行为
套件 v1 SHALL 断言以下六条合同，每条独立执行、独立报告：
1. **boot/握手/名册**：子进程以 `--profile platform` + patch 列表启动，initialize 握手完成，模型名册与 preset 名册可投影；
2. **闭包可解析**：安装树内全部包顶层入口可被 Node 解析（针对 lock 声明集），peer 缺口以解析失败显形；允许缺席名单内条目豁免；
3. **hmr 家族合同**：`@deepseek-ai/dsh-hmr` 解析为意图条目钉住的代，且子进程不在 boot 期因 hmr/watchUserPatches 崩溃（统一代后 hmr 为家族内包，cordis-plugin-hmr 版本界断言退役）；
4. **settings/credentials 热重载**：settings.yaml 出现 `llm-pi-ai:` 段后模型目录热刷新（无需重启子进程）；.credentials.yaml 轮换后新凭证对下一次请求可见；
5. **patch 语义与 scaffold**：cordis patch 的 disable+insert 生效（stock sdk-jsonrpc-server 行被禁用、platform-sdk-server 行生效），profile scaffold 四文件（package.json / pnpm-workspace.yaml / cordis.yml / cordis.patch.yml）被装载；
6. **platform SDK RPC 面**：`presets/list`、`permissions/list`、`permissions/set` 可调用且返回结构符合平台预期，其中 `permissions/set` 在不重启子进程的前提下改变活动会话的权限预设（PermissionPresetService.set 内部 API 合同）。

#### Scenario: 合同⑥捕获内部 API 破坏
- **WHEN** 候选版本重命名或移除 PermissionPresetService.set 依赖的内部接口
- **THEN** 合同⑥的 permissions/set 断言 fail 并指名该 RPC，报告明确归类为内部 API 合同破坏

#### Scenario: 合同②捕获 peer 缺口
- **WHEN** 候选安装缺失一个插件包且不在允许缺席名单内
- **THEN** 合同②以 ERR_MODULE_NOT_FOUND 指名缺失包，而非等子进程在会话中晚期死亡

#### Scenario: 合同③家族化断言
- **WHEN** 候选安装的 `@deepseek-ai/dsh-hmr` 缺失或与意图条目钉住的代不一致
- **THEN** 合同③报告 fail 并指名该包，boot 期崩溃现场随报告携带

### Requirement: 套件接入镜像冒烟与矩阵变更 PR
镜像管线的冒烟阶段 SHALL 在容器内对 /opt/dsh 运行该套件（冒烟通过 = boot 探活 + 六合同双门）；PR CI SHALL 在 dsh-matrix 清单或 lock 变更时对该变更的 scratch 树运行套件，失败阻断合并。合同清单的新增 SHALL NOT 要求修改接线方（runner 单一入口、聚合退出码）。

#### Scenario: 镜像冒烟携带合同门
- **WHEN** 镜像管线执行冒烟步骤
- **THEN** 除 /api/config 探活外，六合同在容器内对 /opt/dsh 执行并通过，否则冒烟失败不推送

#### Scenario: 矩阵 PR 被合同门守卫
- **WHEN** PR 修改 dsh-matrix/package.json 或 package-lock.json
- **THEN** CI 对该 PR 的 scratch npm ci 树运行套件，任一合同 fail 则检查结论为失败

### Requirement: 活控制合同钉住 model/set、session/cancel 与多会话并发

套件 SHALL 新增活控制合同（在既有六条之外独立执行、独立报告）：

7. **模型活切**：`model/set` 在空闲与流中均可调用；切换后该会话的下一个模型请求按新 provider/model 路由（agent/request 瀑布请求粒度生效），子进程不重启；未知 provider 拒绝；
8. **真取消**：`session/cancel` 中断活跃回合并收敛 idle（agent.cancel + whenIdle），取消后的会话可立即接受新 prompt；
9. **多会话派发并发**：一会话回合在途时，另一会话的 prompt 不被拒绝、其请求正常派发并驱动自身回合（各自独立的 session.status 流）。（rc.2 已知限制：**并发打开的回合其收尾不保证收敛**——即使挂起请求解除，仍可能非确定地卡在 running；取消（⑧）是可靠的解卡手段。平台宿主的切换/停止路径均走取消，不消费自然收尾交错；如实记录，待上游演进后升格合同。）

三条均基于 dsh-agent 公开导出面（非 internal-API 标签），但 SHALL 与六合同同流程：候选 rc 任一条 fail 即按 ADR-0007 不跟版或归因决策。

#### Scenario: 合同⑦捕获快照语义破坏

- **WHEN** 候选版本使流中 model/set 撕裂当前请求（当前请求被中途换模型或报错）
- **THEN** 合同⑦ fail 并指名 model/set

#### Scenario: 合同⑧捕获取消不收敛

- **WHEN** 候选版本使 session/cancel 后会话不回 idle 或后续 prompt 被挂起
- **THEN** 合同⑧ fail 并指名 session/cancel

#### Scenario: 合同⑨捕获会话串扰

- **WHEN** 候选版本使 A 会话在途时 B 会话的 prompt 被拒绝或不派发
- **THEN** 合同⑨ fail 并指名多会话派发并发

### Requirement: 0.2.0 多 agent 能力面合同族（⑩-⑭）

套件 SHALL 新增五条合同（⑩-⑭），钉住平台在 dsh 0.2.0 多 agent 能力面上的行为依赖（萬星多 harness 运行层的地基，见 docs/wanxing-multi-harness-runtime-explore.md），与既有合同同流程：候选模式、独立执行、独立报告、任一 fail 退出码非零。⑩⑪⑫经**进程内探针插件**断言（test-only patch 行注入候选安装的临时 profile，装载机制与 platform-sdk-server 同型——合同⑤已钉住的 disable+insert 语义；探针的 `@deepseek-ai/*` 直引仅限适配层名单内文件）。五条合同：

10. **preset 会话级选择与组合隔离**：profile 声明 ≥2 个 preset 时，两个会话可各选不同 preset 且各自组合生效（系统提示词/工具面按所选 preset 分层，互不渗透）；选择未知 preset 的会话创建在发布前失败并回滚（不留半组合 agent）；
11. **per-agent 工具裁剪作用域**：对某 agent 施加工具裁剪（restrict deny 名单）后，该 agent 的工具面收窄而同进程其他 agent 不受影响；裁剪可重复施加直到钉住（时序容忍）；
12. **subagent one-shot 派发与槽位准入**：one-shot 子代理经委派跑完即收（结果+停止原因+可选结构化输出）；per-child agentOptions 覆写（provider/model）生效；continuable 槽位池超限时新派发以 `ACTIVATION_LIMIT_REACHED` 拒绝（不排队、不静默）；
13. **ACP 会话面**：候选安装以 ACP profile 服务时，会话 create/resume/list/close、模型与 reasoning effort 选择、submit/cancel 可用且跨进程重启后 list/resume 持久化成立；计量面形状（usage/token 事件在 ACP 面的可得性）SHALL 如实记录于合同报告附录——可得性与否均为有效结论，不因缺失而 fail（本条合同只 fail 于会话面行为破坏）；
14. **MCP sidecar 进程级共享**：同一进程内 N（≥2）个 agent 消费同名 MCP server 时，该 server 的 sidecar 子进程数恒为 1（不随 agent 数增长）；sidecar 生命周期随进程（进程退出无孤儿）。

#### Scenario: 合同⑩捕获 preset 组合串扰

- **WHEN** 候选版本使两会话的 preset 组合互相渗透（如 B 会话可见 A 会话所选 preset 的系统提示词段落或工具）
- **THEN** 合同⑩ fail 并指名渗透方向，报告携带两会话的组合事实

#### Scenario: 合同⑩捕获未知 preset 晚失败

- **WHEN** 候选版本使未知 preset 的会话创建在首回合或首落盘才失败（而非发布前回滚）
- **THEN** 合同⑩ fail 并携带晚期失败现场

#### Scenario: 合同⑪捕获裁剪越界

- **WHEN** 候选版本使对 agent A 的工具裁剪作用于同进程的 agent B
- **THEN** 合同⑪ fail 并指名越界方向

#### Scenario: 合同⑫捕获槽位池静默失效

- **WHEN** 候选版本使超限派发排队等待或静默丢弃而非 `ACTIVATION_LIMIT_REACHED` 拒绝
- **THEN** 合同⑫ fail 并指名槽位准入语义

#### Scenario: 合同⑬捕获取消不收敛（ACP 面）

- **WHEN** 候选版本使 ACP 的 cancel 提交后会话不回到可接受新 submit 的状态
- **THEN** 合同⑬ fail 并指名 ACP cancel

#### Scenario: 合同⑬的计量面记录

- **WHEN** 合同⑬执行完毕
- **THEN** 报告附录记录 ACP 面上 usage/token 信息的可得形状（可得/不可得+字段形状），无论哪种都构成合同的通过态输出

#### Scenario: 合同⑭捕获 sidecar 复制

- **WHEN** 候选版本使每个 agent 为同名 MCP server 各起一个 sidecar
- **THEN** 合同⑭ fail 并携带 sidecar 进程清单

#### Scenario: 探针插件不进生产组合

- **WHEN** 检视生产 profile 的物化路径
- **THEN** 探针插件仅存在于合同 runner 物化的临时 profile（用后清理），生产镜像与部署 profile 不含探针行

### Requirement: 流通道合同钉住桥转发的 assistant-stream 帧
dsh-contracts 套件 SHALL 包含一条流通道合同：以慢速流式 dummy LLM 驱动一轮真实回合，断言桥的流转发通知（0.2.0 起 session 格式不再于 session.event 中携带 chunk 事件，活流唯经 `agent/assistant-stream` 通道）逐帧到达宿主——帧词表（start / chunk / end）与 chunk 载荷家族（text-delta、reasoning-delta、usage、finish）形状被钉住；帧 SHALL 按产生它的会话归属路由（多会话并发时不得串扰）；`platform/capabilities` SHALL 播报流转发能力；整轮期间 session.event 通知 SHALL NOT 携带任何 chunk 型增量（防止宿主误把已死通道当活源）。合同失败即候选版本不可跟随。

#### Scenario: 合同捕获帧词表破坏
- **WHEN** 候选 dsh 版本改变 assistant-stream 的帧类型或 chunk 载荷家族（增删类型、字段改名）
- **THEN** 流通道合同 SHALL FAIL 并指认具体差异

#### Scenario: 合同捕获会话串扰
- **WHEN** 流通道合同在两个会话各自流式中核对帧的会话归属
- **THEN** 任何归属错配（A 会话帧标到 B）SHALL 使合同 FAIL

#### Scenario: 合同捕获能力播报缺失
- **WHEN** 桥模板未在 platform/capabilities 中播报流转发能力
- **THEN** 流通道合同 SHALL FAIL（宿主将错误进入降级路径）

#### Scenario: 合同钉住 session.event 无 chunk 的事实
- **WHEN** 候选版本重新在 session.event 中携带 chunk 型增量或恢复 assistant/chunk 事件名
- **THEN** 流通道合同 SHALL FAIL 并如实报告通道形状变化（宿主源绑定需要重新评估，而非静默双源）

### Requirement: pod 形状合同（⑯）

The contracts suite SHALL carry a sixteenth contract pinning the pod co-hosting shape against a real matrix tree: one dsh process hosting two member agents with distinct persona presets and distinct models. The contract SHALL assert, per member session: the session header names that member's preset (`preset/set` parked semantics — the parked selection, not the initialize-time default, composes the session); the member's model selection follows that member's `model/set` (parked or live) and never bleeds into the other member's requests; and each member's conversation history stays within its own session (no cross-member content). The contract SHALL also assert the refused shape: `preset/set` on a live session fails with an explicit error, and an unresolvable parked preset fails the session's creation before any agent publishes. The contract runs in the candidate-mode runner alongside ①-⑮ and reports per-contract pass/fail.

#### Scenario: 合同⑯捕获共宿 persona 串扰

- **WHEN** 候选 dsh 树上双成员共宿、各自 preset/set+model/set 后各跑一回合
- **THEN** 两回合的 system prompt 各含各自成员的 persona 标记、模型请求各走各自成员的模型；一旦 preset 泊靠或会话头记名被上游破坏，合同⑯红

#### Scenario: 合同⑯捕获活会话改 preset 的静默接受

- **WHEN** 对已创建的活会话调用 preset/set
- **THEN** 候选树须以显式错误拒绝；静默接受或静默忽略都判红

### Requirement: ACP adapter 映射面合同（⑰）

The contracts suite SHALL carry a seventeenth contract pinning the ACP adapter's method mapping against a local fake ACP agent process (no external credentials, no network): the adapter SHALL complete the initialize handshake, lazily create one session per context with an absolute cwd, run a prompt to the reported stop reason, surface the assistant text, parse `usage_update` notifications when the wire carries them, and cancel a parked turn through `session/cancel`. The contract SHALL also pin the failure families: a binary that cannot start fails the spawn with the cold-start error family; a turn that ends with no assistant text settles as the empty-turn error family (same codes the dsh path uses). The fake agent SHALL be a test-only script driven over stdio; the real second harness (claude-code-acp) is exercised by production validation, not by this contract.

#### Scenario: 合同⑰捕获映射破坏

- **WHEN** 候选 ACP adapter 改动方法映射（漏掉 session/new 的绝对 cwd、忽略 stopReason、丢失 usage_update）
- **THEN** 合同⑰ SHALL FAIL 并指认具体差异

#### Scenario: 合同⑰捕获错误族漂移

- **WHEN** adapter 把「空回合」或「起不来」的失败改成了与 dsh 路径不同的形状（或吞掉失败）
- **THEN** 合同⑰ SHALL FAIL——计费与计量语义跨 harness 必须同族
