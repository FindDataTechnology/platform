# 体检 backlog（壹座 253 spec 首次体检，2026-11-06）

253 条评级分布：**A×107、A-×120、B×17、B+×4、C×4、D×1**——C/D 合计 2.0%。证据：`findings/cluster-{A,B,C,D,E,F,H1,H2}.md`，评级回填 `ledger.md`。总体成色：无系统性漂移；债集中在**跨仓归属无注记**（8 条 ciyuan + fleet-memory + upstream-concurrency + virtual-mcp-servers 等）、**措辞滞后于现实**（改名/迁面/删除未回写）与**五条点名账**。本单不实施修复，逐条另立。

## P0 — 误导实现/资产险情

| # | 问题 | 证据 | 建议动作 |
|---|------|------|----------|
| P0-1 | **e2e-testing spec 与真实测试套自相矛盾（D）**：app-shell 条款断言侧栏为旧 tab 集（Chat/Knowledge/Agents/Bots/Trace），真实 e2e 恰断言 nav-bots/nav-trace **不存在**且须有 nav-resources/nav-tasks；RAG 条款要求覆盖已删除的「Ask the collection」Q&A 面。照 spec 重写会做反向工作 | cluster-H1 §D；e2e/app.spec.js:24-31 | 改写 app-shell 条款为现役 tab 集+删除 RAG 条款（或改指 chat 内检索流）——纯 spec 文本改 |
| ~~P0-2~~ ✅已解除（2026-11-06 深夜，属主会话三连收口 38cb9fed/efaf64d5/d0e558bc）：①实现已提交（38cb9fed，2772 行）②registerSupplyStoreRoutes 已挂载 facet/index.js:250 ③SUPPLY_STORE_CATALOG 切源开关在位（facet/index.js:257）——三重失真全部解除；战役纪律仍立：归档前 git status 对账 | cluster-D §P0 | 已收口 |

## P1 — 悬空/矛盾/归属错位

| # | 问题 | 证据 | 建议动作 |
|---|------|------|----------|
| P1-1 | **cron-module（C）interval 单位与 phase 超claim**：spec 承诺 month/year+time-of-day phase，代码只认四单位且无 phase 逻辑（cron.js:150,165-171，注释 :148-149 失实）；API 调用方按 spec 发 month 会吃到矛盾报错 | cluster-F §C1 | spec 删 month/year 与 phase（或补实现），同步修正注释 |
| P1-2 | **cron-module 补跑条款三方矛盾**：spec "SHALL NOT catch up" vs 代码窗内会补跑（cron.js:179-198）vs 姊妹 spec（cell-gateway/cell-lifecycle）明说会补跑——归属变更落在 agent-fleet-core 的 change 里，本条从未回改 | cluster-F §C1 | 回改 cron-module 补跑条款为现实口径（窗内补/窗外记账+harden 后告警） |
| P1-3 | **值班环只认 cron 表达式任务（跨 spec 盲区）**：cronJobsDue 要求 `j.cron && type==="recurring"`（lib/cell-lifecycle.js:115）——interval 型 recurring 与 one-shot 任务永远不会唤醒 suspended/on_demand cell，纯 interval 任务的 cell 会被静默挂起后永不再履约 | cluster-F §P1-1 | 扩 duty-ring 扫描含 interval 任务，或在两份 spec 明示不参与唤醒（产品拍板） |
| P1-4 | **vertical-packs（C）组闸权威指针陈旧**：spec.md:26 仍写 "per registry-groups.json"，桥已改 carried metadata 优先（registry-bridge.js:95）——按 spec 操作会去维护降级文件 | cluster-H2 §C | 场景措辞改写+头注指向 registry-bridge.js |
| P1-5 | **chat-input-focus（C）能力悬空**：唯一 requirement（新会话聚焦输入框）现网不可达——Composer 仅 focusTick 触发，New chat 按钮与 /new 均无聚焦路径 | cluster-C §C | 补聚焦行为（小面高性价比）或降 spec |
| P1-6 | **caller-preferences（C）仓内悬空**：偏好读写面（回调 URL/签名密钥/收割窗）paas 仓零实现，实体在外部 sub2api fork，spec 无归属声明 | cluster-H1 §C | 补「实现归属」头部注记 |
| P1-7 | **跨仓归属无注记成族**：fleet-memory（约 2/3 服务端条款在 fd-memory 仓）、memory-distiller/eval/surface-hardening（fd-memory 仓）、agent-service-config（console UI 在另一仓）、virtual-mcp-servers（registry 仓）、upstream-concurrency（sub2api fork）——审计在本仓反复「无从对账」 | cluster-B/C/F/H2 | 每条 spec 头部补一行实现归属；ledger 代码域列同步 |
| P1-8 | **Purpose TBD 5 处**（点名账全确认）：upstream-concurrency、agent-memory-foundation、mcp-auth-lanes、platform-memory-observability、model-surface-budget（各自 spec.md:4） | 各簇报告 | 逐条回填 3-4 行 Purpose |
| P1-9 | **web-search 设置面措辞漂移**：spec 四处写「网络搜索」分区，实现已迁 connections 卡（ConnectionsSection.tsx:25,172），靠重定向保语义 | cluster-E §P1-1 | spec 补归位说明 |
| P1-10 | **app-navigation/layout-configuration 枚举漂移**：统一注册表已含 fleets（智语 web nav）与 fleet（desktop-only），两 spec tab 集均缺；app-navigation Purpose 残留「including the Bots entry」 | cluster-H1 §P1 | 以 surfaces.ts 为单一真源同步两 spec |
| P1-11 | **zhiyu-im-bridge REST 路径笔误**：spec 写 /api/zhiyu/im-bridge/...，代码 /api/zhiyu-im-bridge/...（routes/zhiyu-im-bridge.js:32-65） | cluster-C §P1 | 改 spec 路径 |
| P1-12 | **chat-streaming steer 场景措辞滞后**：现网同会话二次 prompt 是拒绝（ws.js:177-178）非 steer 转发；requirement 正文已兜住 | cluster-C §P1 | 场景措辞更新 |
| P1-13 | **facet-editor-cli Purpose 与 Requirement 矛盾**：Purpose 写「v1 不写 MCP 配置」，Requirement 已演进为三车道写入模型，实现跟随 Requirement | cluster-D §P1 | Purpose 回写 |
| P1-14 | **agent-catalog/delegation-a2a 硬编码示例域名**：spec 写死 mcp.finddatatech.cloud，属环境实例非契约 | cluster-A §P1-2 | 改 {registry} 占位 |

## P2 — 卫生/一致性（批量顺手修）

- **陈旧注释/措辞**：cron.js:148-149（phase 失实注释）、cron.js:539（insertTask 注释过时）、design-lint.mjs 头注 "Five rules" 实为六条、blueprint-judge.js:169 陈旧注释、native-lexicon Purpose 用 v4 前词汇。
- **枚举/索引闭合**：dsh-contracts 套件索引漏合同⑱（plugin-supply）；starter 种子 5 vs 6（product-intro-fleet 未入序列注记）；layout/app-navigation 漏 fleets 面。
- **名实对齐**：delegation 工具短名 vs 注册名（delegate_task/task_progress/task_result）；agent-cluster-core picker lead fallback（?? group[0]）补 spec 语义；cell-gateway legacy 豁免 carve-out；cron-module update 目标重绑定 spec 落后代码；a2a-agent-serving 事故叙事移注记。
- ~~**私仓 biome lint 债**~~ ✅已修（ae04f0b9：出片门 lint 11 处收口，触及文件单测 67/67 绿）；biome.json deprecation 残留待版本对齐。
- **仓库卫生**：agent-runner/manager.js 含非常规字节（file 判 data、默认 grep 漏检）；scripts/tmp-*.mjs 临时脚本散落；site-plaza/translations 未跟踪；official-starter-agents-content 溯源真值住归档目录（建议复制 docs/）。
- **scheduled-task-notifications**：WeChat 订阅信封标 future-MAY 或删条目。

## 修复建议分组

1. **纯 spec 文本批**（P0-1、P1-2/4/9/10/11/12/13/14、P2 措辞类）：一个 change 批量改 spec+注释，半天量级。注：wanxing-facade spec 示例 IP/CIDR 已由属主会话在源头改范围表述（efaf64d5/d0e558bc），快照 SCRUBS 相应条目已清。
2. **代码微批**（P1-3 值班环 interval 唤醒、P1-5 chat-input-focus、P2 lint 债）：一 change，按项独立 commit。
3. **归属注记批**（P1-7、ciyuan 家族 8 条）：跨仓注记批量补，一个 change。
4. **对账专项**（P0-2）：与 supply-store 属主会话对账，不在本战役内单方面动。
