## 1. 前置核实与地基

- [x] 1.1 核实 hosted 部署 gateway/server 共库前提（bindings 经 mp-bindings 的实际存储路径；不共则按 D4 降级方案把两门同迁 server 进程），核实结论写回 design.md Open Questions 并定迁移基线版本号（v108/v109 是否被并行会话占用）
- [x] 1.2 cell 侧迁移 v108 `local_fleet_deployments` 加 `source` 列（默认 `manual`）+ gateway 侧机器仓 `gateway/fleet-machines-store.js`（JSON 文件仓照 mp-bindings 原子写惯例，路径 `DATA_ROOT/fleet-machines.json`）；`npm run typecheck` 与既有迁移测试绿

## 2. 云端：存储、两道门、名册

- [x] 2.1 新 `server/fleet-machines.js`：名册聚合（bindings steward 设备 ∪ detail 表 ∪ desired 表）、期望表读写（编辑自增 version、幂等重复添加返回既有条目）、健康派生（沉默阈值 env 可配默认 30min / 背离连击≥3 / 自报异常超阈值），零出站探测；单测覆盖聚合与派生
- [x] 2.2 期望态拉取门（gateway，同 `stewardFromToken` 鉴权）：目标机恒取 token 内 `did`、拒收任何 body/query deviceId，非 steward 凭据 401/403，吊销即 401；单测钉死「只能拉自己」（伪造他机 id 必拒）
- [x] 2.3 上报门扩容：`cell_detail` 事件类进 shape 白名单（per-cell 五态、部署条目名/包名/版本/启用态/source、运行时组占用、合并拒绝计数、崩溃环计数），落存 `fleet_machine_detail`；presence 顺手 upsert last_seen_at；单测钉死内容类字段（prompt/会话/工具结果形）剥离不落存、元数据照常落存
- [x] 2.4 web 机器段 API（server）：名册列表、机器详情（最近快照+样龄标注）、期望态编辑端点（标准用户鉴权、只碰自己账号机器、admin 视角复用既有语义）；单测覆盖账号隔离

## 3. 桌面：期望态拉取与合并

- [x] 3.1 部署表加 `source` 列（`manual` 默认 | `cloud`），写端点收可选 source 枚举参数（UI 永不传）；手动动作把 `cloud` 行翻 `manual`（领养即本地赢）；迁移随 1.2 或桌面侧独立小迁移，单测钉死 D1 三条规则矩阵（手动→云、云→手动领养、remove 后重部署）
- [x] 3.2 supervisor 拉取循环：上行开启才拉取、定期节拍（同 60s 环）+ 版本号变更触发；拉取结果按 D2 经 cell 既有部署端点序列落地（带 source=cloud、撞容量/不可部署=结构化拒绝计数）；单测覆盖云端新增落地、本地手动不被打回、断网降级退回本地期望集
- [x] 3.3 cell_detail 组装（supervisor tick）：读 cell 既有部署列表 + live 五态两端点组装 payload（含 source、期望 version_seen、拒绝计数、崩溃环计数），随上行环发送、degrade-open 沿用环形缓冲；单测覆盖组装字段与上行失败不阻塞本务
- [x] 3.4 同意文案更新（D7）：启用页逐条列出含 cell_detail 新增字段；存量已开启用户更新后首启一次性提示；UI 单测断言字段清单完整

## 4. web 面与 FleetPage

- [x] 4.1 新 `MachinesPage`（列表/详情抽屉/期望态编辑），导航注册遵守 surfaces 同注册律，i18n 五语言同批过 locale 闸；`npm run web:build:e2e` 后 e2e 覆盖配对设备出列、期望编辑三态（待领取/已对齐/背离）
- [x] 4.2 FleetPage 来源标注：部署条目「云期望/本地手动」徽标（未配对或未开启上行不显示）+ 背离标记（手动停止 vs 云期望启用）；e2e 断言手动停止不被自动打回
- [x] 4.3 机器健康哨呈现：沉默/背离/自报异常三态上浮与排序沉底，陈旧快照「样龄」标注如实

## 5. 验收与收尾

- [x] 5.1 全量单测绿（含既有四套桌面集群测试零扰动）+ `openspec validate --strict` 绿 + typecheck/biome/locale 闸绿
- [x] 5.2 桌面探针扩腿（`electron/local-cluster-probe.mjs` 增：配对→拉期望→合并落地→手动领养→背离回写），双平台 CI 腿绿（Win 默认腿 + mac dispatch 腿）
  - 2026-10-30 双平台实证（run 40983161460 reuse 模式，复用 v1.3.26 产物不重建）：Windows 22 项、macOS 20 项探针断言全绿，含 desired 握手三腿——`cloud desired lands tagged cloud`（901）/ `local manual wins over the cloud desired set`（902）/ `adopted manual row survives withdrawal`（903）+ `detail beacon carries source + merge outcome`。
  - 随行的 Windows attach 腿红已归因并修复（boot 步 `-RedirectStandardOutput` 让常驻 steward 的管道在 step 结束即关闭 → 宿主下次写日志死），改 `.cmd` 包装器自持文件句柄；详见台账 §15.90。
- [x] 5.3 真机走查：真机配对→云上编辑期望态→眼见机器节拍内领取并拉起→云上眼见实况对齐；手动停用→眼见背离标记与回写；断网→眼见本务照常
  - 2026-10-30 本地真 `server.js`（forward_auth 真身份）+ 真 reporter + 真合并循环，十一条腿全绿：夹具安装→真配对（kind 存活）→名册见机→PUT 期望 v1→reporter GET 拉取落信标→服务端合并拍部署 cloud 行→云名册见部署→手工部署翻 manual→撤回收 manual 行（本地赢）→第二包独立部署→纯撤回 60s 内删云行且手工行不动。
  - 走查逮出九个真缺陷（详见台账 §15.90），其中四个（期望拉取动词错+契约错 / load() 丢 kind / PUT 缺 body parser / 期望集不落盘+库未就绪谎报+启动拍退化 60s）本 change 内已修，回归四套 53/53 绿。
- [x] 5.4 台账 §新增一节（部署记录、真机证据链）+ 提交纪律（只 git add 本变更文件，勿 -A）
