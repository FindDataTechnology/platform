# pack-install-server-side-manifest — 安装改服务端取包（SafeLine 兼容根治）

## Why

壹座市场「Subscribe & Install」在 2026-10-06 浏览器点检中发现对含代码/SQL 片段的 pack 静默失败：platform.finddatatech.cloud 前置 SafeLine（雷池）对 POST body 应用注入规则，而 pack manifest 的 skill 正文合法地内嵌 sqlite3/Python/markdown 代码片段。判别实证：同字节只改一个必失败字段（version=0.5）仍被连接重置；39KB 假内容可到达应用（400）；2KB 分块扫描 + 前缀二分定位到触发点（`WHERE name='<name>'` 等 SQLi 样例与 Python 片段邻域）；`<script` 等 → 403。链路层与内容均被锁定，合法内容不可改写——「manifest 经浏览器下发」（D8）的假设与边缘安全层冲突，凡含此类内容的 pack 都装不上。根治方案：浏览器只送 `{packId, version}`，manifest 由服务端从市场（facet）取回。

## What Changes

- **cell 安装端点改服务端取包**：`POST /api/mypacks/install` 接受 `{packId, version}`；服务端经既有市场代理通道（facet，`FACET_INTERNAL_TOKEN` + 调用者身份透传）取回该版本 manifest 后再走原有校验/物化管线。请求体不再携带 manifest，SafeLine 无从拦截合法内容。
- **私有包可见性不变量**：服务端取包 SHALL 以调用者身份（x-facet-user 语义）请求，保持 owner-scoped 私有包语义与现状一致。
- **兼容窗口**：请求体仍带 manifest 时照旧处理并同样重校验（滚动期旧客户端兼容）；新客户端（web）改为只送 packId+version。
- **不变项**：installPack 的二次校验、冲突策略、per-part report、升级/卸载语义、MCP 引用解析全部不动——只换 manifest 的来源。
- 不做：SafeLine 规则改动（用户已选根治路线）；skill 正文内容改写（不可接受）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pack-installation`: 新增「manifest 服务端取回」要求——安装端点以 packId+version 从市场服务端取 manifest（调用者身份下评估可见性），客户端 SHALL NOT 被要求传输 manifest；服务端重校验管线保持不变。

## Impact

- **仓**：paas（server/routes/packs.js 安装路由、pack-store 取包衔接、web 设置页客户端、e2e packs 测试）。
- **部署**：平台镜像构建并**三清单同滚**（platform / platform-demo / facet——facet-proxy 模式下部署路由在 facet 进程的既有教训）；无 facet 代码改动。
- **验证**：浏览器复跑真实安装（数据-自助分析：曾因 SQLi 样例 100% 失败；数据-指标工坊：曾因 `<script` 403）应物化为 8/5 个技能且 My Packs 可见；磁盘对账 custom-skills/packs/<packId>/。
- **不受影响**：网关/registry 侧零改动；私有包作者侧语义不变；卸载/升级路径不变。