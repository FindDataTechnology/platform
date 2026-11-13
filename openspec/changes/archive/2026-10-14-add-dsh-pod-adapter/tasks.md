# Tasks: add-dsh-pod-adapter

## 1. 桥 per-session persona（dsh-profile-template）

- [x] 1.1 `platform-preset-bridge.js`：新增 `preset/set {sessionId, presetId}`——
  `#pendingPresets` parked map；活会话（`sessions` 已有该 id）结构化拒绝；
  空字符串 id 校验拒绝
- [x] 1.2 `#createSessionInner` 解析顺序 parked → `agentPresetId` → 默认；parked
  取用即删（一次性）；resolve 失败创建前抛错（沿用现有回滚路径）
- [x] 1.3 `LIVE_METHODS` 增 `preset/set`（capabilities 自动带出）；会话头
  `meta.agentPreset` 记实际挂载 id（含 parked 来源）
- [x] 1.4 桥单测：parked 首回合生效 / 活会话拒绝 / 未知 preset 晚失败三条
  （复用现有桥测试基建）

## 2. tool-scope per-preset 段

- [x] 2.1 `platform-tool-scope.js`：filter 形状增可选项 `byPreset`；
  `readMcpToolFilter` 兼容旧形状；`applyMcpToolRestrict(agentCtx, presetId)`
  按 byPreset 段取成员精确面（缺段回退全 home 段）
- [x] 2.2 `dsh-profile.js` `writeToolFilterPatch`：接受 per-preset 集
  （`{ union, byPreset }`），顶层写并集；旧调用点形状不变
- [x] 2.3 桥 setup 钩子：`applyMcpToolRestrict(agentCtx, preset.id)` 传实际挂载 id

## 3. pack home 物化（agent-runner/compose.js）

- [x] 3.1 `materializePackHome({homeRoot, packId, members, …})`：N 行 persona
  preset（成员 preset id 与 solo 同名）、skills/MCP 并集、secrets 并集
  （同名同 ref 由资格门前置保证）、billing key 单写、byPreset tool-filter、
  workspace 取成员声明并集/最大 quota
- [x] 3.2 资格判定 `packPodEligibility(members)`：billing key 一致/全无、
  secret 同名同 ref——返回 {ok, reason}（capabilities 门在 spawn 后，3.5）
- [x] 3.3 compose 单测：双成员物化形状（presets 行数/并集/byPreset/单 credentials
  写入）、同名异 ref 拒判

## 4. manager/child pod 粒度（agent-runner）

- [x] 4.1 `config.js`：`podMode`（默认 0）、`podCostMb`（160）、`podMaxInflight`（1）
- [x] 4.2 `manager.js` 分组：pod 模式下 reconcile 后按 packId 分组+资格门，
  `children` 键=podKey；pod identity=成员身份按键序合并，任一变整 pod 排水重建
- [x] 4.3 `acquire(entry)`：定位/孵化成员 pod；冷启动阶梯单位=pod（-32004 不变）；
  spawn 后 `platform/capabilities` 门（缺法 → 停 pod、该 pack 回退 solo）
- [x] 4.4 paused 成员拒回合（-32010）pod 留守；health 成员条目由 pod 派生；
  fleet woken/reaped 逐成员发
- [x] 4.5 `child.js`：pod 用法——`members` 表、`turn(sessionId, text,
  {agentKey, onDelta})` wire id 映射 `<agentKey>--<sessionId>`、首见会话先
  preset/set+model/set（parked）再 prompt、per-member 预算覆盖
- [x] 4.6 预算取消：pod 成员超时 → `session/cancel`（10s 有界）→ -32001 结算
  meter 记 kill；不收敛才 budgetKilled 兜底停 pod；solo 路径不动
- [x] 4.7 在途纪律：pod.activeTurns 超 `podMaxInflight` 排队（不失败不抢占）；
  delegation 槽照旧叠加
- [x] 4.8 warm-zone：footprint 记 pod RSS 一份/`podCostMb` 回退；`maxChildren`
  语义=最大 pod 数；驱逐/降级单位=pod（逐成员发 reaped）
- [x] 4.9 `reapExternalContexts`：`srv-wx-` 段含匹配（split `--` 取尾段），
  solo 名行为不变
- [x] 4.10 manager 单测：分组/资格门/合并身份排水/取消优先预算/pod 记账/
  命名空间映射/reap 含匹配（fake-harness 注入）

## 5. 合同⑯（scripts/lib/dsh-contracts）

- [x] 5.1 `contracts.mjs` 合同⑯：双成员共宿（探针插件 `/agent` 扩 preset/set 面
  或直连 live method）——parked preset 各归各会话头、各成员模型请求不渗、
  活会话拒绝、历史不互串
- [x] 5.2 全量合同两轮绿（真矩阵树 0.2.0-rc.2）；`dsh-adapter-files.json`
  名单核对（新 import 文件入列）

## 6. docs 与台账

- [x] 6.1 `docs/wanxing-multi-harness-runtime-explore.md`：D1 判读订正落盘
  （收尾串行=进程级，源码+探针双证；「每会话一 agent 上下文=结构性解」撤销）；
  切片②立项标记；未决问题 4 记 v1 保守答案
- [x] 6.2 AGENTS.md 无涉；出片/滚版手册按既有 fd 线引用（无新通道）

## 7. 生产验证（apply 末段）

- [x] 7.1 pod 模式上生产 runner（`AGENT_RUNNER_POD_MODE=1`）+ 一个双 serving
  agent pack 共宿部署眼见：单进程 ps、双 persona 回合各归各、-32010/排水/回温
  路径抽查
- [x] 7.2 内存对照记录（1 pod vs 2 solo children）回底稿；health/fleet 面板
  成员条目正确
