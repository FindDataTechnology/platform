# agent-builder-workspace Specification

## Purpose
壹座智能体构建器工作区：把智能体文档与团队文档的创作收敛为「一个文档、一条生命周期、一次到运行的闭环」——三栏（文档库 / 画布 / 上下文跟随检查器）的统一创作面，并经既有闸位与发行通道闭环到运行中的团队。

## Requirements

### Requirement: 铸造到运行的闭环与回链

铸成功的文档 SHALL 提供「部署团队」动作：动作自供给域 Studio 发起，经深链进入壹座承接（装机 `reused` 幂等短路 + from-template 通道出生 paused 带待启动横幅）并落该团队运行面；进入壹座承接 SHALL 需要壹座会话，无会话时如实引导登录/注册（发布不需要、运行需要）。团队详情 SHALL 在产物携带铸造追溯（`_casting.blueprintId`）时呈现「来源蓝图」芯片，链接到供给域 Studio 对应文档（跨域回链）。

#### Scenario: 铸→部署→团队页

- **WHEN** 持壹座会话的创作者在供给域 Studio 完成铸造并点「部署团队」
- **THEN** 深链进入壹座完成装机与 from-template，新团队出生为 paused 且界面落在该团队运行面

#### Scenario: 团队回链来源文档

- **WHEN** 打开一支由蓝图铸造而来的团队详情
- **THEN** 来源芯片可见，点击直达供给域 Studio 对应文档
