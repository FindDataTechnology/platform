## ADDED Requirements

### Requirement: 声明所需 env 的 stdio 服务器在 env 缺失时整体省略

MCP 配置中的 stdio 服务器条目 SHALL 可声明「所需环境变量名单」（env 上界声明）。当该名单中的环境变量在部署环境全部缺失时，组合 MCP patch SHALL 整体省略该服务器条目——不写 patch、不拉起子进程、不进入任何用户的工具面；该省略 MUST 是静默的正常态（非警告级降级，与 envRefs 缺名时的「警告 + 降级运行」语义并存且互不干扰）。名单部分缺失时按既有 envRefs 语义处理（转发已设值、警告缺失项）。省略与恢复 SHALL 仅随部署 env 配置变化生效（重组时重新判定），MUST NOT 需要改库或重装。

#### Scenario: 未配 env 的部署零污染

- **WHEN** 某部署未配置 `CHATWOOT_BASE_URL` / `CHATWOOT_API_TOKEN` 而配置仓中的 chatwoot 条目声明了所需 env 名单
- **THEN** 该部署任一用户的 MCP patch 与工具面均不含 chatwoot 服务器，无子进程拉起，日志无警告刷屏

#### Scenario: 配齐 env 后服务器出现

- **WHEN** 同一部署随后配齐所需 env 并重组（重启或 HMR）
- **THEN** chatwoot 服务器条目出现在 patch 中，子进程带 env 拉起，agent 工具面含其标准子集

#### Scenario: 部分缺失走既有降级语义

- **WHEN** 所需 env 名单只配了一部分（如只有 BASE_URL 没有 TOKEN）
- **THEN** 已设值照常转发，缺失项按 envRefs 既有语义警告，服务器条目不省略（由 server 自身以缺 env 明确报错）
