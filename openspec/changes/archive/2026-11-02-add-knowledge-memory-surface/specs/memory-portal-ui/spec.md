# memory-portal-ui Specification (delta)

## ADDED Requirements

### Requirement: 壹座 web 面板以蒸馏漏斗为主视图
壹座 web 记忆面板 SHALL 以蒸馏漏斗为主视图：L0/L1/L2 三层的条数与占比、tier 分布一眼可见，漏斗各段可点入并沿用既有筛选语义（落点=当前列表查询的预置筛选）；晋升提议箱（已在产的 accept/ignore 手势）SHALL 呈现为面板第一区块；条目源跳转沿用现链（跳资料库或成果原位）。漏斗 SHALL 是同一 visibility 读取 API 的展示层——不新增后端枚举面；读取失效时漏斗与列表同走既有解释性降级条款，不空转。

#### Scenario: 漏斗分段可点入
- **WHEN** 用户点击漏斗的 L2 段
- **THEN** 列表落到 layer=L2 的筛选结果，计数与漏斗段一致

#### Scenario: 晋升箱置于第一区块
- **WHEN** 存在待确认晋升提议
- **THEN** 面板首屏先见晋升箱（提议 + accept/ignore 手势），列表区在其下

#### Scenario: 漏斗读取失效同降级
- **WHEN** 记忆服务读取失败（如 memory_unavailable）
- **THEN** 漏斗渲染为解释性降级态（不空转不假数），修正/晋升手势按既有条款置灰并说明

#### Scenario: 分层占比与列表口径一致
- **WHEN** 当前筛选下 L0=30、L1=12、L2=8
- **THEN** 漏斗三段计数为 30/12/8，占比按该口径渲染，切换筛选后两区同步刷新
