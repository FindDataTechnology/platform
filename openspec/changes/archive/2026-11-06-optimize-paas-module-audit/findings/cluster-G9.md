# 簇 G9 体检报告 — dsh/调度（7 模块）

体检日 2026-11-06。仓 HEAD = ae04f0b9（2026-11-06 02:45）。部署面：`fd-infra-deploy/all-services/prod/platform.yaml:57` 镜像 `platform:sha-70a3620`（注记源 = paas dde77c3a，2026-11-06 00:29）；`git merge-base --is-ancestor dde77c3a HEAD` → 是（部署 ⊆ HEAD）。`facet.yaml:66` 同镜像。

---

## 1. cron-module — B

理由：spec 覆盖厚、测试最新鲜，但「停机不补跑」这条 Requirement 被代码反向实现（容忍窗 catch-up），spec 从未修订。

- ① 对齐：调度 API→`cron.js:417`(addJob)/`:575`(updateJob)/`:734,:751`(pause/resume)/`:782`(runJobNow)；时区→`cron.js:129`；原子持久化→`cron-store/jobs.json`+atomicWrite；熔断→`server/llm-lane.js:35-69`(laneKeyFor/streak)+`server/cron-runner.js:740-752`；逐回合全新对话→`server/cron-runner.js:169,:560`(disposeRoundChild)/`:912`；turnTimeoutMs→`server/cron-runner.js:104-121,:1283-1284`；驻留工具面→`dsh-profile.js:1181-1204`(byPreset)+`agent-runner/compose.js:589-604`。**分歧**：spec:51-57 "SHALL NOT catch up" vs `cron.js:186-231`(withinToleranceWindow/makeUpInterruptedBeat，catchUpPending 补跑标记，PLATFORM_CRON_CATCHUP 开关)；补跑源自 50ef027f(2026-10-26)，archive 各 change 的 specs/ 均未触 cron-module（grep 补跑=0 命中）→ spec 反向漂移，非 shadow。
- ② 测试：`scripts/test-cron-catchup.mjs`(11-06)、`test-cron-decisions.mjs`(11-06)、`test-cron-parity.mjs`(10-31)、`test-cron-round-rotation.mjs`(10-25)、`e2e/cron-binding.spec.js`(10-15)、`e2e/cron-tools.spec.js`/`cron-ui.spec.js`(10-11)。
- ③ 部署：platform.yaml:57 = dde77c3a ⊆ HEAD；**历史挂账核对：e339636e（cron 冷启动等待修复）`git merge-base --is-ancestor` 对 origin/main、dde77c3a、tag v0.1.0-skill-display 三者均为祖先 → 已出片，挂账销账**。
- ④ 痛感：`server/cron-runner.js` 39 commits/15 fix（09-05 以来，簇内最高）；`cron.js` 16/2；`server/llm-lane.js` 3/2（f665725f 滑窗→streak 重写）。
- ⑤ 陈旧度：spec 2026-11-04 vs cron.js 2026-11-01 → spec 更新，不 stale（但补跑分歧说明 11-04 修订仍未覆盖该点）。

## 2. dsh-adapter-boundary — A

理由：CI 硬门+名单即边界事实双检查齐备，机制按设计工作（漏登记被逮出即补录）。

- ① 对齐：`scripts/lint-dsh-adapter.mjs:25`(IMPORT_RE)/`:42-51`(名单外直引即败)/`:58-67`(陈旧名单检测)；名单=`scripts/dsh-adapter-files.json`(24 文件，含 dsh-bridge.js、11 个 profile-template 桥、agent-runner/index.js、合同/探针脚本)；CI 接线 `.github/workflows/ci.yml:44`。代码显著能力无 shadow：SKIP_DIRS(同文件:22)与名单 $comment 声明一致。
- ② 测试：lint 本身即检查（CI 门）；无独立单测——按 spec 设计如此（spec:9 只要求 CI lint）。
- ③ 部署：CI 侧门不进运行时；镜像构建不经此门（未证实镜像流水线单独复跑，仅核 CI yml）。
- ④ 痛感：09-05 以来 lint 文件 2 commits/1 fix；名单补录 5 次（5bf8fbf7/fd23700c/14d9da17/010f2c5d/6b9cda7b）——每次新桥漏登记被快照 CI 逮出，属摩擦而非缺陷。
- ⑤ 陈旧度：spec 2026-10-21 vs lint 2026-11-01 → 11 天，不 stale。

## 3. dsh-contracts — A

理由：spec 全部 18 条合同（①-⑱）在套件中逐条落地并注册，矩阵 PR 门接线在 CI。

- ① 对齐：runner=`scripts/dsh-contracts.mjs`(npm run dsh:contracts，package.json:22)；合同表注册 `scripts/lib/dsh-contracts/contracts.mjs:1630-1635`（⑭/⑮/⑯/⑰/⑱ 依次 :1630-1634）；⑮流通道 `contracts.mjs:1291-1338`；⑯pod 共宿 `:1341`；⑰ACP 映射 `:1646-1748`；⑱plugin-supply `:1516`；探针插件 `probe/contracts-agent-probe.mjs`(219 行)；CI 门 `.github/workflows/ci.yml:149-204`（dsh-matrix lock hash 触发）。spec:9b advisory 行为见 contracts.mjs（advisory 不计 exit code）——逐行核对未证实（未跑套件），注册与实现入口已实证。
- ② 测试：套件即测试；依赖侧 `fake-acp-agent.mjs`/`dummy-llm.mjs` 入库；mtime 2026-10-27。
- ③ 部署：镜像冒烟携带合同门（spec 要求）——本次仅核 CI 门，镜像内冒烟步骤未证实。
- ④ 痛感：17 commits/7 fix（09-05 以来），多为新合同扩族（⑩-⑱ 五族+流通道+pod）。
- ⑤ 陈旧度：spec 2026-10-20 vs contracts.mjs 2026-10-27 → 7 天，不 stale。

## 4. dsh-llm-providers — B

理由：四条 Requirement 实现入口齐全且语义到位，但 dsh-profile.js 是全簇痛感最高文件（2 个月 24 fix），而其测试最旧停在三周前。

- ① 对齐：凭据热重载存储→`dsh-profile.js:330`(ensureCredentialsStore)，0600+单行不变量 `:324-328,:416-419`(BLOCK_SCALAR_RE，2026-10-12 PAT 泄漏教训)；ciyuan 覆写→`:375-401`(cellOwnerEmail 有键覆写 LLM_API_KEY+CIYUAN_PROVIDER_IDS，无键回落 seed)；Volces 注册→`:60,:141-145,:183`；重试策略→`:197`(RETRY_POLICY+backoff 深拷贝)。代码显著能力无 spec 覆盖→shadow：BLOCK_SCALAR 单行不变量自愈重写(`:412-415`)属 credential-file-format spec 管辖（跨模块，非本 spec shadow）。
- ② 测试：`scripts/test-llm-providers.mjs`(10-11)、`test-llm-retry.mjs`(10-14)、`test-credential-file-format.mjs`(10-14)、`test/dsh-profile-memory.test.mjs`——最旧 10-11，落后最近代码(11-05) 3 周+。
- ③ 部署：随 platform 镜像 dde77c3a ⊆ HEAD。
- ④ 痛感：`dsh-profile.js` 67 commits/24 fix（09-05 以来，簇内最高，含 f62f2177 凭据交付控制器、e2875486 tool/result 双形状）。
- ⑤ 陈旧度：spec 2026-10-21 vs 代码 2026-11-05 → 15 天代码领先，<30 天，未 stale 但趋势向下。

## 5. dsh-plugin-supply — B

理由：功能面（roster/开关/持久化/apply 语义）实现完整，但宿主侧零单测——开关/隔离/失败可见三组 Scenario 只有候选模式合同⑱兜着。

- ① 对齐：桥=`dsh-profile-template/platform-plugin-supply-bridge.js:50`(platform-plugin-supply-server 行)/`:89-91`(bundles 投影)；宿主→`server/agent-session.js:1022`(getPluginBundles)/`:1039`(togglePluginBundle，HMR|restart-required|failed 三分支)；WS→`server/ws.js:872`(list_plugins)/`:886`(set_plugin_enabled)；白名单供给→`dsh-profile-template/package.json:6,:10-12`(bundles 列表)+`dsh-matrix/package.json:10`(supply-probe-bundle)。shadow 未发现：spec 六 Requirement 均有落点。
- ② 测试：**未证实存在宿主侧单测**——`grep togglePluginBundle|listPluginBundles scripts/test-*.mjs` 仅命中 contracts.mjs（合同⑱，候选模式）；scripts/ 下无 test-plugin-supply*。
- ③ 部署：随 platform 镜像；bundle 以矩阵 file: 依赖随镜像装（Dockerfile→dsh-matrix）。
- ④ 痛感：桥文件 09-05 后 0 次 fix（末次 2026-10-27 ad24a3f7 随族修剪）；所属 dsh-profile-template/ 目录 28/11 fix——plugin-supply 本体低痛。
- ⑤ 陈旧度：spec 2026-10-28 vs 桥 2026-10-27 → 不 stale。

## 6. dsh-runtime-bridge — A-

理由：spec 14 条 Requirement 与 dsh-bridge.js 能力一一对应，桥侧测试三件套近两周内仍在更新；仅降级路径测试偏旧。

- ① 对齐：spawn/退避→`dsh-bridge.js:55`(30s 上限)/`:112`(restarts 计数)；prompt 转发→`:433-435`；restart 覆写(cwd/provider/model)→`:166-175`(env 注入)/`:141-144`(restart-in-progress 拒绝竞态)；preset 泊靠→`scripts/test-bridge-preset-park.mjs` 对应的 mount 语义；通知翻译→`server/dsh-events.js`(e2875486 双形状解析)+`server/agent-session.js`；platform/stream 活流→ab349b55(合同⑮同源)。shadow 未发现。
- ② 测试：`scripts/test-bridge-preset-park.mjs`(10-31)、`test-preset-session-bridge.mjs`(11-01)、`test-dsh-mcp-delivery.mjs`(10-25)、`test-dsh-degrade.mjs`(10-11，偏旧)。
- ③ 部署：随 platform 镜像 dde77c3a ⊆ HEAD；0.2.0-rc.2 子进程形状由矩阵门保（见 7）。
- ④ 痛感：dsh-bridge.js 15 commits/5 fix；`server/agent-session.js` 30/15（含 225dc9e3 目录预设重启必补投、2335a038 effort 透传）。
- ⑤ 陈旧度：spec 2026-10-21 vs dsh-bridge.js 2026-10-31 → 10 天，不 stale。

## 7. dsh-version-matrix — A-

理由：意图单行+lockstep lock+四剪枝位点+双进程启动门全部就位，根树 9 行 dsh 依赖与矩阵同代（0.2.0-rc.2）实证一致。

- ① 对齐：启动硬门→`lib/dsh-matrix-verify.js:190`(matrixGate)接线 `server.js:1068`+`agent-runner/index.js:21,:38`；逃生口→同文件 `:190`(DSH_MATRIX_OVERRIDE 参数)；剪枝→`dsh-matrix/prune.json:3`+`prune.mjs`（四位点：/opt/dsh、app 树、合同 scratch、桌面 predist，见 $comment）；Dockerfile→`:89-101`（无逐包钉版，COPY dsh-matrix 后 npm ci）；统一代→根 `package.json:39-47` 九行 @deepseek-ai 全部 0.2.0-rc.2，与矩阵意图同代。shadow 未发现。
- ② 测试：`scripts/test-dsh-template-closure.mjs`(11-01)覆盖模板闭包；**未证实** matrixGate 本身有专门单测（scripts/ 无 test-dsh-matrix-verify*）。
- ③ 部署：镜像由矩阵装（Dockerfile:97-101）；部署镜像 dde77c3a ⊆ HEAD，lock 于 2026-10-27 冻结（ad24a3f7）。
- ④ 痛感：dsh-matrix/ 8 commits/2 fix；`lib/dsh-matrix-verify.js` 3/2（a7a175df 快照树感知）。低痛。
- ⑤ 陈旧度：spec 2026-10-14 vs lock 2026-10-27 → 13 天，不 stale。

---

## 簇摘要 — 三件最严重的事

1. **cron-module spec 与代码在「停机补跑」上反向漂移**：`openspec/specs/cron-module/spec.md:51-57` 明文 "SHALL NOT catch up"，而 `cron.js:186-231` 实现容忍窗内 makeup 回合（catchUpPending+【补跑】标记，50ef027f 2026-10-26 上产），且所有归档 change 的 spec delta 均未修订该 Requirement——spec 是行为契约的假象，新读者会按「不补跑」理解线上行为。建议补一份 fix 类 change 修订 Downtime lifecycle 需求。**【11-06 复核已销】**：align-yizuo-specs-to-reality（90acfaf10）已把该 Requirement 改写为补跑容忍窗口径（spec.md:61 现文：2× 周期/6h 地板/`PLATFORM_CRON_CATCHUP` 开关，窗内补一次+窗外记账+missed-beat 告警），「SHALL NOT catch up」原文已不存在。
2. **dsh-profile.js 痛感集中 + 测试剪刀差**：09-05 以来 67 commits/24 fix（全簇最高），f62f2177 凭据交付控制器等深水修复连续落在此文件，但其定向测试（test-llm-providers/llm-retry/credential-file-format）停在 10-11~10-14，落后最近代码 3 周以上——回归网变薄。
3. **dsh-plugin-supply 宿主侧测试真空**：enable/disable 持久化、流中拒绝、双 cell 隔离、失败可见四组 Scenario 在 scripts/ 无任何宿主单测（grep 仅命中合同⑱候选模式路径）；桥端行为回归只能靠候选 dsh 树上的合同，宿主写穿逻辑（agent-session.js:1039 togglePluginBundle 三分支）无红绿护栏。

**挂账核对（任务背景项）**：paas e339636e「cron 冷启动修复」——`git merge-base --is-ancestor` 对 origin/main、部署镜像源 dde77c3a、tag v0.1.0-skill-display 均为真 → **已推已出片，历史挂账可销**。
