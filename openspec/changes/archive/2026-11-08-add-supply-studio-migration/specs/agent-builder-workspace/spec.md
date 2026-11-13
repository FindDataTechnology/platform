## REMOVED Requirements

### Requirement: 工作区是唯一创作面

**Reason**: 创作面整体迁入供给域（W2，roadmap D2）；壹座不再承载文档创作面。
**Migration**: 三栏工作区语义逐字由新能力 `supply-studio`（「Studio 是供给域唯一创作面」）承接；壹座 `/studio` 退役为重定向。

### Requirement: 检查器永远跟随画布选中对象

**Reason**: 同上，随创作面迁入供给域。
**Migration**: 由 `supply-studio` 三栏工作区契约承接。

### Requirement: 文档自动保存与版本冲突处置

**Reason**: 自动保存与乐观锁随文档存储宿主迁谦面侧。
**Migration**: 由 `supply-studio`（「自动保存与版本冲突处置」）承接，语义不变（1.5s 防抖乐观锁、409 双选、以我为准危险确认）。

### Requirement: 生命周期 ribbon 如实镜像服务端状态机

**Reason**: 生命周期状态机随存储宿主迁谦面侧。
**Migration**: 由 `supply-studio`（「生命周期 ribbon 如实镜像服务端状态机」）承接，服务端真状态机纯投影语义不变。

### Requirement: 校验错误可行动（稳定 code + 五语摘要 + 点击定位）

**Reason**: 校验与错误码体系随创作面迁入供给域。
**Migration**: 由 `supply-studio`（「校验错误可行动」）承接，稳定 code + 五语摘要 + 双路径定位语义不变。

### Requirement: 深链契约

**Reason**: 深链改为谦面域下解析；壹座侧 `/studio` 路由退役为重定向。
**Migration**: 由 `supply-studio`（「深链契约」）承接；壹座侧旧深链经重定向透传 query（`?doc=` id 跨迁移稳定）。

### Requirement: 可写团队结构图（设计模式纪律）

**Reason**: 结构图交互随创作面迁入供给域。
**Migration**: 由 `supply-studio`（「可写团队结构图设计模式」）承接，设计模式纪律与回滚锚定语义不变。

### Requirement: 创建入口与空态一次点击

**Reason**: 创建入口随创作面迁入供给域；壹座 `/agents` 构建区随之解体。
**Migration**: 由 `supply-studio`（「Studio 是供给域唯一创作面」空态场景）承接。

### Requirement: 窄屏降级

**Reason**: 随创作面迁入供给域。
**Migration**: 由 `supply-studio`（「Studio 是供给域唯一创作面」窄屏语义）承接。

## MODIFIED Requirements

### Requirement: 铸造到运行的闭环与回链

铸成功的文档 SHALL 提供「部署团队」动作：动作自供给域 Studio 发起，经深链进入壹座承接（装机 `reused` 幂等短路 + from-template 通道出生 paused 带待启动横幅）并落该团队运行面；进入壹座承接 SHALL 需要壹座会话，无会话时如实引导登录/注册（发布不需要、运行需要）。团队详情 SHALL 在产物携带铸造追溯（`_casting.blueprintId`）时呈现「来源蓝图」芯片，链接到供给域 Studio 对应文档（跨域回链）。

#### Scenario: 铸→部署→团队页

- **WHEN** 持壹座会话的创作者在供给域 Studio 完成铸造并点「部署团队」
- **THEN** 深链进入壹座完成装机与 from-template，新团队出生为 paused 且界面落在该团队运行面

#### Scenario: 团队回链来源文档

- **WHEN** 打开一支由蓝图铸造而来的团队详情
- **THEN** 来源芯片可见，点击直达供给域 Studio 对应文档
