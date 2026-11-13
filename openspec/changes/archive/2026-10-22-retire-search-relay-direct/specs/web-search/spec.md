## MODIFIED Requirements

### Requirement: 共享搜索供给由平台网关车道承担

relay 的共享池 SHALL 经平台网关的 websearch 车道（词元）服务：relay 持一枚
内部专用车道凭据（自有分组、websearch 价目为零、用量入账），供应商 key
（SerpAPI 及后继）SHALL 只维护在词元账号池——relay 的 keys 集合 SHALL NOT
再作为常设供给源。**退役段（本 change）：直连路径与对应 keys SHALL 删除**，
keys 配置只保留车道凭据；共享池回退链 SHALL 不再含直连分支。调用者可见契约
（请求/响应形状、鉴权、来源三态标注）SHALL 全程不变；车道不可用且调用者未带
BYOK key 时，搜索工具 SHALL 返回调用者可见的明确错误（不再是静默的直连回退）。

#### Scenario: 共享池请求走车道

- **WHEN** 调用者不带用户 key 请求 relay 搜索且车道可达
- **THEN** 请求由词元 websearch 车道服务（relay 以内部凭据调用），返回形状与来源标注（pool）与切换前一致

#### Scenario: 退役后 keys 配置只含车道凭据

- **WHEN** 退役段实施后检查 relay 配置
- **THEN** keys.json 只含词元车道凭据，`serpapi[]` 键不复存在，relay 启动日志不再出现 standby serpapi 行

#### Scenario: 车道不可达冷备接管

- **WHEN** 冷备路径与 `serpapi[]` 已删除后，词元车道不可达或持续 5xx
- **THEN** 直连冷备路径不复存在（无配置可启用）；调用者在无 BYOK key 时得到明确的错误消息，relay 统计不再含冷备路由

#### Scenario: 供应商 key 不再常设 relay 侧

- **WHEN** 迁移窗口结束（冷备路径退役后）检查 relay 配置
- **THEN** relay 的 keys 集合中 SHALL 不存在供应商 key，供给唯一来源为车道内部凭据

### Requirement: Shared pool health is visible to administrators

「网络搜索」分区 SHALL 为管理员展示共享池健康。池的供给上游为平台网关
websearch 车道时，健康面 SHALL 以车道为主视图：上游模式（车道）、车道可达性、
车道侧错误计数与当日用量/上限；**退役段（本 change）：冷备直连路径删除后
SHALL 不再展示冷备启用计数与 per-key 冷却视图**（该状态由词元管理面承担）。
数据经服务端以生效凭据代理 relay 只读统计端点，SHALL NOT 暴露任何 key、令牌
或车道凭据值。

#### Scenario: 管理员看到池状态

- **WHEN** 管理员打开分区
- **THEN** SHALL 看到上游模式（车道）、车道可达性、错误计数、当日用量与上限

#### Scenario: 非管理员看不到管理区

- **WHEN** 非管理员用户打开分区
- **THEN** SHALL 只看到自己的密钥区；共享服务配置与池状态 SHALL 不渲染，且相应端点 SHALL 对其返回 403

#### Scenario: keys 段隐藏

- **WHEN** 退役实施后打开网络搜索设置面板
- **THEN** 冷备 key 列表与冷却状态视图不再渲染，BYOK 配置区照常
