# pack-bundle-projection Specification

## Purpose
一份 pack 的不可变版本能被投影成多个可交付信封，且三者同源、同边界、同摘要判据：出去的是能力，编排与控制台留在千座。投影是纯函数，漂移由摘要闸而不是人工纪律来拦。

## Requirements

### Requirement: 投影的唯一输入是不可变版本快照

投影 SHALL 以某个 pack 的**已发布不可变版本**（市场返回的同版本 manifest 快照及其内嵌资源）为唯一输入，SHALL NOT 读取安装态、运行时状态或任何本地可变配置。对同一快照重复投影 SHALL 产出摘要一致的产物（确定性：条目顺序归一、时间戳归一、摘要算法一致）。

投影 SHALL 在快照缺字段或引用的资源本体缺失时以结构化错误整体拒绝，SHALL NOT 产出半套信封。

#### Scenario: 同输入两次投影逐摘要一致

- **WHEN** 对同一 pack 版本连续投影两次
- **THEN** 三个信封的内容摘要清单完全相同

#### Scenario: 资源缺失整体拒绝

- **WHEN** 快照引用的某个技能正文在快照内缺失
- **THEN** 投影以结构化错误拒绝并指名缺失项，不产出任何信封

### Requirement: 三个信封的内容边界

投影 SHALL 产出三个信封：`.yizpack` 容器、dsh bundle（npm 包形态）、桌面预置清单。三者 SHALL 由同一份中间表示派生，SHALL NOT 各自实现内容裁剪规则。

出走的信封 SHALL 只含**能力**：技能正文与其附属文件、岗位人设、MCP 的 `registryName` 引用。信封 SHALL NOT 含：舰队编排与派发策略、拍板/委托策略、`console` 声明、任何端点 URL、凭据、平台内部标识或计费键。投影 SHALL 在任何一项出现时拒绝并指名字段路径。

dsh bundle 信封 SHALL 声明其目标运行时兼容范围（`dshCompat`），并 SHALL NOT 携带会接管加载顺序或注入运行时配置的层（不产出可写 profile 根或 patch 层）。桌面预置清单信封 SHALL 只列出 `.yizpack` 文件与其摘要，符合既有"预置包无后门"要求。

#### Scenario: 编排与控制台不外流

- **WHEN** 一份 manifest 同时声明 `fleet`、`console` 与 `agents` / `skills`
- **THEN** 三个信封均不含 `fleet` 与 `console` 内容，且均含技能与人设

#### Scenario: 端点或凭据被拒

- **WHEN** 一份 manifest 的人设里出现 `baseUrl`、`apiKey` 或任何 URL 形态的字段
- **THEN** 投影拒绝并指名该字段路径

#### Scenario: 预置清单只列文件与摘要

- **WHEN** 投影产出桌面预置清单
- **THEN** 清单每项只含文件名与 sha256 摘要，不含技能正文或人设内容

### Requirement: 漂移由摘要闸判定

系统 SHALL 提供投影的校验模式：对仓库内已提交的三封信封重新投影并逐摘要比对，任一不一致 SHALL 以非零退出码失败并点名哪个信封、哪个条目漂移。校验模式 SHALL NOT 写文件。

漂移判据 SHALL 建立在**产物摘要**上，SHALL NOT 依赖清单文本或源路径匹配。

#### Scenario: 篡改一个信封即红

- **WHEN** 手工修改 dsh 信封里的一个技能正文，然后跑校验模式
- **THEN** 校验失败，点名该信封与该技能，退出码非零，且未写任何文件

#### Scenario: 源变更未重新投影即红

- **WHEN** 修改 pack manifest 的能力字段但未重新投影
- **THEN** 校验失败并列出受影响的两个以上信封

#### Scenario: 全量一致则绿

- **WHEN** 三个信封均由当前 manifest 投影产出且无人手改
- **THEN** 校验通过，退出码为 0
