# agent-fleet-templates Specification Delta

## MODIFIED Requirements

### Requirement: 模板以 pack 形态经市场分发

舰队模板 SHALL 作为 pack 载体经既有市场安装链分发（列表、详情、安装、凭据链
零改动语义）；应用中心 SHALL 提供「舰队」类目入口聚合模板。安装模板 SHALL
不自动启动任何回合（实例化后处于待确认启动态）。**模板供给道 SHALL 扩出离线
bundle 一路：经 `offline-pack-supply` 导入的模板 pack 与市场安装的模板 pack
SHALL 同等地出现在应用中心舰队类目、同等地可被实例化器消费，且实例化降级
规则逐条相同（依赖缺位逐项降级，不因来源不同而分叉）。**

#### Scenario: 市场安装模板

- **WHEN** 用户从市场安装「公司式舰队」模板 pack
- **THEN** 安装链走既有 pack 安装路径成功，应用中心舰队类目可见该模板为已安装

#### Scenario: 安装不自动开跑

- **WHEN** 模板实例化完成
- **THEN** 全部物化任务处于暂停态，驾驶舱提示待主人确认启动

#### Scenario: 离线导入的模板同等可用

- **WHEN** 断网机器经 bundle 导入一个含 fleet 段的模板 pack
- **THEN** 应用中心舰队类目可见该模板，实例化器以与市场来源逐条相同的规则建队与降级

### Requirement: 官方种子库守恒

官方舰队模板种子 SHALL 以清单文件随仓分发（种子库目录），每份种子清单 SHALL
全部通过与上架同源的 fleet 段预校验（含 orchestration 段）；该守恒 SHALL 由
自动化测试钉住——任一官方种子清单变为非法（缺岗位名、组织关系成环、非法
cron、坏 target、编导边引用成员集外岗位）时测试 SHALL 失败。流水线叙事的
官方种子 SHALL 携带与其叙事一致的编导（如内容工厂的 trigger+handoff/dispatch
链）；入站唤醒叙事的种子 SHALL 携带 event 边。官方种子铸造上架为市场 pack
后，仓内种子文件 SHALL 仍是该模板的清单真源（再版发布以仓内文件为基准，
market 侧不产生第二个编辑入口）。**桌面安装包 SHALL 从这些仓内种子真源烘焙
一份入门种子 bundle（`installer-distribution` 的 `resources/bundles/`），
cell 首启 SHALL 把预置 bundle 登记为可导入源——登记 SHALL NOT 等于安装
（安装仍是用户显式动作/引导步内确认）；预置与市场两来源的模板语义 SHALL 一致
（同一份仓内清单真源，无第二编辑入口）。**

#### Scenario: 全库过预校验

- **WHEN** 守恒测试遍历种子库目录中的每份官方种子清单并执行 fleet 段预校验
- **THEN** 每份清单全部通过（含 orchestration 段），且自带 agents 与 fleet 段引用的 pack-preset 岗一一对应

#### Scenario: 种子腐烂被抓

- **WHEN** 种子库中任一清单被改成非法形态（如组织关系成环）
- **THEN** 守恒测试以指明具体种子文件与校验错误的方式失败

#### Scenario: 上架与仓内真源一致

- **WHEN** 一份官方种子铸造上架为市场 pack
- **THEN** 所上 pack 的 fleet 段与仓内种子文件的 fleet 段语义一致（铸造占位符补齐除外）

#### Scenario: 预置登记不等于安装

- **WHEN** 首启完成且安装包含预置入门种子 bundle
- **THEN** cell 登记该 bundle 为可导入源，pack 列表仍为空，直到用户显式确认安装

#### Scenario: 预置种子与仓内真源一致

- **WHEN** 构建期烘焙预置种子 bundle
- **THEN** 其 fleet 段与仓内种子清单真源语义一致，坏包在构建期失败
