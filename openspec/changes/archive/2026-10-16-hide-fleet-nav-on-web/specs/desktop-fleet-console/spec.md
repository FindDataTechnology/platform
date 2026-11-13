# desktop-fleet-console 变更 Delta

## MODIFIED Requirements

### Requirement: 舰队页读面经 cell 代理

桌面 web 的舰队页 SHALL 经 cell server 的代理端点读取本机 runner 与公网目录，
不新增桌面侧凭据、不直接跨域调用：`GET /api/wanxing/fleet/live` 透传本机 runner
的 `/health`（runner 地址来自配置，默认本机 ops 端口），`GET
/api/wanxing/fleet/catalog` 以既有 registry 凭据代理公网 registry 的 a2a 目录。
两端点 SHALL 走标准 cell 鉴权。舰队页与它的导航入口 SHALL 只在 Electron 桌面
壳内可达（以 preload bridge 的存在为准，`window.platform`）——纯浏览器里导航
不渲染「萬星舰队」入口，路由直达也落在一个明确的桌面专属说明页，而非两个恒空
的读区：本机 runner 概念只对桌面进程成立，网页访客没有"本机"。

#### Scenario: runner 运行时舰队页有数据

- **WHEN** 舰队页加载且本机 runner 健康
- **THEN** live 端点返回 runner 的 agents 五态、children 数与 budget 足迹

#### Scenario: runner 未运行如实降级

- **WHEN** 艦队插件未启用或 runner 进程不在
- **THEN** live 端点返回 503 与可展示的状态文案，页面呈现「未启用/未运行」引导态而非错误弹窗

#### Scenario: registry 未配置时目录降级

- **WHEN** 未配置 AGENT_SERVING_REGISTRY_URL
- **THEN** catalog 端点返回 503 与「未配置 registry」文案，舰队页目录区显示引导而非空白

#### Scenario: 目录只读不含部署动作

- **WHEN** 舰队页目录区渲染
- **THEN** 部署入口呈禁用态并标注「待设备管理面（切片③）解锁」，不发起任何写请求

#### Scenario: 纯浏览器导航不含舰队入口

- **WHEN** the sidebar renders in a plain browser (no preload bridge)
- **THEN** no fleet navigation item is present, and no desktop-only page is reachable from the navigation

#### Scenario: 浏览器直达舰队路由落到说明页

- **WHEN** a plain-browser viewer opens `/fleet` directly
- **THEN** a desktop-only explanation renders in place of the two read zones, and no proxy endpoints are polled
