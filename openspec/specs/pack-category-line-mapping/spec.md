# pack-category-line-mapping Specification

## Purpose
市场浏览的类目→线归位展示映射：历史散类目（daas/docs/data/authoring/company）在浏览分面上
统合到「线（供给域）」语义呈现，历史 category 值零迁移（展示层映射，存储与 curation 写入不变）；
「分身」类由 badge=facade 承担，不再以类目形式出现在主货架分面。

## Requirements

### Requirement: 类目分面按线归位呈现且历史值零迁移

市场浏览的类目分面 SHALL 以「线（供给域）」为呈现单元：散类目 slug（daas、docs、data、authoring、company 等）SHALL 经一张部署侧可配的映射表归位到对应线词（如 daas→柏讯/wire 供给域、data/dash→数据线、authoring/docs→创作与文档线）。映射 SHALL 只作用于读面展示与分面聚合：manifest 与 packs.db 的 category 值 SHALL 零迁移，curation 写入端点仍收原 slug 语义。同一 pack 因映射归入某线时，其安装、订阅、可见性、徽章 SHALL 全部不变。

未映射类目的「按原样呈现」SHALL 限定于存储、策展读写面与 API 投影语义（零迁移、不猜测归位）；浏览分面 SHALL 只呈现线轴声明的全部取值（恒定的线集合），未映射的散类目 slug SHALL NOT 以自己的 slug 形式进入分面 chip 行，而是落入一个显式的未归类档，在策展面以待办形式暴露。归 null 的类目（分身类）SHALL 继续由类型徽章承担，并同样不进分面。

线标签 SHALL 是多语言的：每条线 SHALL 携带覆盖平台支持的全部界面语言的标签，服务端按请求 locale 投影；未覆盖某 locale 时回落中文主轨。

#### Scenario: 散类目归位到线

- **WHEN** 访客在市场浏览分面查看类目列表
- **THEN** 分面呈现线词（供给域语义），不再出现 daas/company/docs/data/authoring 散词原样作为类目

#### Scenario: 映射是展示层的

- **WHEN** 一个 category=daas 的 pack 被归位展示到线词下
- **THEN** 其存储的 category 值不变，安装/订阅/可见性不变，curation 端点仍按原 slug 读写

#### Scenario: 未映射类目原样呈现

- **WHEN** 出现映射表未覆盖的类目 slug
- **THEN** 该类目按原样呈现（不消失、不猜测归位）——此语义限定于存储、策展读写面与 API 投影
- **AND** 浏览分面上该条目落入未归类档，其 slug 不进入线 chip 行，策展面以待办列出提示补齐归位

#### Scenario: 线集合恒定

- **WHEN** 全部条目都归位到其中两条线，其余三条线没有任何在架内容
- **THEN** 分面仍呈现全部五条线，空线的计数为 0 并以零计数样式呈现

#### Scenario: 线标签随请求语言呈现

- **WHEN** 英文访客请求市场分面
- **THEN** 每条线的 chip 标签为英文文案，不出现中文线词

### Requirement: 分身由徽章承担不以类目进主分面

「分身」类内容（badge=facade）SHALL 由既有的类型徽章承担呈现，SHALL NOT 作为独立类目出现在
主货架分面；其专位呈现（发现页分块等）沿既有 owner 面语义，不因类目归位而变化。

#### Scenario: company 类目不再出现

- **WHEN** 访客查看类目分面
- **THEN** 无 company 类目；分身内容经 badge=facade 识别，在既有专位呈现
