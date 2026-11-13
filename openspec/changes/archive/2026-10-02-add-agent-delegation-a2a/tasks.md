# Tasks: add-agent-delegation-a2a

## 1. Ops 前置与调用身份

- [x] 1.1 ops：本机 registry 建 scope `paas-agent-callers`（server_access 仅 `{agent:"*",actions:["invoke_agent"]}`）+ 组映射到 `paas-agent-callers` 组；`/api/export/scopes` 复核只此一条 invoke 规则、组映射在位；步骤落 DEPLOY.md runbook
- [x] 1.2 （方案 A 改道，2026-10-02）原「M2M 惰性开通」实测不可行（IAM provider 缺位）——调用身份=部署级服务凭证，凭证接线与结构化失败并入 3.1 的 a2a-client；scope `paas-agent-callers` 留置待 ③ 凭证加固（ADR-0013 修订在案）

## 2. 契约与工具面

- [x] 2.1 `server/delegation-mcp.js`：delegate target schema 扩 `{type:"a2a",ref}`（persona 校验照旧、自委派守卫只对 persona；a2a ref 创建时校验 catalog 在场）、描述改分类摘要、新增 `search_agents`（关键词→前 8 个在线 a2a 候选）；单测覆盖目标校验与摘要不含全量清单
- [ ] 2.2 `server/routes/delegation.js`：接受 a2a 目标（校验+透传 depth 元数据）；任务卡类型（web/MP）市场徽标 + locales 五语；`npm run typecheck` 过

## 3. 远端执行链

- [x] 3.1 `server/a2a-client.js`：从 streamA2aChat 提出可复用执行器（message/stream、X-Authorization=cell caller、Authorization=后端凭证、`X-Delegation-Depth`、SSE→文本、300s 超时）；streamA2aChat 改调它（行为不变，人聊 depth 不设头）；单测：头组合、SSE 聚合、错误契约
- [x] 3.2 任务引擎执行分支：target.type=a2a → 远端执行（不切 runtime、不占人格槽、串行排队照旧）、输出落任务专属会话、聚合回合零改动兼容；depth 继承（任务元数据→出站头=入站+1）；单测：a2a 任务全链（fake 执行器）+ 无 persona 切换断言

## 4. runner 断环与并发

- [x] 4.1 `agent-runner/a2a.js` + manager：depth≥3 显式 -32011 拒绝（不 spawn）；per-agent 委派并发上限（`AGENT_RUNNER_DELEGATION_MAX` 默认 2，超限排队不失败）；单测：depth 2 过/3 拒、并发排队、上限不挤占服务中回合

## 5. 端到端与验收

- [x] 5.1 e2e：`e2e/delegation-a2a.spec.js` 2/2 绿——委派 stub agent 出站断言（X-Delegation-Depth=1 + 双凭证）、回复落任务会话、search 发现候选、未知 ref 创建即拒、卡片远端徽标；runner 侧 depth≥3 拒绝 + 并发上限在 `test-agent-runner.mjs`（17/17）；全量 fast 套件回归绿
- [x] 5.2 规格/提案回读：agent-delegation-a2a 四要求逐条对照（服务凭证/远端任务/深度头/两级发现，凭证要求已按方案 A 修订）；三 delta 场景对照过；`openspec validate` 通过；单测 692/692；staging 冒烟记 DEPLOY.md（真 runner depth 3 拒绝/2 放行探针，零 LLM 成本）
