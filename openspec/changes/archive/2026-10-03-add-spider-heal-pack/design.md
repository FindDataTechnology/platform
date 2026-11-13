# Design: add-spider-heal-pack

## Context

平台四件套已上线：C4 门面（外部调用+计费）、C1 预算（`serving.budget.turnMinutes`+硬停）、C2 密钥（deploy 录入→`ws_` 引用→pin 进 child `$DSH_HOME/.credentials.yaml`）、C3 通知（bridge `bot_notify`→部署绑定通道）。pack 清单规则：skills 内联 body≤64KB×10、agents persona-only+serving 契约（禁端点/模型/凭据字段）。发布/部署走平台 API（C2 探针已验证的全链：publish→deploy(billing key+secrets+budgets+notifyChannel)）。

## Goals / Non-Goals

**Goals**：pack 内容（人格+三技能+契约）；幂等发布部署脚本；finddata 对接一页纸；fd-prod 实部署+门面冒烟。

**Non-Goals**：平台代码变更；fd 中央库 MCP（后续重部署追加）；PAT 实值（finddata 签发后经重部署绑定，生命周期省略=保留）。

## Decisions

- **D1 角色与契约**：单角色 `spider-heal`；`serving.protocol: a2a`；rhythm `every "30m"` + do「巡检 `reports/health-tickets/`：无新单则一句话收工，有则按修复技能处理一单」；budget `turnMinutes: 20`（C1 硬停兜底）。card 字段由名字/描述派生（不带手动卡）。
- **D2 三技能分工**：
  - `spider-heal-protocol`：对外文本协议（`SUBMIT <repo> <ticket-path>` / `STATUS <id>` / `QUEUE`）+ inbox 状态文件约定（`$DSH_HOME/spider-heal/inbox.json`：已见工单/已开 PR/重试次数/终态）+ 硬约束重申。
  - `spider-heal-repair`：执行流程——浅检出（`--depth 1 --single-branch`）目标单元+工单、读工单五类分诊、定向修复（仅目标单元文件）、验证链（工单声明的 verify 命令优先，缺则基线：yaml/manifest 校验+可运行 dry-run）、commit（bot 身份 `spider-heal-bot`）、push 分支 `heal/<date>-<slug>`、**curl 开 PR**（无 gh CLI；`POST /repos/{o}/{r}/pulls`，token 从 `$DSH_HOME/.credentials.yaml` 的 `git_pat` ref 读、全程不回显）、单写者检查（该源已有未合并 heal PR→新单只排队）、重试 ≤1。
  - `spider-heal-notify`：四类事件→`bot_notify`（工单终态/PR 开出/总闸变更/超限转人工），event 命名与文案模板；未绑定通道→结构化拒绝按提示降级（记录终态、不重试）。
- **D3 凭据读取**：child env 被洗刷、凭据文件是唯一通道（C2 设计）——技能指示 bash 从 `$DSH_HOME/.credentials.yaml` 提取 `git_pat`（yaml 单行 grep+cut，值不落日志/回显，URL 内联即焚）；PAT 缺失→该工单终态=「转人工（凭据未配置）」+通知。
- **D4 发布脚本** `scripts/spider-heal-pack.mjs`：`PLATFORM_URL + PROBE_TOKEN`（creators JWT）→ publish（新版本）；`--deploy` 时带 `BILLING_KEY`（sk-…）+ 可选 `SECRET_GIT_PAT`/`SECRET_GH_ACTOR`/`NOTIFY_CHANNEL`/`BUDGET_MINUTES`/`RHYTHM_EVERY` → deploy 路由。退出码即结果；升级=再跑（版本+1 自动）。
- **D5 部署形态**：private visibility + 调用者允许清单（finddata 账号加入时经 `POST /api/packs/:id/deployments/spider-heal/callers`）；day-one 无 PAT 也部署（技能优雅降级），finddata 交付后重部署绑 secret。
- **D6 冒烟**：门面 `SUBMIT` 一条假工单路径→回执「已入队（凭据未配置→转人工）」；`STATUS` 查询同单去重；rhythm 自回合的 burn-in 看 `meter.jsonl` kind=self。

## Risks / Open Items

- **PAT 最小权限**（finddata 签发）：fine-grained、仅目标内容仓、`contents:write`+`pull_requests:write`、无 admin；actor 邮箱用于 commit 身份（`gh_actor` secret，可选）。
- GitHub 首连慢（~12s TLS）——浅检出+20m 预算内充裕；若后续恶化再议镜像（gitee）。
- 工单 YAML 的 verify 命令由 finddata 侧声明——技能对未知命令一律先 `--help`/dry-run 探测，失败即转人工，不盲跑。
