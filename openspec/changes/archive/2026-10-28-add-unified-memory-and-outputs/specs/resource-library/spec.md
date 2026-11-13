## ADDED Requirements

### Requirement: 存单元行 tier/tags 镜像

资源库/成果存单元行 SHALL 携带 `tier`（draft|stable|canonical，默认 draft 于自动捕获）与 `tags` 的镜像字段，若 fd-memory 未配置可全量置空；真源为 fd-memory reference 页，行存镜像只用于列表与筛选性能，tier/tags 变更以一端（fd-memory reference 页）为写主，镜像行 SHALL 经由受信写面同步而非客户端直改。迁移行在历史存量统一初始化为 draft。

#### Scenario: 列表快速筛 canonical 不背跨服务依赖

- **WHEN** 成果页按 tier=canonical 列出
- **THEN** 走本地镜像列一级查询，无需每行实时问 fd-memory

#### Scenario: 记忆服务不可达时的降级

- **WHEN** fd-memory 未配置
- **THEN** 镜像列保持空零值与既有行读不受影响，成果列出照旧（tier 证章灰态）

### Requirement: 手势写面（记住/钉正典/改 tag）

服务端 SHALL 暴露面向存单元行/资料库条目的记忆手势接口：`记住`（已是记忆的幂等注册 / 未注册则建 reference 页）、`标为正典`（tier 晋级，human 来源）、`改 tag`（增删改并写 correction note）；接口 MUST 以用户身份落 origin 与执行幂等，写真源后同步镜像行，任何 fd-memory 失败以结构化降语答（不写乱态）。

#### Scenario: 成果项上点「标为正典」

- **WHEN** 用户对某 draft 成果按 prompt 手势
- **THEN** reference 页 tier=canonical（human 来源）、行镜像同步，及 AI 发本意入进记忆

### Requirement: save 时自动落 reference 页

成果／资料库入仓（auto capture 或 manual save）SHALL 顺路在 fd-memory 建立对应 reference 页：title/summary（从类型与生成上下文派生）、source_ref 指向该库存行、初始 tier=draft、空 tags交由打标支线；未配置记忆服务时该步静默跳过，不阻塞入仓。

#### Scenario: 手动保存文件即落记忆页

- **WHEN** 用户在对话里点「 存入成果 」
- **THEN** 存单元行入仓且 fd-memory 同步出现 reference 记录待打标
