# Design: add-desktop-fleet-runner

> 底稿：`docs/wanxing-desktop-fleet-plugin-explore.md`（grill 十问裁决在册）。
> 本文只记录切片①的实施决策。

## D1 挂点=描述符条件启用，v1 重启生效

`supervisor/descriptors.js` 新增 `agent-runner-js` 描述符，`enabled` 由注入的
`agentEnv.WANXING_PLUGIN_ENABLED === "1"` 解析（构造时读——Supervisor.start() 对
disabled 描述符跳过、标 `disabled` 态）。运行时改开关不热启：Preferences 保存后明示
「重启应用生效」。热启能力（startSingle）留给②（托盘驻留一并做）。

- `optional: true`——失败/不健康降级，不挡 server-js 与主窗口。
- `dependsOn: []`——runner 与 cell 无依赖，健康探针独立（`/health`，默认端口
  8790=runner ops 面；agent A2A 端口 span 8791+ 不占 8790）。
- start：`nodeBin agent-runner/index.js`，cwd=projectRoot（发行树内代码就在位）。

## D2 机位 id=first-run 种子

`electron/bootstrap/first-run.js` 的 idempotent 种子逻辑加一项：缺
`WANXING_PLUGIN_RUNNER_ID` 时生成 `desktop-<8hex>`（crypto.randomBytes）写入
settings.json。此后停用/启用沿用同 id。用户可改（自主权），不校验格式以外的合法性。

## D3 分片安全=双 id 显式分离

`agent-runner/config.js` 既有默认 `fleet id = default id = "runner-1"`（云端单机位
兼容形状）——桌面若沿用会把云端 untagged 条目拉到本机。桌面 env 定死：

```
AGENT_RUNNER_FLEET_ID   = desktop-<8hex>   （=机位 id）
AGENT_RUNNER_DEFAULT_ID = cloud-default    （哨兵：registry 永无此机位）
```

分片过滤 `(entry.runner_id ?? defaultRunnerId) === fleetRunnerId` 对 untagged 条目
恒假、对 tagged 本机位条目恒真。不修改 registry client 代码。

## D4 调度隐形=零代码

机群表（`registry.runnerList()`/agent_runners）由云端部署静态登记，runner 从不写它；
①不配 `AGENT_RUNNER_FLEET_URL` → 不上报 board。fleet-scheduler 的 stale/重派循环以
机群表∪board 为观测面，桌面机位两者皆无 → 永不被观测、条目 sticky。无代码改动；
③引入上报时需对 desktop 标记短路（③的 spec 面，此处不做）。

## D5 监听 host 配置化

`agent-runner/config.js` 加 `host: env.AGENT_RUNNER_HOST || "0.0.0.0"`；
`index.js:159`（ops）与 `manager.js:257`（agent A2A）两处 `listen(port, "0.0.0.0")`
改用 `config.host`（manager 经 config 传递）。云端不注入 → 逐字节零变化；桌面 env
注入 `AGENT_RUNNER_HOST=127.0.0.1`。

## D6 桌面 env 装配（descriptors 注入）

```
DSH_BIN                     = <projectRoot>/node_modules/.bin/dsh（发行树内）
DSH_MATRIX_INSTALL_ROOT     = 不设 → matrixGate skip（无 /opt/dsh，发行树树自带锁步包）
AGENT_RUNNER_HOME           = <dataDir>/wanxing-runner
AGENT_RUNNER_POD_MODE       = 1（grill Q6：pod 默认开）
AGENT_RUNNER_HOST           = 127.0.0.1
AGENT_RUNNER_PORT           = 8790
AGENT_RUNNER_FLEET_ID/DEFAULT_ID = 见 D3
AGENT_SERVING_REGISTRY_URL/TOKEN = 用户在 Preferences 填（默认空 → runner 起 inert）
```

registry 未配置时 runner 的行为：`index.js` 现状是 `registryUrl` 缺失即
`process.exit(1)`——桌面插件「开了但没填 registry」会反复重启退避。接受（optional
降级语义：状态 unhealthy 可见），Preferences 面板把 registry URL 设为启用前置校验。

## D7 生命周期跟随

零新代码：runner 的 SIGTERM 处理已 drain children（index.js 187-196）；
supervisor.stop() 反向序停机覆盖 `agent-runner-js`；崩溃走 `_onExit` 退避重启。

## D8 测试与验收

- 单测 `scripts/test-desktop-fleet-runner.mjs`：
  (1) 默认 env 无插件描述符启动（disabled）；(2) 开启后描述符 enabled+env 注入断言；
  (3) config.host 默认 "0.0.0.0"、注入 "127.0.0.1" 生效；(4) first-run 种子 id
  幂等；(5) 分片过滤：untagged 条目被 desktop fleet id + cloud-default 哨兵排除。
- 探针 `scripts/probe-desktop-fleet-runner.mjs`（验收）：stub registry（内存假条目
  tagged 机位 id）→ 以桌面 env 起 runner → reconcile 拉到条目 → 真 dsh child 起 →
  A2A `message/send` 真回合（LLM 走 token.finddatatech.cloud rehearsal 配方，
  deepseek/deepseek-v4.1-flash）→ 断言回复文本。不碰公网 registry。

## 实施中发现（回写）

- **dsh 前缀 args 消费点在 index.js 的 clientFactory**（manager 的 solo/pod 两条
  spawn 路径都经它）——`DSH_BIN_ARGS`（JSON 数组）+ `args: [...prefix, ...args]`。
  首版 Edit 留下对象字面量双 `args` 键（后者胜出）导致前缀静默失效，探针
  `node: bad option: --profile` 抓出——真回合探针是这类接线缺陷的唯一可靠门。
- **profile 基座来源**：runner 的 `seedHome` 默认 `/opt/dsh-home`（容器烘焙）；
  桌面对应物=**与 chat cell 同一共享 dsh home（~/.dsh）**——cell 的
  `ensureDshHome()` 首跑建立 scaffold+模块树，descriptors 探测到
  `~/.dsh/profiles/platform` 存在时注入 `AGENT_RUNNER_SEED_HOME`（compose 的
  seed 拷贝+scaffold symlink 机制原样复用）。
- **Supervisor.restart 对 disabled 描述符必须短路**：Preferences 的保存流会对
  registry 字段变更 opportunistic 地 restart `agent-runner-js`，不检查 enabled
  会把禁用的插件拉起——`lifecycle.js restart()` 加 `!enabled → false`。
- **探针验收配方**（`scripts/probe-desktop-fleet-runner.mjs`，7/7 PASS）：loopback
  stub registry（seat-tagged + untagged 干扰条目）→ 真 runner 子进程（桌面 env
  全套）→ 真 dsh child 冷启 → A2A `message/send` 真回合（finddata/
  deepseek-v4.1-flash，回复「就绪」）→ SIGTERM 干净退出。untagged 条目未上机位
  （分片哨兵实证）。

## 风险

- **内存**：runner+child 与 cell 同宿用户机器——warm-zone 预算已有；②舰队页可视化。
- **端口撞**：8790/8791+ 若用户机器被占——optional 降级+状态可见；端口可经 settings
  覆写（env 透传已有）。
- **pod 默认开的回归面**：云端默认 solo 未动（env 只注入桌面）；`AGENT_RUNNER_POD_MODE`
  既有合同测试覆盖两态。
