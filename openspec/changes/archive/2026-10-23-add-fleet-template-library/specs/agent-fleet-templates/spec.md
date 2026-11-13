# agent-fleet-templates Delta: 官方种子库

## ADDED Requirements

### Requirement: 官方种子库守恒

官方舰队模板种子 SHALL 以清单文件随仓分发（种子库目录），每份种子清单 SHALL 全部通过与上架同源的 fleet 段预校验；该守恒 SHALL 由自动化测试钉住——任一官方种子清单变为非法（缺岗位名、组织关系成环、非法 cron、坏 target 等）时测试 SHALL 失败。官方种子铸造上架为市场 pack 后，仓内种子文件 SHALL 仍是该模板的清单真源（再版发布以仓内文件为基准，market 侧不产生第二个编辑入口）。

#### Scenario: 全库过预校验

- **WHEN** 守恒测试遍历种子库目录中的每份官方种子清单并执行 fleet 段预校验
- **THEN** 每份清单全部通过，且自带 agents 与 fleet 段引用的 pack-preset 岗一一对应

#### Scenario: 种子腐烂被抓

- **WHEN** 种子库中任一清单被改成非法形态（如组织关系成环）
- **THEN** 守恒测试以指明具体种子文件与校验错误的方式失败

#### Scenario: 上架与仓内真源一致

- **WHEN** 一份官方种子铸造上架为市场 pack
- **THEN** 所上 pack 的 fleet 段与仓内种子文件的 fleet 段语义一致（铸造占位符补齐除外）
