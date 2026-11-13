# Tasks: chat-interaction-round2

## 1. 规格对账验证（零代码）

- [x] 1.1 验证 live model/set 行为：服务端链取证 `agent-session.js:281` 按 `hasLiveMethod("model/set")` 分叉（live=setModel RPC 不重启）、`ws.js:718` 处理体无 pendingConfig；**抓到并修复真实偏差**——`ControlStrip.tsx:623` 原无条件 `setPendingConfig("model")`，live 桥上切模型会出现禁发窗（:352 pendingConfig≠null 禁整条+发送），已加 `if (!liveControl.modelSet)` 守卫；e2e「live bridge: strip model switch applies with no pending window」真跑通（3.1s 非 skip：采样 2.5s 内 data-pending 恒空 + chip 翻转）
- [x] 1.2 回归确认 ControlStrip pending 语义仅 effort/workspace 触发（effort :652 / workspace :397 维持 setPendingConfig）；model-selection + external-sources 两套件 20/20 过

## 2. 外装技能更新流（server）

- [x] 2.1 preview 只读端点：`GET /api/extensions/external/update-preview/:name`（按已装名解析 origin_meta）；previewUpdate/diffSnapshot 落 external-install.js——body/frontmatter/aux 三桶 + sha256（node:crypto 本地实现）、复用 registry.fetchPackage 既有缓存与限额；只读零写
- [x] 2.2 确认更新复用既有写路径：`POST /api/extensions/external/update`（confirm 门同 install，server 端强制）→ performUpdate 走 `store.updateCustomSkill` + `materialize.writeSkill`（物化器自清陈旧 aux、watched-dir 热重载）；**本地名钉死**（上游改名不 fork 新行）；失败保持快照
- [x] 2.3 单测 14/14 绿（node --test scripts/test-external-install.mjs）：diff 三桶+identical=no-changes / 钉名防 fork+陈旧文件清理 / 非外装技能 not-external 400 + 未知技能 404 / 上游失败快照与物化树全保

## 3. UI

- [x] 3.1 SkillCard 外装条目（originMeta.kind=external）加更新入口（external-update-button）→ ExternalUpdateDialog 差异预览（版本线/正文状态/计数/逐文件状态/noChanges/失败重试/脚本 ack 沿用 install）→ 确认/取消；无角标无自动提示
- [x] 3.2 五语 update 块各 +19 行（round-trip 零格式噪音）；check:locales 1669 keys×5 OK；web:build 绿；e2e 更新流 4 用例（入口区分/预览+confirm 携带旗/noChanges 禁钮/上游失败可重试）全过——仓内该面无组件单测基建，e2e 即本面测试层

## 4. 探针与收口

- [x] 4.1 生产探针（cheap/fd-prod platform pod 只读扫 17 个 cell trace.db）：85,503 事件 / 244 会话，todo_write **19 次 / 11 会话 / 4 cells（≈4.5% 会话）**，最近 2026-10-20T12:12Z——**非近零（>1% 阈）→ 挂账关闭，不立 nudge**（采纳有限但真实且仍在发生）
- [x] 4.2 e2e：更新流 4 用例 + live-bridge 无 pending 1 用例，model-selection+external-sources 20/20；typecheck 本刀文件 0 错（主线 PackDetailDialog cluster 债属 agent-cluster-platform 会话，在案不碰）；biome 本刀 10 文件干净（cell-memory/pack-manifest/publish-tool-gate 债非本刀）；validate 绿
