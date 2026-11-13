# Tasks: add-spider-heal-generate

## 1. 技能内容与 manifest 接线

- [x] 1.1 撰写 `SKILL_GENERATE`（design「技能文本骨架」六步：读单校验/模板起接/实现对齐/golden 纪律/verify 循环 ≤3/`gen/<slug>` PR），接入 `manifest.skills[]` 与 `resources.skills[]`。验证：`buildManifest()` 导出含 4 技能、generate 条目 description 完整
- [x] 1.2 三处小改：PERSONA（kind 分诊句 + 预算句 20→40）、RHYTHM_DO（"按 spider-heal-repair 处理" → "按 kind 分派 repair/generate"）、协议技能补陈旧 working 自愈行（`working` 距 `at` >2×节奏 → 失败回退 retry+1）。验证：文本 diff 自查——分派互斥、预算数字一致、自愈规则语义完整
- [x] 1.3 publish 默认预算改 40（`BUDGET_MINUTES` 缺省值 20→40）。验证：`buildManifest()` 输出 `serving.budget.turnMinutes === 40`

## 2. 部署 v6

- [x] 2.1 `PACK_ID=KkCie7NlrHluo4LiKPnn0w` 重跑 `node scripts/spider-heal-pack.mjs --deploy`（省略 secrets/notify/billing = 保留现绑）。验证：runner 日志 drain 换新 + `(1 MCP, 4 skills)` + QUEUE 回执健康 + 日志确认计费键/2 secret 引用未断
  - 实证（2026-10-04/05）：v6 published+deployed（deploy 面 skills 四件、billingKeyRef `pk_50db3d6e…` 保留）；runner `descriptor changed; draining` → `running on its own billing key (ref pk_50db…)` + `pinned 2 deployment secret(s): gh_actor ws_67acd…, git_pat ws_75617…n0uG` + `cold-starting … (1 MCP, 4 skills)`。脚本顺带小改：`BILLING_KEY` 改为可选（省略=保留现绑，对齐平台生命周期语义）。

## 3. 演练：drill 生成单真回合（design D6）

- [x] 3.1 finddata 侧落盘 `drill-gen-healthz` 生成单（源 = platform healthz，helper 出单）并 commit → 门面 SUBMIT → STATUS 观察。验证：真回合产出 `pr-open`，PR 描述含 health_verify 全绿证据，diff 仅 `spiders/drill-gen-healthz/`
  - 实证：ticket `20261004-drill-gen-healthz-e1e98e04`（helper 出单，github 2cc901e）；门面 SUBMIT（`Idempotency-Key: drill-gen-healthz-try1`）**单回合**完成全流程 → PR #3 开出；diff 仅 5 文件（spider.py/manifest/README/CHECKLIST/golden）；PR 描述逐环证据：verdict ok / golden 重放 diffs [] / 真取数 rows 1 / manifest 50 零违规 / conformance 48 单元 PASS / 密钥扫描 0 命中 / check_manifest_commands 零漂移；golden 只锚 `ok==true`+常量，明确不锚 uptimeMs/cells。
- [x] 3.2 drill 收尾：关 PR + 删分支 + 夹具归档（复用 5.2 演练归档模式）。验证：仓内无残留 `gen/drill-gen-healthz` 分支、归档目录就位
  - 实证：PR #3 closed（附关闭说明）；`gen/drill-gen-healthz` 分支已删；夹具归档 `archive/drill-spider-generate-20261004/`（README+5 文件快照，github/gitee 4242689）。

## 4. 正式验收：nmc-weather（design D7）

- [x] 4.1 finddata 侧 helper 出 nmc-weather 正式单（`--slug nmc-weather`）commit → SUBMIT → STATUS 轮询。验证：`pr-open` + PR 描述 verify 逐项结果全绿 + diff 仅 `spiders/nmc-weather/`（golden 样本在位、断言无日期/波动数值/9999 占位）
  - 实证：ticket `20261004-nmc-weather-23a303a2`（helper 原样参数，github/gitee 3cf11c7）；门面 SUBMIT 单回合 → **PR #4 `gen/nmc-weather` OPEN**（commit 52601f6a，5 文件全在 `spiders/nmc-weather/`）；PR 描述逐环证据：verdict ok / golden 重放 1/1（只锚 `station=Wqsps`/source/url 常量）/ 真取数 5 行 / manifests 0 违规 / conformance PASS 48 units / 密钥扫描干净；9999 缺测统一归一 `None`、带浏览器 UA、未写 schedule/site；inbox `state=pr-open`(retry=0)。
- [x] 4.2 回执留档：回合 meter（时长/预算未撞线）、`fd-ops` 通知到达（ticket_terminal + pr_opened 两类）。验证：relay 审计或会话实证 ≥1 条
  - 实证：meter.jsonl 两条 `kind:"message"` 回合（drill 154935ms / nmc 159045ms，ok；预算 40min 远未撞线）；wanxing_usage 落账 settled（`drill-gen-healthz-try1` / `nmc-weather-try1`，各计 3 分钟）；runner notify 审计 `channel:"fd-ops", outcome:"sent"` ×2（22:15:11Z drill、22:19:53Z nmc，textLen 228/281）——`pr_opened` 已实证；`ticket_terminal` 待人工 merge 后终态时发生（非本次范围）。
- [x] 4.3 人审 merge 与 schedule 点亮：**人工门，不勾不改**——记录在案即可（merge 后 finddata 侧 `health_verify` 复核由使用方执行）
  - 记录（2026-10-05）：**PR #4 已人工 merge**（merge commit `ccd4f3a`，mergedBy scs001，2026-10-04T22:29:33Z）；finddata 侧合并后复核已执行——`006e384`「nmc-weather 人工 merge PR #4 + 合并后复核 verdict=ok → closed」；drill-gen 演练单同 commit 闭环。schedule 点亮（nmc-weather 补 `schedule: hourly`）为**下一个可选人工门**，未执行、由使用方决定。

## 5. 文档收尾

- [x] 5.1 `docs/spider-heal-pack.md` 增生成流章节：工单形态（kind/brief/golden/verify 字段）、预算 40 决定与理由、drill 与 nmc 验收配方、硬边界复述。验证：文档与技能实文一致（分支形态 `gen/<slug>`、循环上限 3、自愈规则）
  - 实证：头部（v6 起 · 第 4 技能）+ 生成流章节 + 验收记录（drill/PR#3、nmc/PR#4、沙箱 scrapling 备注）+ 升级配方（BILLING_KEY 可省、预算 40）——与 `buildManifest()` 实文核对一致。
