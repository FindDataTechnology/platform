## ADDED Requirements

### Requirement: 目录条目按 locale 渲染供给注释

MCP 市场目录条目 SHALL 在条目携带供给注释时按请求 locale 渲染 human 通俗名与一句话说明（解析优先级与 zh 唯一回落沿 `supply-annotation-overlay`）；未注释条目 SHALL 保持现有渲染（上游原文）逐字节不变。目录读取 MUST NOT 因注释投影产生任何源写操作。

#### Scenario: 双语条目按 locale 呈现

- **WHEN** 以 `locale=en` 与 `locale=zh` 分别读取同一台带 zh+en 注释的市场条目
- **THEN** 两请求分别呈现英文名与中文名，描述同规则

#### Scenario: 未注释条目逐字节不变

- **WHEN** 以任意 locale 读取一台无注释的市场条目
- **THEN** 响应显示字段与未引入注释层前逐字节一致
