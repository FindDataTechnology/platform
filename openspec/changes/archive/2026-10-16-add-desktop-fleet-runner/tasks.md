# Tasks: add-desktop-fleet-runner

## 1. runner 监听 host 配置化（云端零变化）

- [x] 1.1 `agent-runner/config.js`：加 `host: env.AGENT_RUNNER_HOST || "0.0.0.0"`
- [x] 1.2 `agent-runner/index.js` ops listen 与 `agent-runner/manager.js` agent listen
      改用 config host（manager 需把 host 传入 listener 创建处）
- [x] 1.3 既有 runner 测试全绿（宿主行为零变化断言）

## 2. supervisor 插件描述符

- [x] 2.1 `supervisor/descriptors.js`：新增 `agent-runner-js`（optional、
      enabled=`WANXING_PLUGIN_ENABLED==="1"`、healthPath `/health`、端口
      `AGENT_RUNNER_PORT||8790`、桌面 env 全套注入：DSH_BIN/AGENT_RUNNER_HOME/
      POD_MODE=1/HOST=127.0.0.1/FLEET_ID=机位 id/DEFAULT_ID=cloud-default/
      AGENT_SERVING_REGISTRY_URL/TOKEN 透传）
- [x] 2.2 确认 Supervisor 对 disabled/optional 语义无需改动（start 跳过、降级不挡）

## 3. 机位 id 种子

- [x] 3.1 `electron/bootstrap/first-run.js`：idempotent 种子
      `WANXING_PLUGIN_RUNNER_ID=desktop-<8hex>`
- [x] 3.2 descriptors 从 agentEnv 读该 id 拼 FLEET_ID

## 4. Preferences 舰队设置区

- [x] 4.1 `electron/preferences/`（renderer+ipc）：萬星舰队区——开关、registry URL、
      token（掩码显示）；白名单通道沿用 `settings:get-visible`/`settings:set-field`
- [x] 4.2 保存写 settings.json 原子写；开关项提示「重启应用生效」
- [x] 4.3 registry URL 为空时开关保存给出前置校验提示

## 5. 测试

- [x] 5.1 `scripts/test-desktop-fleet-runner.mjs`：五测（默认禁用/启用注入/host 两态/
      种子幂等/分片哨兵排除 untagged）
- [x] 5.2 全量 Node 测试道（`node scripts/test-*.mjs` 相关子集）绿

## 6. 验收探针（真回合）

- [x] 6.1 `scripts/probe-desktop-fleet-runner.mjs`：stub registry+桌面 env 起 runner →
      tagged 条目拉起 → A2A message/send 真回合（rehearsal LLM 配方）→ 断言
- [x] 6.2 探针含退出 drain 断言（无孤儿 dsh 进程）

## 7. 收尾

- [x] 7.1 docs：`docs/wanxing-desktop-fleet-plugin-explore.md` 切片①打勾落账
- [x] 7.2 openspec validate 全绿；实施中发现的偏差回写 design

## 8. ③第一刀扩展：监控上行+调度短路（2026-10-15 同 change 追加）

- [x] 8.1 runner_stats 自报 `desktop: true`（config `AGENT_RUNNER_DESKTOP` +
      sampler payload + index 接线）
- [x] 8.2 fleet-scheduler 三处短路：stale/orphan/pickPlacement 对 desktop- 前缀
      或自报 desktop 的机位全部排除（监控可见、调度不可动）
- [x] 8.3 上行 env 全链：settings 键 + descriptors 透传 FLEET_URL/TOKEN +
      Preferences 舰队区两字段（token 掩码）
- [x] 8.4 测试：scheduler 短路三场景（12/12）+sampler desktop 标志（8/8）+
      相关道回归（13/13）
- [x] 8.5 探针 `scripts/probe-desktop-fleet-uplink.mjs`：真 runner→stub ingest
      收到 runner_stats 且 desktop:true/pod:true 眼见

## 9. ③第二刀：机位配对协议+设备面后端（2026-10-15 同 change 追加）

- [x] 9.1 facade `services/wanxing-facade/devices.js`：铸码/列表/核销/吊销四端点
      +公开 ingest 转发（per-seat 验证在 facade、换服务凭据打 observer——
      observer 与部署面零改动，吊销即时生效）
- [x] 9.2 store `wanxing_devices` 表（token 存 SHA-256，明文只在核销给一次）
- [x] 9.3 桌面侧 cell `POST /api/wanxing/fleet/pair`：凭码核销、上行凭据服务端
      直写 settings.json（token 不经渲染层转交）+Preferences 配对面（输码即连）
- [x] 9.4 测试：facade 6/6（码单次/限形/转发换凭据/吊销 401）+paas 7/7+
      fd-wanxing 全量 141/141+paas 相关道 33/33
- [x] 9.5 端到端探针 `scripts/probe-desktop-fleet-pairing.mjs` 3/3：真 facade+
      真 store+真 pair 路由+真 runner 经 facade 转发上报（desktop:true 眼见）+
      吊销下一拍 401

## 10. ③第三刀：console 设备面 UI+部署链解锁（2026-10-15 同 change 追加）

- [x] 10.1 gateway/facet `deployHandler` desktop 分支：seatGrant HMAC 验签
      （seat|email|exp，共享 `WANXING_SEAT_DEPLOY_SECRET`）——公网/直调/代理无票
      全 403；条目落 loopback 占位 origin+`desktop_seat` 标记（分发-only，A2A 入站
      等④信箱）；fleet 查找段对 desktop 排除
- [x] 10.2 selfservice `deployCore`：desktop 目标查 device 归属（非本人 403）+签
      5 分钟 seatGrant 附转发体；非 desktop runnerId 原样透传
- [x] 10.3 console「桌面机位」tab（DevicesView：列表+board 在线态+铸码+吊销）
- [x] 10.4 DeployWizard 部署目标下拉（云端自动/我的机位，附 desktop 语义提示）
- [x] 10.5 测试：paas 62/62（seat 部署两场景）+deploy 道 17/17；fd-wanxing
      144/144（selfservice seat 三场景）；wanxing-web vite build 绿

## 11. ④：座席信箱——外部任务的异步入站（2026-10-15 同 change 追加，全片完）

- [x] 11.1 facade `mailbox.js`：投递（console 门）/拉取+回投（per-seat 凭据，挂
      fleet 前缀——runner 只需一个上行基址）/查询（console 门）；`wanxing_mailbox`
      表（queued→delivered→done 状态机，at-least-once+按 id 幂等结算）
- [x] 11.2 a2a 面 desktop_seat 拦截：message/send 投箱+排队回执（taskId+async 标
      记，永不触碰不可达 upstream）；message/stream -32601
- [x] 11.3 runner `mailbox.js` 轮询器：拉取→本地 manager.turn→回投；未托管 agent
      立即失败结算；index.js 接线（fleet uplink 配置即启用）
- [x] 11.4 测试：facade 信箱 5/5+a2a 拦截 1/1（50/50）+fd-wanxing 全量 150/150+
      paas runner 道 77/77
- [x] 11.5 E2E 探针 `scripts/probe-desktop-fleet-mailbox.mjs` 3/3：真 facade（设
      备面+信箱面+真 store）→真 runner 拉到任务→**真 dsh 真 LLM 回合回复「信箱
      就绪」**→回投→console 查询取回
