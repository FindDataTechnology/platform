## Purpose

团队可以在自己的模具里声明它运行所需的 dsh 插件，但只能引用部署已烘入的 roster；声明在团队实例上落成 profile 补丁行，不构成任何安装通路。缺料要明确失败，生效集合要在团队读面可见。

## ADDED Requirements

### Requirement: pack 可声明插件引用，且只能引用已供给的 bundle

pack manifest SHALL 可选携带 `plugins` 数组，每项 SHALL 为 `{ id, version? }`；`id` SHALL 匹配 `[A-Za-z0-9._-]`，长度 1-64 字符；数组 SHALL 至多 8 项且 SHALL NOT 出现重复 `id`。缺省 `plugins` SHALL 使制品与本次变更前逐字节一致。

`id` SHALL 命中该部署已烘入的 roster；未命中时安装 SHALL 明确失败并列出缺失项，SHALL NOT 静默忽略、SHALL NOT 尝试下载或构建。

`version` 是断言而非选择器：未填时 SHALL 取烘入版本；填写且不等于烘入版本时安装 SHALL 失败并同时给出声明版本与实际版本。声明 SHALL NOT 携带包名、包地址、安装源或任何端点。

#### Scenario: 未供给即失败并列出缺失

- **WHEN** 一份 pack 声明 `plugins: [{ id: "pdf-kit" }]`，而本机 roster 没有 `pdf-kit`
- **THEN** 安装失败，错误列出 `pdf-kit`，且过程内没有任何网络下载或构建

#### Scenario: 版本不符即失败

- **WHEN** 声明 `version: "1.2.0"`，而烘入的是 `1.4.0`
- **THEN** 安装失败，错误同时给出声明版本与烘入版本

#### Scenario: 未声明则零变更

- **WHEN** 一份 pack 不含 `plugins` 字段
- **THEN** 其安装态与运行时行为与本次变更前一致

### Requirement: 声明在团队实例上落成补丁行

由模板落地一支团队时，系统 SHALL 把该 pack 声明的插件写入该团队实例的 profile 补丁层（insert 行），写盘 SHALL 幂等：重复落地、重复启动、并发落地 SHALL NOT 产生重复行。团队归档或删除时 SHALL 移除该团队引入的行；若同一插件被其他仍在册团队声明，行 SHALL 保留。

落地 SHALL NOT 在运行期下载、构建或安装任何包，SHALL NOT 需要网络可达；断网环境下落地 SHALL 与联网时行为一致。

#### Scenario: 幂等落地

- **WHEN** 同一模板连续落地两次
- **THEN** 补丁层里每个插件只有一行，内容与第一次一致

#### Scenario: 断网落地

- **WHEN** 在完全无网络的机器上由模板落地一支声明了插件的团队
- **THEN** 落地成功，过程零网络调用

#### Scenario: 共享与清理

- **WHEN** 团队 A 与团队 B 都声明 `pdf-kit`，随后归档团队 A
- **THEN** `pdf-kit` 的补丁行保留（团队 B 仍在册）；归档团队 B 后才移除

### Requirement: 生效集合在团队读面可见且标出来源

团队读面（驾驶舱与运行台账）SHALL 呈现该团队实际生效的插件集合，并 SHALL 标出每个条目的来源：`team`（由本团队 pack 声明）或 `deployment`（部署默认开启、本团队未声明）。呈现 SHALL 反映实时状态，SHALL NOT 呈现"未供给"的条目为生效。

#### Scenario: 两个来源可区分

- **WHEN** 某团队声明了 `pdf-kit`，而部署默认还开启着 `browser-kit`
- **THEN** 读面显示两条，来源分别为 `team` 与 `deployment`

#### Scenario: 未供给不显示为生效

- **WHEN** 某团队声明了一个 roster 里不存在的 id（历史数据）
- **THEN** 读面显示该条为未供给状态，不计入生效集合

### Requirement: 导出与导入携带声明并在缺料时失败

pack 导出 SHALL 在 manifest 快照中保留 `plugins` 声明。导入到另一部署时，系统 SHALL 对照该部署的 roster 前置校验；任一 id 缺失即 SHALL 失败并列出全部缺失项，SHALL NOT 部分安装、SHALL NOT 丢弃声明后继续。

#### Scenario: 迁移到缺料的部署

- **WHEN** 把一份声明了两个插件、目标部署只烘入其一的 pack 导入
- **THEN** 导入失败，错误列出缺失的那一个，安装态不变
