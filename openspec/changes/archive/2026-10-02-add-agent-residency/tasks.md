# Tasks: add-agent-residency

## 1. 契约与校验

- [x] 1.1 `lib/pack-manifest.js` 增 `serving.rhythm` 校验（D2 形状：every≥5m / daily HH:MM + 可选 do ≤2000 字；每条恰含 every|daily 之一；禁区字段拒收），单测覆盖合法两种条目、形状互斥违例、禁区字段、下限违例，`node --test` 绿
- [x] 1.2 draft 编辑器节奏区（PackDraftsView serving 块下：条目增删、两种形状切换、do 文本框 + i18n 五语），合法形状可存可发，`npm run typecheck` 绿

## 2. 部署面（gateway + registry）

- [x] 2.1 `lib/agent-serving.js` descriptor 组装增 `effective_rhythm`（部署请求覆盖优先于 manifest 默认），`gateway/packs.js` deploy 端点接 rhythm 覆盖参数；单测覆盖默认透传与覆盖生效两例
- [x] 2.2 pause/resume 端点（`/api/packs/:id/versions/:v/deployments/:agentId/pause|resume`，deployer/admin 门）+ 平台急停端点（admin 门）——都写 registry 条目 metadata `paused`；核对 registry 客户端 metadata 更新调用形状（design D5 风险项）；单测覆盖门控、幂等、registry 写入
- [x] 2.3 web 部署详情（PackDetailDialog）：生效节奏显示、部署时覆盖入口、暂停/恢复按钮 + 两态；被急停的标注；i18n 五语

## 3. runner 温区与预算

- [x] 3.1 manager 状态机改造：删 idleMs 回收，增 `resident|warm|starting|paused` 四态 + RSS 采样（30s）+ 预算逐出（LRU + 10 分钟防抖 + 120% 硬超）+ 触达热起；health 端点报五态；扩 `scripts/test-agent-runner.mjs`：超预算逐出、热起带上下文、防抖、health 断言，绿
- [x] 3.2 paused 态接线：registry 轮询见 paused → 进 paused（杀进程留态、停调度）；A2A 适配器对 paused 来话回显式错误（不冷启不超时）；resume 后下次事件热起；单测覆盖显式错误与恢复路径

## 4. 节奏调度与自主回合

- [x] 4.1 调度器：due 计算（every/daily 两形状、时区配置）、30s tick、到点经 manager acquire 队列注入（origin=rhythm、prompt=do 或默认）；错过跳过不补跑；单测覆盖 due 触发、无节奏不触发、错过跳过
- [x] 4.2 计量点：每回合 jsonl（agent/kind/tokens/时长/at）落计量文件，tokens 取 adapter usage；单测覆盖三种 kind 各记一条

## 5. 每日滚动与归档

- [x] 5.1 日界滚动：旧会话 digest 自主回合（固定提示 + 512 字上限）→ 纪要落 child 目录 → 旧会话归档至 `AGENT_RUNNER_ARCHIVE_DIR` → 新会话首条注入纪要；温区 agent 热起时补滚、paused 跳过；单测覆盖滚动全链与补滚
- [x] 5.2 归档目标配置与 runbook：默认容器路径、NFS/对象卷挂接说明落 DEPLOY.md（含 RSS 常量复调步骤）

## 6. 端到端与验收

- [x] 6.1 e2e（agent-serving 套件扩展或新 spec）：带节奏部署 → 自主回合可观测；部署覆盖节奏 → 生效值正确；暂停 → 调用方显式错误 → 恢复；超预算 → 温区热起带上下文；playwright 绿
- [x] 6.2 规格回读：agent-residency 五要求逐条过（不回收=manager 无 reap 定时器+测试断言空闲驻留；温区=预算 LRU 逐出/同会话热起/冷却防抖/硬超因子四测；日滚动=digest 回合计量+归档+次日头部注入+温区补滚+paused 跳过；节奏=due 触发/无节奏不触发/覆盖优先/错过跳过重锚；暂停=HTTP 层显式 -32010+恢复+registry 单一事实源）；agent-runner MODIFIED（四场景含新增 Self-turns ride the same queue）、pack-authoring（8 旧场景承载+节奏 2 新场景）、a2a（部署 5 场景含覆盖落 descriptor+暂停 3 场景）对照过；Linux RSS 实测回填 DEPLOY.md（长闲置 4.9MB/96MB 常数维持）；`openspec validate add-agent-residency` 通过；全量单测 685+/playwright fast 349 过：agent-residency 五要求 + agent-runner/pack-authoring/a2a 三 delta 场景逐条对照；`openspec validate add-agent-residency` 通过；Linux host RSS 实测一次回填 DEPLOY.md 常数
