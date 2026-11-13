# desktop-fleet-console Specification Delta

## REMOVED Requirements

### Requirement: 舰队页读面经 cell 代理

**Reason**: 本 change 把它取代为「读面 + 本机写面」——目录从「只读待设备管理面
解锁」变为可写控制面，catalog 默认源从公网 registry 变为 cell 本机 feed，
两端点的代理/桌面壳门控语义在新要求中完整保留并扩展。整块重写在 ADDED 段，
旧块不复存在。

（原要求全文：桌面 web 的舰队页 SHALL 经 cell server 的代理端点读取本机
runner 与公网目录，不新增桌面侧凭据、不直接跨域调用：`GET
/api/wanxing/fleet/live` 透传本机 runner 的 `/health`（runner 地址来自配置，
默认本机 ops 端口），`GET /api/wanxing/fleet/catalog` 以既有 registry 凭据
代理公网 registry 的 a2a 目录。两端点 SHALL 走标准 cell 鉴权。舰队页与它的
导航入口 SHALL 只在 Electron 桌面壳内可达（以 preload bridge 的存在为准，
`window.platform`）——纯浏览器里导航不渲染「萬星舰队」入口，路由直达也落在
一个明确的桌面专属说明页，而非两个恒空的读区：本机 runner 概念只对桌面进程
成立，网页访客没有"本机"。原带六个 scenario：runner 运行时舰队页有数据 /
runner 未运行如实降级 / registry 未配置时目录降级 / 目录只读不含部署动作 /
纯浏览器导航不含舰队入口 / 浏览器直达舰队路由落到说明页。）

## ADDED Requirements

### Requirement: 舰队页读面经 cell 代理（含本机目录与写面）

桌面 web 的舰队页 SHALL 经 cell server 的代理端点读取本机 runner 与目录，
不新增桌面侧凭据、不直接跨域调用：`GET /api/wanxing/fleet/live` 透传本机 runner
的 `/health`（runner 地址来自配置，默认本机 ops 端口）；`GET
/api/wanxing/fleet/catalog` **默认读 cell 本机 feed（本机部署目录），外部
registry 凭据存在时可切换为公网 a2a 目录的只读桥**。两端点 SHALL 走标准 cell
鉴权。舰队页与它的导航入口 SHALL 只在 Electron 桌面壳内可达（以 preload
bridge 的存在为准，`window.platform`）——纯浏览器里导航不渲染「萬星舰队」
入口，路由直达也落在一个明确的桌面专属说明页，而非两个恒空的读区：本机
runner 概念只对桌面进程成立，网页访客没有"本机"。渲染层 SHALL NOT 拥有任何
写路径：全部写动作经 cell 写面（见下条）。

#### Scenario: runner 运行时舰队页有数据

- **WHEN** 舰队页加载且本机 runner 健康
- **THEN** live 端点返回 runner 的 agents 五态、children 数与 budget 足迹

#### Scenario: runner 未运行如实降级

- **WHEN** 艦队插件未启用或 runner 进程不在
- **THEN** live 端点返回 503 与可展示的状态文案，页面呈现「未启用/未运行」引导态而非错误弹窗

#### Scenario: 目录降级只发生在双源皆不可用时

- **WHEN** 本机 feed 不可用（插件未启用）且未配置 AGENT_SERVING_REGISTRY_URL
- **THEN** catalog 端点返回 503 与可展示文案，舰队页目录区显示引导而非空白

#### Scenario: 目录默认吃本机 feed

- **WHEN** 插件启用且本机部署非空
- **THEN** catalog 端点返回本机部署目录（含每条的启用态），不依赖任何外部 registry 可达性

#### Scenario: 部署入口解锁

- **WHEN** 舰队页目录区渲染且某 pack agent 可部署
- **THEN** 部署/启停动作呈可用态并指向本机写面（原「只读待解锁」禁用态作废），云席位区仍保持只读桥语义

#### Scenario: 纯浏览器导航不含舰队入口

- **WHEN** the sidebar renders in a plain browser (no preload bridge)
- **THEN** no fleet navigation item is present, and no desktop-only page is reachable from the navigation

#### Scenario: 浏览器直达舰队路由落到说明页

- **WHEN** a plain-browser viewer opens `/fleet` directly
- **THEN** a desktop-only explanation renders in place of the two read zones, and no proxy endpoints are polled

### Requirement: 本地部署写面闭环

cell SHALL 提供本机部署写端点（deploy / stop / start / remove），舰队页的动作
全部经它闭环，浏览器不直连 runner、不触云：deploy 从「已安装且含 serving 声明」
的 pack agent 发起；stop 排空运行时而保留部署身份；start 恢复；remove 删除部署
记录。写面 SHALL 走标准 cell 鉴权，写结果在 feed 上即时如实（透传
`local-agent-registry-feed` 的条目语义），容量超限以结构化错误呈现（可转为
「卸载腾出」引导），不得出现写成功但 live/feed 不可见的假绿。UI SHALL 分区
呈现「本机集群（可写）」与「已配对云席位（只读桥）」，配对状态不改变本机
集群的可管理性。

#### Scenario: 一键部署到本机

- **WHEN** 用户对可部署条目点部署且容量未满
- **THEN** 写端点落部署记录、feed 含条目，runner 节拍内拉起，live 端点随后可见其五态

#### Scenario: 容量打满给引导不装死

- **WHEN** deploy 撞到 `capacity_exceeded`
- **THEN** UI 呈现已用/上限与「卸载某部署腾出」引导，不产生半成品部署

#### Scenario: 启停身份稳定

- **WHEN** 用户 stop 后 start 同一部署
- **THEN** 部署称号、端口与会话身份保持不变，feed 条目摘而复现

#### Scenario: 未配对云席也可管本机集群

- **WHEN** 桌面从未完成 6 位码配对
- **THEN** 本机集群区的全部读/写动作可用，云席位区呈现「未配对」引导而非禁用本机区
