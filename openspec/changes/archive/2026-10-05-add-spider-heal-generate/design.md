# Design — add-spider-heal-generate

## Context

spider-heal 的全部内容内嵌于 `scripts/spider-heal-pack.mjs` 的 manifest（persona + 3 技能 + MCP + serving 配置），发布/部署一体（`PACK_ID` 重跑 → 下一版本 → runner 原地 drain）。修复流已上线且 5.2 演练全绿（flash 上完成"读仓约定→合规代码→验证链"闭环）；finddata 侧生成单契约（`source-generation-flow`）12/12 收官，`health_verify` 对 kind=generate **强制 golden 样本**（缺失即红），helper 出单时自动把 `verify.commands` 填成 `health_verify --ticket …`。平台侧不改任何代码。

## Goals / Non-Goals

**Goals:**

- agent 能接 kind=generate 工单：模板起接 → 实现 → golden → verify 循环至 ok → `gen/<slug>` 分支开 PR
- 修复流零回归（分派互斥：kind≠generate 不进生成流程）
- 顺带补上协议状态机的既有缺口（陈旧 working 单永不重拾）

**Non-Goals:**

- 不改平台代码 / runner env / 模型（保持 `deepseek-v4.1-flash`）
- 不改 finddata 侧任何代码（工单契约、verify、helper 都是对方已交付面）
- 人审 merge、schedule 点亮、指标注册——全部人工门，不自动化
- 不做 per-agent 模型差异化（需平台描述符扩展，明确搁置）

## Decisions

### D1 · 预算 20→40min（publish 默认）

greenfield 一回合 = 浅检出 + 模板起接 + 实现取数 + golden 制作 + verify 循环 + 开 PR，实测面 10–25 分钟，20min 硬停撞线概率高（撞线=白跑+转人工）。取 40：修复单同享无实际风险（硬停是兜底非目标，flash 单价可忽略）。persona 预算句同步改为 40。弃选：保持 20（首验收翻车风险实担）；同 pack 双 agent 拆 generate 专属预算（inbox/单写者/门面端点分家，复杂度不值）。

### D2 · 分派点在回合处理，协议面不动

SUBMIT/STATUS/QUEUE、inbox 状态机、单写者规则全部复用——生成单就是一张工单。分派发生在处理期：RHYTHM_DO 文案改为"按工单 kind 走 `spider-heal-repair` 或 `spider-heal-generate`，至多一单"；生成技能第 0 步校验单形（kind=generate 且 category 空且 brief 在，unit 目录已存在 → 终态 manual「非 greenfield」）。弃选：协议层加 kind 感知（无必要的状态面扩张）。

### D3 · verify 循环上限：回合内 ≤3 轮

需求书"反复运行直到 verdict: ok"不设界会空烧预算。回合内 修复→验证 至多 3 轮，仍红 → 终态 manual + note 记失败点。跨回合沿用 retry≤1；workdir 每回合 `mktemp -d`，重试=完全重做（接受：flash 非确定性下重做有翻盘价值，真难的源本就该转人工）。不推 WIP 分支保现场（半成品分支对静默合入纪律是噪音）。

### D4 · golden 断言纪律（技能文本的核心工艺）

断言只锚**跨期稳定物**：结构字段存在性、url、站点名/常量标签；**避开日期与波动数值**（nmc 的温度实况、9999 缺测占位绝不能进断言值）；`whitelist_fields` 收 `scraped_at`/`timestamp`；`min_rows ≥1`；格式照 `spiders/metal-com/golden/001-metal-com.json`（sample_id/created/target/params/expect/whitelist_fields）。样本 ≥1 个，落 `spiders/<slug>/golden/`。

### D5 · 陈旧 working 自愈（协议技能补一行）

巡检开始时：`working` 且 `at` 距今 >2×节奏 → 按失败回退（retry+1，未达上限回 queued / 达上限 manual）。修复流同受益；不补则 D1 的 40min 硬停第一次触发就留下一张卡死的单。

### D6 · 演练先行：drill 生成单真回合

复用 5.2 模式：注入 `drill-gen-healthz`（源 = `platform.finddatatech.cloud/healthz`，稳定 JSON、零反爬）真回合，覆盖全部新代码路径（模板接线、入口命名、golden 制作、verify 循环、PR 机制）。drill PR **不合并**：关 PR + 删分支 + 夹具归档。PASS 后再烧 nmc-weather 正式单。

### D7 · 验收完成线 = pr-open + 证据

drill PASS + nmc-weather 真单 `pr-open`，PR 描述含 verify 全绿证据，diff 仅 `spiders/nmc-weather/`。人审 merge 与后续点亮不挂进完成线（人工节奏不绑自动化验收）。

### 技能文本骨架（spider-heal-generate，实现时的写作基准）

1. **读单**：brief.source_urls/expectations/notes；unit 是新目录（已存在=manual）；D2 单形校验。
2. **起接**：拷 `templates/new-source/`（spider.py/manifest.yaml/CHECKLIST.md）到 `spiders/<slug>/`；入口 `run_<slug_snake>(limit) -> list[dict]`（连字符→下划线），manifest `name`=slug；参考在役单元 manifest functions/columns；交付 README（接入档案：来源/字段口径/坑位处理）。**不写 schedule、不写 site**（走默认执行位；sites.yaml 是执行位登记，nmc 源站无需登记）。
3. **实现**：对齐 expectations；处理 notes 坑位（缺测占位/UA/容错）；只依赖镜像预装依赖（新依赖=发版决策，不加）。
4. **golden**：D4 纪律；样本缺失验证链判红是验收硬条件。
5. **验证**：优先工单 verify 声明命令（先 `--help`/dry-run 探测）；缺省 `python3 scripts/health_verify.py --ticket <path>`；D3 循环上限。
6. **PR**：分支 `gen/<slug>`；commit `gen(<slug>): …`；PR 描述附 verify 逐项结果；`git add spiders/<slug>/` 仅此一处；凭据脱敏纪律照旧。

## Risks / Trade-offs

- **flash 写 greenfield 代码的能力上限**：nmc 是最易源（纯 JSON、无反爬），首验收即压力测试；翻车应对=转人工（协议内建），升级模型需动 runner env（影响全部 children），仅在 nmc 失败后重议。
- **更长回合=更长暴露窗**：部署滚动窗口 503 丢通知纪律在册（重要单避开部署窗口）；硬停残留由 D5 兜底回收。
- **重做成本**：retry=完全重做，最坏烧 2×40min 一单失败——3 轮上限 + manual 终态把下界封住，可接受。
- **契约漂移**：技能文本引用 finddata 侧路径（templates/golden 格式/health_verify 用法）——对方契约已 12/12 定稿且有 spec 看护，漂移面低；PR 描述证据让人审兜底。
