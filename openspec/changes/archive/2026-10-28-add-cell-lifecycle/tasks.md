# Tasks: add-cell-lifecycle

> 交付次序（Q22 定稿）：桌面章 ①② 先行（客户 deadline）→ 舰队 A change 并行 →
> 云端章随后接续 → 桌面章 ③④ 与云端章合龙。词汇（cell-lifecycle spec）为共同前置，
> 已随本 change 立卷。
> **实施链状态（2026-10-27）**：①②+3.x+4.x 代码面完成（40/40 单测绿），上产验收已过（sha-ebbb112）；
> ④读模型/owner-offline、5.3 真机八幕、⑥归档挂账后续。

## 0 · 共同前置（词汇与测试基座）

- [x] 0.1 `lib/cell-lifecycle.js`：状态机/居住策略/事件种/白名单字段的单源常量与
  `transition(row, event)` 纯函数（云端与桌面同引用）；node:test 覆盖全部合法/非法迁移
- [x] 0.2 `lib/cell-registry.js` 注册表行 schema（schemaVersion 自带）与 boot 幂等
  迁移函数+JSON-ledger（原子写）；node:test 钉 backfill 与旧行升级、损坏不阻 boot

## 1 · 桌面章①常驻化 + UI attach（客户核心价值）

- [x] 1.1 `supervisor/steward-main.js` 宿主入口：构造同一 `Supervisor` + 控制面 server
  （mac Unix socket / Windows named pipe，ACL 属主），写 `steward.json`+`steward.pid`
- [x] 1.2 控制面 RPC：hello/status/start/stop/drainQuit/restart/getPolicy/setPolicy；
  每帧带 protocolVersion，major 不符显式拒；node:test 协议面 5/5
- [x] 1.3 `electron/main.js` attach 优先（发现健康 steward→IPC 全部代理到控制面；
  未发现→嵌入式回退逐字节不变；发现不可达→修复引导，绝不双 stack；pid 活但 socket
  死→显式报错拒绝第二栈）
- [x] 1.4 e2e 基座：控制面/策略/安装器/词汇四套单测（发行线真机验收随 5.3 合龙）

## 2 · 桌面章②自启安装 + 存留策略

- [x] 2.1 安装面（Preferences「后台管家」tab）：同意文案三事逐条（常驻/自启/配对后
  心跳）；LaunchAgent（macOS）与 Scheduled Task/Run 键（Windows）注册，零 admin；
  卸载器清理（drainQuit→解注册）；孤儿自净（.app 删除→自解注册退出）
- [x] 2.2 存留策略执行：always（默认）/on_demand（读 jobs.json 时刻表唤醒+静默排干）
  /manual（未安装回退世界）；策略变更落管家台账；node:test 6/6
- [x] 2.3 排干更新链：steward.pid 纯数字孪生（免 NSIS 解析 JSON）+安装器
  drainQuit→换包→自启稳定路径；NSIS include 钩子（customInit/customUnInstall）

## 3 · 云端章（注册表 + 唤醒环 + 销毁）——后续棒

- [x] 3.1 网关持久 cells 注册表（自有持久库）：spawn/suspend/wake/destroy 全经
  spawner 一处裁决；boot backfill（扫数据根→on_demand 行）+ 重启重建需求面；
  node:test 滚版重建场景
- [x] 3.2 值班环：读持久化时刻表（零探针）、有界并发(默认4)+拉起冷却、静默挂起；
  过渡配置：无 A change 语义时延迟 boot-ready 窗口交火
- [x] 3.3 销毁动作（管理面）：live 拒绝/force 放行的护栏、数据根删除、墓碑抑制
  spawn/唤醒、原因落账；node:test 全场景
- [x] 3.4 `CELL_IDLE_REAP_SECS` 豁免条款退役过渡桥 + DEPLOY.md/台账更新

## 4 · 桌面章③配对 + 上行——后续棒

- [x] 4.1 steward 配对：复用 device-pairing 通道（bind 码→公钥→挑战），kind 标记；
  私钥入 OS 钥匙串；上行门断言（凭据域最小化测试：非上行端点一律拒绝）
- [x] 4.2 ingest 侧 event 种 cell_presence/cell_manifest + facet 读模型派生（窗口语义，
  同 runner board）；白名单 schema（shape 层无内容字段）
- [x] 4.3 桌面上行客户端：默认关、明式开关、同意文案逐条白名单、环形缓冲 degrade-open

## 5 · 销毁三路合龙 + owner-offline 呈现——后续棒

- [x] 5.1 卸载钩子（2.1已在位）/ console 撤销→401 自焚（4.3已在位）/ 沉默 30 天
  墓碑＝facet 读模型侧（÷4.2 ingest 转发已过桥，读模型落 facet 仓工单）
- [x] 5.2 平台读面：owner offline 命名（管家在线=在线、离线=owner offline 不计异常）；
  未注册=诚实缺席
- [x] 5.3 真机验收链：跑/排干/撤销/装/关 UI 存活/卸载排干 = CI 化完成（§15.67）；残留
  人工观察项（息屏/关机重启、Mac+Win 双形态真机眼见）与 DPAPI+reporter 打包态覆盖
  （随 v1.3.20 win-smoke Phase D 跑出），属既有「统一人工观察项」口径
  - 迁址（2026-10-28 消重）：win-smoke Phase D 已并入 `release.yml` 的
    `installer e2e (windows)`（单栈树断言 + 卸载排干常驻管家 + 计划任务注销），
    该作业是唯一装机 e2e 车道；win-smoke 只保留装/跑/窗三幕。见台账 §15.73。

## 6 · 收尾

- [x] 6.1 台账登记（§15.62，桌面章①②发布记录）；`.env.example` 增量注记
  （本章无新 env；含义行已记台账）
- [x] 6.2 openspec validate 全绿后归档（合龙后）
