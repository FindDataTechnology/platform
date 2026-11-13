# 爬虫自愈修复 Agent · finddata 对接一页纸

> pack：`KkCie7NlrHluo4LiKPnn0w`（private，萬星运营号自营）· agent：`spider-heal` ·
> 部署：fd-prod（runner cheap1）· 变更：add-spider-heal-pack（v1–v5）→ add-spider-heal-generate（**v6 起，+生成流**）· 2026-10-03 / 2026-10-05

## 调用（经萬星门面）

鉴权/幂等/计费规则见 `docs/wanxing-serving-api.md`；本 agent 的消息协议（工单约定）：

```
POST https://platform.finddatatech.cloud/api/wanxing/v1/a2a/packs-kkcie7nlrhluo4likpnn0w-spider-heal
Authorization: Bearer sk-…（finddata 调用键，需运营加入允许清单）

SUBMIT FindDataTechnology/fd-industry-data reports/health-tickets/<date>-<src>-<id>.yaml
STATUS reports/health-tickets/<…>.yaml
QUEUE
```

- SUBMIT 秒级回执（入队/已见过/拒绝三态）；重复路径只回执不动手（agent 侧 inbox 去重 + 门面 Idempotency-Key 双层）。
- STATUS 读 agent 落盘状态（queued/working/pr-open/done/manual + note + prUrl）。
- 节奏：agent 每 30 分钟自巡检队列处理一单；外部 SUBMIT 立即入队（下次巡检或后续触发处理）。回合预算 20 分钟（超限平台硬停+转人工语义）。

## 工单 YAML 期望字段（finddata 侧产出）

- 分诊类别（network/structure/contract/source-dead/fallback）+ 诊断备注 + 目标单元 `spiders/<slug>/`
- **verify**：声明的验证链命令（平台技能会先 `--help`/dry-run 探测再实跑；缺省走基线校验）
- golden/口径文件路径（契约类工单时点名）

## 生成流（kind=generate，v6 起 · 第 4 技能 `spider-heal-generate`）

按 finddata 生成单**从零新建**爬虫单元（greenfield），与修复流共用同一套工单/验证/PR/人工门。工单契约见 fd-industry-data `docs/health-loop.md`「生成流」与 `openspec/changes/source-generation-flow`；agent 侧要点：

- **分诊互斥**：`kind=generate` → 生成技能；缺省/`repair` → 修复技能。生成单 `category` 必空、`brief{source_urls/expectations/cadence?/notes?}` 必备；`unit` 允许尚不存在（**仓内已存在 = 转人工**，非 greenfield）。
- **流程**：模板起接（`templates/new-source/` → `spider.py/manifest.yaml/README/CHECKLIST`）→ 入口 `run_<slug_snake>(limit) -> list[dict]` 且 manifest `functions[].command` 同名 → 实现取数对齐 `expectations`/处理 `notes` 坑位 → **交付 ≥1 个 golden 样本**（断言跨期稳定：只锚结构字段/url/站点名/常量标签；**绝不锚日期或波动数值**、缺测占位不进断言；缺样本验证链判红——验收硬条件）→ 按工单 `verify.commands` 跑 `health_verify` 至 `verdict: ok`（**回合内 ≤3 轮**，仍红转人工）→ 分支 `gen/<slug>` 开 PR（描述附逐环证据）。
- **硬边界**：不写 `schedule`（静默合入）、不点亮、不 merge；改动仅限 `spiders/<slug>/`；不逆向反爬；验证全绿才见 PR。
- **回合预算 40 分钟**（v6 起；greenfield 回合面宽于修复，硬停=兜底）。陈旧 `working` 单由协议自愈规则回收（距 `at` >2×节奏 → 按失败回退 retry+1）。

### 生成流验收记录

- **2026-10-04/05 · drill 演练（全链通过）**：夹具 `drill-gen-healthz`（源=平台 healthz，纯 JSON）→ 门面 SUBMIT **单回合**完成全流程 → PR #3（diff 仅 5 文件、golden 只锚 `ok==true` 与常量、验证链逐环绿：verdict ok / conformance PASS / 密钥扫描零命中）→ 按计划**关闭不合并**、分支删除、夹具归档 fd-industry-data `archive/drill-spider-generate-20261004/`。
- **2026-10-05 · 首个正式生成单 `nmc-weather`（全链通过+点亮）**：helper 出单（`20261004-nmc-weather-23a303a2`）→ 门面 SUBMIT **单回合 159s** 完成 → PR #4 `gen/nmc-weather`（diff 仅 5 文件；9999 缺测归一 `None`、浏览器 UA；golden 只锚 `station=Wqsps`/source/url 常量；真取数 5 行；verdict ok / conformance PASS / 密钥扫描干净）→ inbox `pr-open`，`fd-ops` 通知 `sent`（runner notify 审计）；回合账 settled（3 分钟）。**人审 merge 完成（`ccd4f3a`）+ 合并后复核 verdict=ok；点亮已完成（2026-10-05）**：manifest `schedule: "27 * * * *"`（`fef15d9`，**首个 hourly 源**）→ AppSet（git 源=gitee）~3 分钟渲染 ArgoCD app+CronJob（Synced/Healthy）→ 立即试跑 `fd-runner: nmc-weather -> success rows=100 in 35.7s` → dispatcher 清单同步 50 源。
- 运营备注：agent 沙箱缺 `scrapling/lxml`（存量单元 IMPORT_FAIL 属环境噪声）；生成单元优先标准库实现可保验证链在沙箱内全绿，生产运行镜像依赖不变。TLS 中间代理环境需 `SSL_CERT_FILE`（仅沙箱，单元代码走默认证书路径）。

## git 凭据（finddata 待办 ① —— ✅ 已绑定 2026-10-03）

**PAT 已绑定**：运营经 v2 重部署入库（secret 名固定 `git_pat`，平台侧仅存 `ws_` 引用，
全链日志至多尾四位；child 凭据文件 `/data/packs-KkCie…-spider-heal/.credentials.yaml`
中 `git_pat` + `gh_actor=56543689+scs001@users.noreply.github.com` 已就位）。
轮换 / 换仓同下配方：

```bash
PACK_ID=KkCie7NlrHluo4LiKPnn0w \
SECRET_GIT_PAT=<PAT> SECRET_GH_ACTOR=<email> \
NOTIFY_CHANNEL=<通道> BILLING_KEY=<运营键> \
PLATFORM_URL=… TOKEN=<运营 JWT> node scripts/spider-heal-pack.mjs --deploy
```

（省略某 secret = 保留现绑；PAT 缺失时所有工单按协议终态「转人工（凭据未配置）」。）

## 通知（四类事件）

工单终态 / PR 开出 / 总闸变更 / 超限转人工 → 部署绑定的通道（当前 **`fd-ops`**，
2026-10-04 换绑完成；旧 `test-channel` 保留为备用绑定）。事件文案模板见技能 `spider-heal-notify`。

> **bot 命名备注（2026-10-04 实测）**：微信里实际在用的公众号（使用方称 qinfa）在平台里登记的
> bot 名是 `test`（appId `wx655b465a5f91bff1`）；平台里另一个叫 `qinfa` 的 bot
> （appId `wx29831ffdb4796ab1`）是另一只**未被使用**的号。`fd-ops` 通道绑在 `test` 号上——
> 排障时别被名字带偏。

## 部署 / 升级 / 回滚（运营配方）

- 升级：改 `scripts/spider-heal-pack.mjs` 内的 manifest 内容 → 带 `PACK_ID` 重跑（自动下一版本）→ runner 原地 drain 换新。v6 起：`BILLING_KEY` 可省略（**省略=保留现绑**，平台侧走 kept-key 探活路径）；缺省预算 40min（`BUDGET_MINUTES` 可覆盖）。
- 回滚：`POST /api/packs/KkCie7NlrHluo4LiKPnn0w/versions/<旧版本>/deploy`。
- 暂停/恢复：`POST /api/packs/KkCie7NlrHluo4LiKPnn0w/deployments/spider-heal/pause|resume`。

## finddata 侧待办清单

1. ~~签发 PAT 并交付运营绑定~~ ✅ 2026-10-03（v2 部署绑定，见上节）。
2. 内容仓 `reports/health-tickets/` 工单流就位（五类分诊+verify 声明）。
3. （可选）中央库限流/总闸注册为 MCP server → 运营重部署追加 `mcpServers` 引用（总闸变更通知才生效）。
4. 首批真实工单试运行：SUBMIT → 观察 STATUS/pr-open → 人审 merge。

## 已验证（2026-10-03）

GitHub 出海（cheap1：github.com/api/ls-remote 200/ok）· 发布+部署+起服（:8799）·
门面 SUBMIT（凭据缺失→按协议终态 manual+结构化回执）· 重放去重 · STATUS 跨回合读盘 ·
允许清单放行。rhythm 自回合 burn-in 见 runner `meter.jsonl`（kind=self，部署后 ≤30m 首巡）。

### v2 实跑（2026-10-03 晚，绑定 PAT 后）

- v2 发布+部署（secretRefs：`git_pat`/`gh_actor`；notify `test-channel`）；runner 原地 drain
  换新 child，日志实证「running on its own billing key (pk_e19083b4…)」+「pinned 2
  deployment secret(s)」，旧计费键引用未断。
- 门面合成工单实跑：`SUBMIT FindDataTechnology/fd-industry-data reports/health-tickets/<不存在>.yaml`
  → 真回合 110s（外部上下文 `wx:`，按调用键结算 2 分钟、已 settled）→ 终态 `manual`（工单不可读，
  四路核实 0 命中）→ 同 `Idempotency-Key` 重放返回首答、无第二回合/第二笔账（重放语义实证）。
- 注意：**平台滚动窗口内 `bot_notify` 会 503（单次纪律=不重试，通知即丢）**——本单终态通知恰逢
  pod 滚动未送达，rolling 结束后直发 relay 复测 `{ok:true}`。重要工单建议避开部署窗口。
- 另：该仓当前没有 `reports/health-tickets/` 树（四路核实），真实工单流就位后即可试跑。

## 运营侧四项处理（2026-10-04，使用方提出）

### ① 通知通道从 test-channel 换正式 —— ✅ 完成（2026-10-04）

- **通道 `fd-ops`** 已绑定 =（平台 bot `test`（=微信里的 qinfa 号），chat `oi_bc3J…`）——即使用方
  实际在用的那个微信会话；`POST /api/bots/channels` 一次建绑定。
- **重部署 v4**：`NOTIFY_CHANNEL=fd-ops`（计费键/密钥保留）；runner 日志确认
  「descriptor changed; draining old child for in-place upgrade」。
- **送达实证**：relay 审计 `fd-ops | sent | 73 chars`（05:46Z 验证消息已进微信会话）。
- `test-channel` 保留未删（同会话的备用绑名；要清时说一声即可）。

### ② 限流/总闸注册为 MCP server + 重部署 —— ✅ 完成（2026-10-04，含全链实证）

- **坐标**（使用方 2026-10-04 交付）：中央库 `fd_open_data.public.health_config`（key/value
  jsonb 六键 + updated_at）；只读账号 `fd_health_ro`（mesh `100.64.0.3:30432`，DSN 经安全渠道，不进 git）。
- **萬星侧落地**：只读 MCP shim `servers/fd-health-mcp/`（单文件 Node + pg，Streamable HTTP）→
  部署于 cheap1（容器 `fd-health-mcp`，`/opt/fd-health-mcp`，compose 网络 + tailnet `:8090`）→
  registry 注册条目 `fd-health-config`（上游 `http://100.64.0.11:8090`）→ pack **v3** 追加
  `mcpServers: ["fd-health-config"]` 并重部署（计费键/密钥/通道全保留）。
- **全链实证**：公网 `mcp.finddatatech.cloud/fd-health-config/mcp` 三流程
  （initialize/tools/list/tools/call）实测通过、返回真库值；runner 日志
  `cold-starting … (1 MCP, 3 skills)`；shim 日志见子进程握手 + **真回合内
  `tools/call:health_config_get`**。
- **技能升级**：`spider-heal-notify` 增「总闸核对」流程——每巡检 `health_config_get` 对比
  `$DSH_HOME/spider-heal/gate-state.json`，键值变化发一条 gate_change，首次只落盘；MCP 不可达
  记一句不重试。rhythm 巡检文案同步（v3 起生效）。
- 运维配方（重建/轮换/注册侧三坑）见 `servers/fd-health-mcp/README.md`。

### ③ runner 默认模型 / 计费核验 —— ✅ 完成（证据在案）

- **模型**：现役 runner（cheap1 `agent-runner-dsh`）默认 `AGENT_RUNNER_MODEL=deepseek-v4.1-flash`；
  child 的 finddata 路由（settings.yaml，baseURL `token.finddatatech.cloud/v1`）列 8 个模型、活跃即
  flash；sub2api 侧该部署键 **183 条用量记录全部为 `deepseek-v4.1-flash`**。
- **计费**：部署键 = sub2api **key id 31**（组 `openrouter`，属 user 1 万星运营号）；逐请求记账
  （in 1,155,054 / out 70,594 tokens；样例 `total_cost $0.00022383`），最新一条在查询前 16 分钟
  （rhythm 自回合持续消耗）——**部署键实付、门面调用键结算为两本独立账，双向均实证**。
- 如需改默认模型：runner env `AGENT_RUNNER_MODEL`（影响该 runner 全部 children）；per-agent 差异化
  需走描述符扩展（提需求）。

### ④ git PAT 权限范围 —— ✅ 已轮换为窄授权（2026-10-04；旧 PAT 吊销 2026-10-11）

- **新 PAT**（身份 `FindDataOfficial` id 295187081 = finddata 运营官方账号），finddata 侧独立核验：
  目标仓 Contents 写 ✅（probe 分支+提交）、PR 写 ✅（草稿 PR #2）、**非目标仓全拒 403**
  （fd-cn-report/platform/fd-daas-mcp/fd-vertical-packs）、私有仓不可见（404）——窄授权坐实；
  探针物已清（PR 关、分支删）。早前「可见 12 仓」疑点已排除：都是公开仓，读可见 ≠ 授权。
- **萬星侧轮换已执行**（v5 重部署）：`secretRefs` 换新（git_pat → `ws_756…`、
  gh_actor → `ws_67acd…`）+ **gh_actor 同步换为官方账号**（`295187081+FindDataOfficial@…`，
  避免署名与推送者不一致）；runner 日志实证「pinned 2 deployment secret(s) … git_pat ws_75617…n0uG」
  （新尾四位）+ 新 child 起服 + QUEUE 验收健康。
- **旧 PAT 吊销 ✅ 完成（2026-10-11）**：旧 token 实名 **`spider-heal-agent`**（token id 20545960，
  2026-10-03 创建、11-02 到期、10-04 轮换后停用）——**在 FindDataOfficial 账号下**（非 scs001；
  旧文档「scs001 宽 PAT」是把提交署名 gh_actor 与 token 归属搞混）。GitHub 安全日志实锤
  `personal_access_token.destroy / access_revoked`；账号内现仅剩 `fd-industry-data` 一把。
- **到期风险处置 ✅（2026-10-11）**：`fd-industry-data` 原定 2026-11-03 到期（静默失效风险）→
  经 Regenerate 选 366 天，新到期 **2027-10-12**；新值核验（身份/目标仓 200/非目标仓写 403/
  私有仓 404）后 v8 重部署（`git_pat ws_b8c21…VFRl`），runner drain→cold-start 实证。
  ⚠️ **Regenerate 是值轮换**（旧值即刻失效）——必须紧跟重部署压窗口。
- **泄露轮换 ✅（2026-10-12，两次连做）**：agent 自报脱敏事故——它用 `sed` 处理
  `$DSH_HOME/.credentials.yaml` 时，`git_pat` 是**块标量**（`git_pat: >-`，值在下一行），
  单行 grep+sed 取到空串后 agent 改看原文，**完整值落入会话日志**（未进回复/PR/通知/仓内文件；
  finddata 侧 grep 复核仓内零命中）。当日两次 Regenerate + v9/v10 重部署：
  - 轮换 #1（v9）：`git_pat ws_ff3b8…yVgv`；轮换 #2（v10）：`git_pat ws_a6f56…7zNX`（在用）。
  - 窄授权每次复验：身份 FindDataOfficial ✅ / 目标仓写 201 ✅ / 非目标仓写 403 ✅ / 私有仓 404 ✅。
  - 取证：runner 会话轨迹（`/tmp/prior.jsonl`、`/tmp/s1-3.jsonl`）已删；全盘 grep 新值零残留；
    zstd 会话存档逐帧解码扫——**新值 0 命中**，历史存档仅剩已失效的旧值。
  - **根因②（技能正文不传播）**：registry 技能条目的 `skill_md_content` 为 null，内容端点回退到
    `skill_md_raw_url`——而该字段**冻在 10-03 创建时的 v1 坐标**（`craw.…/versions/1/…`），
    于是子机冷启动永远拉到 v1 旧技能文本（含缺陷的单行读凭据法），今日的加固文本根本没到执行体。
    **修法**：部署后把当前版本技能正文写入 registry（`skill_md_content` + 修正 `skill_md_raw_url`），
    已按 v10 落库并验证子机拿到（`cred()` 在场、旧 sed 消失）。
  - **技能侧加固**（`scripts/spider-heal-pack.mjs`）：①凭据读取改 `cred()` 函数，覆盖行内/块标量/
    空值续行三形态，并明令**绝不为「看清楚」打印凭据文件**；②状态目录不可写时降级到
    `./.spider-heal/inbox.json`（不再申请提权——无审批通道必然失败关闭），协议语义不变。
  - **fleet 调度旁证**：本次 v9/v10 部署被调度器自动落到 **runner-b / runner-c**（cheap-6/cheap-7
    k8s pod），非原 cheap-1 `agent-runner-dsh`；两处均已实证 pin 新值。
  - ⚠️ **遗留（待萬星侧）**：runner-b/c 所在节点 **cheap-6/cheap-7 无 GitHub 出口**
    （`github.com:443` TCP 超时；对照 cheap-1 主机 200）。修复/生成链依赖 GitHub 出口（当前实现
    走 API+tarball，会话实证 ghApi/tarball 引用），**这两台节点需补出口或把 spider-heal 固定调度回
    cheap-1**（部署时显式传 runnerId，或调度器排除）。另外 runner 镜像**不含 git**（历版皆无，
    非本次回归）——技能按 API 路径工作，不依赖系统 git。

