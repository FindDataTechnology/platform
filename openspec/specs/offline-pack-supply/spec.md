# offline-pack-supply Specification

## Purpose
断网环境下的 pack 供给面：一个可拷、可预置的单文件容器（`.yizpack`），把某
pack 版本的 manifest 快照与它引用的资源本体拦到手边，导入时原样走既有安装
校验管线。它服务的场景是「本地多智能体集群」的气隙供给——导入完成后，
安装态与联网安装完全同构，可被本地集群控制面直接部署。

## Requirements

### Requirement: `.yizpack` 容器格式

bundle SHALL 是单文件 zip 容器，含三部分：`bundle.json`（`formatVersion`、
`packId`、`version`、可选出处字段 `origin`（作者/来源说明）、内容清单
`files[]`（相对路径 + 内容摘要））、`manifest.json`（该版本的 manifest 快照，
字节等于市场返回的同版本 manifest）、`files/`（**可选**的附加资源目录，供未来
manifest 形态引用外部资源时落位）。

关键事实（决定了容器的最小形态）：市场 manifest **内嵌**技能正文
（`skills[].content` 与 `skills[].files`），安装管线直接从 manifest 取用——
因此 v1 的 bundle 只需携带 manifest 快照 + 完整性摘要即可离线安装，
`files/` 保留但不必有内容。

导出与导入两侧 SHALL 对同一 `files[]` 摘要算法（sha256）验真：任一文件对不上
摘要 SHALL 以结构化错误整体拒绝，**不落半包**。

#### Scenario: 摘要不符整体拒绝

- **WHEN** 导入一个被篡改过任意资源文件的 bundle
- **THEN** 返回结构化校验错误（含失配路径），pack 安装态与技能体均无写入

#### Scenario: 最小合法 bundle 可往返

- **WHEN** 导出某已装 pack 版本为 bundle 后，在清态机器导入导入同一文件
- **THEN** 安装结果与联网安装同版本一致（技能体、MCP 引用、bot 单元、agents 声明逐项等同）

### Requirement: 导入端点走同一条校验管线

cell SHALL 提供 `POST /api/mypacks/import-bundle`（标准 cell 鉴权，与安装
同 gate）：解包在受控临时区完成，SHALL 拒绝路径穿越条目与超限体积，随后以
`{packId, version, manifest}` 等价形状调用**既有 installPack**（不新建第二
校验链）。导入成功 SHALL 在安装记录与安装报告上标记来源 `bundle`（与市场
来源可区分、向后兼容：不识别该字段的读面照旧）；失败 SHALL 清理临时区且
不产生部分安装。

#### Scenario: 导入即已安装态

- **WHEN** 用户在断网桌面导入一个合法 bundle
- **THEN** pack 呈已安装态、安装报告列全部物化项，来源标记为 bundle

#### Scenario: 恶意容器被拒

- **WHEN** zip 内含 `../` 路径条目或解压体积超过闸值
- **THEN** 返回结构化拒绝，进程无越界写、无残留临时目录

#### Scenario: 校验失败的语义与联网一致

- **WHEN** bundle 的 manifest 触发既有安装规则（技能冲突、MCP 引用不可解析等）
- **THEN** 报错与同内容联网安装逐字段一致——离线不免检

### Requirement: 付费闸与市场可达性语义

bundle 导入 SHALL 沿用既有市场付费闸语义：市场可达且条目「付费未成交」时
返回既有 402；市场不可达时如实降级（与 `{manifest}` 兼容形状同语义），
SHALL NOT 因离线而虚构购买状态。v1 SHALL NOT 在 bundle 上新增许可证执法
（离线执法属二期）。

#### Scenario: 市场可达时付费条目仍被拦

- **WHEN** 联网机器导入一个付费未购买 pack 的 bundle
- **THEN** 返回既有 `market-purchase-required` 402，无物化

### Requirement: 安装器预置 bundle 目录

桌面安装包 SHALL 在 `resources/bundles/` 下允许预置官方入门 bundle（可为零
个：目录缺失或为空时应用正常运行）。预置 bundle 与用户导入的 bundle SHALL
走完全相同的导入端点语义（同一管线、同一校验），不得存在优先/后门路径。
predist 烘焙 SHALL 幂等（重复构建不叠加、不重复条目）。

#### Scenario: 空目录可运行

- **WHEN** 安装包无任何预置 bundle
- **THEN** 应用正常启动，导入入口只等用户选择文件

#### Scenario: 预置包无后门

- **WHEN** 预置 bundle 被导入
- **THEN** 经历的校验、付费闸降级与出处标记与用户手工导入完全一致

### Requirement: 导出方向（CLI 颗粒）

交付 SHALL 提供一个可脚本化的导出动作：给定已安装的 packId 与版本，收拢
该版本 manifest 快照与全部引用资源本体，产出合规 `.yizpack`。导出 SHALL
NOT 修改安装态；对同一输入重复导出 SHALL 产出摘要一致的 bundle（确定性
打包：条目序与时间戳归一）。

#### Scenario: 重复导出确定性

- **WHEN** 对同一已装版本连续导出两次
- **THEN** 两个 bundle 的文件摘要清单一致（可作为预置烘焙的输入金样）
