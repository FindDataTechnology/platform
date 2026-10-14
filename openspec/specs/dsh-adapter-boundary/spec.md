# dsh-adapter-boundary Specification

## Purpose
TBD - created by archiving change unify-dsh-generation. Update Purpose after archive.

## Requirements

### Requirement: dsh 包直接引用限于入库评审的适配层名单
仓库 SHALL 维护一份适配层文件名单（入库、随矩阵变更同评审轨迹），CI SHALL 以 lint 强制：任何名单外文件直接 import（ESM `from` 或 CJS `require`）`@deepseek-ai/*` 范围的包即失败并指名文件与包。约束 SHALL 只作用于直接引用——名单外文件 import 平台自有模块（其内部再引用 dsh）不受影响。

#### Scenario: 名单外直接引用被 CI 拒绝
- **WHEN** 一个名单外文件新增 `import { HarnessClient } from "@deepseek-ai/dsh-sdk-client"`
- **THEN** CI lint 失败，报告指名该文件与所引包

#### Scenario: 名单内容即边界事实
- **WHEN** 检视名单文件
- **THEN** 其内容与实际直接引用 `@deepseek-ai/*` 的文件集合一致（现存集合：dsh-bridge.js、dsh-profile-template/ 桥、agent-runner/index.js、scripts/ 探针与合同套件），名单变更与 dsh-matrix 变更同评审轨迹

#### Scenario: 传递引用不受约束
- **WHEN** 名单外文件 import dsh-bridge.js 或 dsh-profile.js 等平台模块
- **THEN** lint 通过——只有直接引用 dsh 包才触界
