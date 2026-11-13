# Tasks: add-fleet-cockpit-projection

- [x] 1.1 paas `/api/fleets/overview`：owner/admin 全景 compact（50 fleets 硬界；decisions top3 题面≤80字、stream 各岗 latest 摘要≤120字/槽≤4；v:1+sampledAt）；复用 deriveMemberStatus/latestReport/decision 排序 helper；非舱主 403（生产直证：他人邮箱打上任 cell → 403，ownerEmail 200 含 20 舰队）
- [x] 1.2 paas 单测：owner 全景一往返界内截断、非舱主 403、decision severity 先高后近临期、stream 摘要/指标剪割正确（test-fleet-core 20/20；被并行会话 f2495b17/af3b8615 扫入内容相符）
- [x] 2.1 paas cell-sampler 二路 tick：独立间隔 `FLEET_CELL_FLEETS_SAMPLE_SECS`(默认60)、关断 `FLEET_CELL_FLEETS_ENABLE=0`；活 cell 每 tick 发 cell_fleets（agent=cell:<hex 用户 id>）；失败 log-only
- [x] 2.2 paas test-gateway-fleet-cells 7/7：品种 verbatim、统计道零扰动、kill switch、**身份分流回归**（hex 键+cell.email→转发 owner 邮箱、email 缺失→落回 hex、事件身份与统计道同 hex）
- [x] 3.1 萬星 store：`cell_fleets` 入 EVENT_KINDS；未知 kind 仍 400
- [x] 3.2 萬星读点 `GET /api/fleet/v1/cell-fleets`：raw 窗默认6h 每 agent 最新快照；stale（>3×tick）标识；requireToken（401 实证）
- [x] 3.3 萬星测试 12/12（latest-wins/stale/token/白名单）+ 全量 202/202
- [x] 4.1 OpsView 镜像段：健康 chips/待拍板 top3/stream 一行/样龄/深链 paas；observer 404 或空→整段隐去（不改 board 其它段）
- [x] 4.2 stub-console-web 三态浏览器眼见（full：两卡+待拍板×2+stale 徽+深链 pattern；empty/missing：整段隐去 cells-panel 共存）+ facade 代理路径 + wanxing-web build 绿
- [x] 5.1 上产滚动完成（台账 §15.61 全录）：observer digest 01ebd97f、facade sha-6fa63a5、web sha-5091e84、platform×4 sha-59701c2(digest 3e75e807) 全部滚完 imageID=digest 四面相等；TCR 100-tag 解禁 dispatch 直出
- [x] 5.2 生产真 bug 两枚回修（台账 §15.61）：身份分流（registry hex key≠owner email，403 静默）+ 超时分流（2000ms 预算 vs 2579ms overview，tick 全 abort）——两修复已随 59701c2 代码进 mirror，禁破除即产
