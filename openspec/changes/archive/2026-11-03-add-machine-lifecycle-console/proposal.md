## Why

2026-11-02 生产走查把「机器页」定为**产品定义缺口**（走查缺陷②，按约定挂账）：用户在自己机器的唯一管理面上，做不全一台机器的生命周期——配对与解绑都只在「设置→已配对设备」里，两个面互不引用；机器页空态只说「还没有配对的机器」不指路；详情抽屉没有解绑出口；「我改了期望，机器到底收没收到」没有任何呈现（机器其实每拍都回报 `merge.desiredVersionSeen`，数据在、页面丢了）；名册卡上 `presence.os/appVersion/boundAt` 全部取到前端却一处未渲染，与公开教程「名称、状态徽标、系统信息、摘要」的承诺漂移；store 只留覆盖式最新快照，**历史一条不存在**。用户要的是「一个我自己的机器，从配对、看状态、改期望、看收敛、到解绑，一站闭环」——现在这站是散的。

## What Changes

- **机器页（/machines）升格为机器生命周期唯一门面**（用户裁定 A）：
  - **配对入口**：空态主按钮 + 页头「添加机器」→ 配对向导（复用既有铸码池，6 位码 + QR + 5 分钟倒计时 + 刷新；铸码成功转「等待机器首次报到（约 1 分钟）」轮询名册，新行出现即收场）。
  - **名册卡补齐**：渲染 OS/appVersion/配对时刻；详情抽屉标题用 label（回退 deviceId），补身份行。
  - **解绑出口**：详情抽屉危险区「解除绑定」（两步确认）；撤销绑定同时清云端期望（防同 deviceId 重配继承旧期望），历史保留 30 天自然过期。
  - **收敛指示器**（替代「唤醒」按钮）：`desired.version` vs 机器回报的 `merge.desiredVersionSeen` 四态呈现——已同步／收敛中（下一拍来取，≤60 秒）／待取令（沉默，上线后自动生效）／背离。沉默机器不给假动作，给诊断指路。
  - **机器历史**：每机有界元数据事件环（上下线翻转、期望变更审计、收敛结局），仅在翻转时 write-through；`GET /api/machines/:id/history`；抽屉内时间线。
- **设置→已配对设备** 只留手机/小程序类设备（`kind!=="steward"`）；steward 行整体迁到机器页（撤销端点复用 `/api/app/bind/:deviceId`）。
- **文档对齐**：`docs/deploy-and-manage-your-machine.md` 配对路径改「机器页→添加机器」、解绑入口改抽屉、补历史一节；扫码步骤按桌面实面核实后订正。
- **明确不做（本 change 范围排除）**：拉取侧「立即取令」nudge（P2 缓拍——省的是 ≤60 秒随机相位，不值得本版动桌面管家命脉）；任何平台发起连接的控制通道（教义不变）。

## Capabilities

### New Capabilities

（无——本 change 全部是既有能力的规格演进。）

### Modified Capabilities

- `fleet-machine-console`: 名册聚合补卡面元数据呈现；新增「机器配对入口」「机器解绑出口」「收敛指示器」「机器历史」四项需求；「明确不做」边界补一个防漂移场景（收敛/历史/nudge 只读机器发起的请求，平台永不发起连接）。
- `device-pairing-auth`: 设备管理面按 kind 分家——steward 设备的列表与撤销面迁至机器页，设置页保留 app 类设备；撤销语义（持久删除、下次静默登录 401）不变。

## Impact

- 代码：`web/src/pages/MachinesPage.tsx`（重构）、`web/src/components/settings/DevicesSection.tsx`（过滤 steward 行）、`gateway/fleet-machines-store.js`（历史环+nudge 预留字段+撤销清理）、`gateway/fleet-machines-routes.js`（history 端点+DELETE 包装）、五语 locales。
- API：新增 `GET /api/machines/:id/history`、`DELETE /api/machines/:deviceId`（包装撤销+清期望）；复用 `/api/mp/bindcode`、`/api/app/bind/:deviceId`、`/api/machines`（含 desiredVersionSeen 已在 detail 内）。
- 文档：`docs/deploy-and-manage-your-machine.md`。
- 无新增依赖；存储仍为既有 JSON 文件店（有界环，不引数据库）。
