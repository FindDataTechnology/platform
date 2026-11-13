# installer-distribution Specification Delta

## ADDED Requirements

### Requirement: 安装包预置入门 bundle

桌面安装包 SHALL 支持在 `resources/bundles/` 预置官方入门 bundle（`.yizpack`
文件），由 predist 烘焙阶段从仓库内受控清单收纳；烘焙 SHALL 幂等（同一源
重复构建产出相同集合，不叠加）。预置目录 SHALL 允许为空或缺失（应用照常
运行，导入路径只等用户选文件）。预置 bundle 的合法性与可导入性 SHALL 由构建
期校验兜住（对每个预置文件跑一次 bundle 元信息与摘要校验），坏包 SHALL 在
构建期失败而非留到用户机器上暴露。

#### Scenario: 烘焙幂等

- **WHEN** 同一提交连续两次执行 predist
- **THEN** `resources/bundles/` 的文件集合与内容摘要一致，无重复条目

#### Scenario: 坏包构建期拦下

- **WHEN** 受控清单指向的 bundle 摘要失配或元信息损坏
- **THEN** predist 失败并指名该文件，不产出安装包

#### Scenario: 空预置目录照常出包

- **WHEN** 受控清单为空
- **THEN** 安装包不含 `resources/bundles/`，构建与安装流程零变化
