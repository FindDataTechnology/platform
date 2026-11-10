# desktop-fleet-console Specification

## Purpose
桌面端查看本机舰队与后台驻留的壳：舰队页经 cell server 的代理端点（`/api/wanxing/fleet/live` 透传本机 runner 健康、`/api/wanxing/fleet/catalog` 以既有 registry 凭据代理公网 a2a 目录）读取数据，不新增桌面侧凭据，且只在 Electron 壳内可达（纯浏览器落到桌面专属说明页）；关闭主窗口最小化到系统托盘而非退出，runner、其 agents 与定时任务继续运行，托盘「退出」才执行 supervisor 有序停机。

## Requirements

### Requirement: 托盘驻留生命周期

关闭主窗口 SHALL 最小化应用到系统托盘而非退出：runner 与其 agents 继续运行
（含已排定的定时任务）。托盘 SHALL 提供「显示」与「退出」动作；「退出」执行
supervisor 有序停机（drain 全部 runtime children）后真正退出。未启用插件的
安装同样适用驻留（对话 cell 的定时任务同理受益）。

#### Scenario: 关窗驻留

- **WHEN** 用户关闭主窗口
- **THEN** 应用驻留托盘，runner（若启用）与全部 agents 继续运行

#### Scenario: 托盘退出即排空

- **WHEN** 用户从托盘菜单选择退出
- **THEN** supervisor 按序停机、全部 runtime children 停止后应用进程退出，无孤儿

#### Scenario: 托盘显示恢复窗口

- **WHEN** 用户点击托盘「显示」
- **THEN** 主窗口恢复（最小化过的还原）并获得焦点

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
集群的可管理性。已配对且上行开启时，UI SHALL 为部署条目标注来源——「云期望」
（经期望态合并落地或与云端期望一致）或「本地手动」（本机用户动作确立）——并在
条目与云端期望态不一致（本地手动赢生效）时呈现背离标记；手动动作 SHALL 永远
落本地表且优先于云端期望态，不因云期望被自动打回。

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

#### Scenario: 来源标注随配对出现

- **WHEN** 机器完成配对、开启上行并完成首次期望态合并
- **THEN** 本机集群区条目呈现来源徽标（云期望/本地手动）；未配对或未开启上行的机器不显示徽标

#### Scenario: 手动停止不被云期望打回

- **WHEN** 用户手动停止一条「云期望=启用」的条目
- **THEN** 本地保持停止态，该条目呈现背离标记（期望与实况不一致），而非被合并自动恢复
