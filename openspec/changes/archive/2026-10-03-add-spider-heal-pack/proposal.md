# Proposal: add-spider-heal-pack

## Why

萬星首个真实产品案例（finddata 爬虫自愈闭环的「修复执行体」）：以 pack + serving contract 部署为 a2a Agent Service，双驱动（30 分钟工作节奏自轮询工单目录 + 外部账号经萬星门面立即触发），按工单定向修复 spider 单元并推分支开 PR 供人审。平台侧前置（C1 预算硬停 / C2 部署密钥 / C3 通知 / C4 门面）已全部上线，本 change 只交付 pack 内容、部署与对接契约——**无平台行为变更**，故 skip specs。

## What Changes

- **pack「爬虫自愈修复」**（private，萬星运营号自营）：一个角色 `spider-heal` + 三技能（工单协议与硬约束 / 修复执行流程 / 事件通知），serving contract 携 rhythm（`every 30m` 巡检）与 budget（`turnMinutes: 20`）。
- **发布/部署脚本** `scripts/spider-heal-pack.mjs`：经平台 API 发布 pack 并按 a2a 契约部署（billing key + 可选 secrets（`git_pat` 等）+ notifyChannel 绑定 + budget/rhythm 覆盖），幂等可重跑（升级=重发布新版本+重部署）。
- **对接文档** `docs/spider-heal-pack.md`：finddata 侧契约（SUBMIT/STATUS 协议、git PAT 最小权限清单、secret 名称约定、部署/升级/回滚配方、节奏与外部触发的关系）。
- 硬约束全量进人格与技能（绝不 merge/绝不写 schedule/绝不越界改文件/绝不逆向反爬/脱敏/单写者/验证链全绿才见 PR/重试 ≤1/超限转人工+通知）。

**非目标**：平台能力变更（无）；fd 中央库 MCP 引用（待 finddata 注册 MCP server 后经重部署追加，描述符增量即可）；PR 人审与 merge（finddata 侧）；套餐计费档位（C5）。

## Capabilities

### New Capabilities

（无——纯 pack 内容与部署）

### Modified Capabilities

（无；`skip_specs: true`）

## Impact

- 新增：`scripts/spider-heal-pack.mjs`、`docs/spider-heal-pack.md`；fd-prod 获得一个 private Agent Service 部署（萬星运营号）。
- 依赖既有：C1 预算、C2 密钥通道（`git_pat`/`gh_actor`）、C3 bot_notify、C4 门面调用。
- 外部前置（finddata 侧待办，不阻塞部署）：签发 fine-grained PAT（`contents:write`+`pull_requests:write`）；工单目录与验证链在内容仓的就位。
- 已验证：cheap1 runner 的 GitHub 出海链路可用（github.com/api/ls-remote 实测 200/ok，首连慢但功能正常）。
