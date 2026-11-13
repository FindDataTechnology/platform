# 簇 G6 健康卡 — memory / document / session 全系（17 模块）

审计人：G6 体检员 · 日期 2026-11-06 · paas HEAD `9f13fda`（2026-11-06 04:13）
**实际在册清单**（`ls openspec/specs/ | grep -E '^(memory|document|session)'`）：`document-collections / document-library-tools / document-management / document-management-ui / document-search-index / memory-digest-embed-lane / memory-distiller / memory-eval / memory-federation / memory-portal-ui / memory-surface-hardening / memory-tier-promotion / memory-visibility / session-list-management / session-ownership / session-share / session-solution-capture` 共 17 条。
**③ 共同部署事实**：paas 侧 13 模块宿 `fd-infra-deploy/all-services/prod/platform.yaml:57` 镜像 `sha-a96731b`（源 paas `5e91d61b` 2026-11-06 03:55；`git merge-base --is-ancestor 5e91d61b HEAD`=是，落后 3 提交，当日新鲜；facet 同镜像 `facet.yaml:66`）。memory 六模块的另一半真源在独立仓 `/Users/chengsishi/finddata/fd-memory`（HEAD `c83e48b` 2026-11-05）：`fd-memory.yaml:63` 镜像 `sha-c83e48b`=该仓 HEAD（零落后）；distiller sidecar `fd-memory-distiller.yaml:43` 镜像 `sha-ea3fb14`（源 `13533c9` 2026-10-30，`git merge-base --is-ancestor 13533c9 HEAD`（fd-memory）=是，落后 5 提交）。五项检查中「代码最近 commit」对 memory 系取 paas+fd-memory 两仓较新者。

---

## document-collections — B
spec 新、代码新，但两条 Requirement 的测试覆盖未证实。
① 对齐：`collections.js:20-76`（list/create/rename/delete/members）；`server/routes/documents.js:95-138`（/api/collections CRUD+成员挂接）；projectId 透传 `e1f54324`（10-31 上产修补）。「agent-creation handoff」在 collections.js 无直接入口，未证实（疑在 web 层）。
② 测试：无 test-collection*.mjs；`test-knowledge-live-binding.mjs`/`test-member-mcp-patch.mjs` 间接触碰 collections 字段——专用测试未证实。mtime（间接件）2026-11-05。
③ 部署：platform `sha-a96731b`（见头注）⊇ 含 e1f54324。
④ 痛感：`git log --since=2026-09-05 -- collections.js server/routes/documents.js | grep -c fix`=1（e1f54324 上产漏 add）。
⑤ 陈旧度：spec 2026-11-02 vs collections.js 2026-10-31——负剪刀差，不 stale。

## document-library-tools — A-
四工具齐备、边界服务端强制、测试链新鲜。
① 对齐：`server/library-mcp.js:45/61/81/98`（list_library/search_library/read_document/fetch_document_file 四行注册）；project 边界经 `LIBRARY_COLLECTIONS` 注入成员 patch（`1d21317d`，server/fleet-memory.js worker-slot 链）；匿名 guest 不发库工具（cell 预设仅挂 MCP 行）。
② 测试：`scripts/test-library-fetch.mjs`（10-08）、`test-library-mount-chain.mjs`（10-31）、`test-save-library-bridge.mjs`（10-16）。
③ 部署：platform `sha-a96731b`；spec 提及的 fetch_document_file 在镜像源 4969b95f（10-08）之后，已上产。
④ 痛感：library-mcp.js since 9/5 共 3 提交 0 fix（e25fefa6 feat）。
⑤ 陈旧度：spec 2026-11-02 vs 代码 2026-10-31——不 stale。

## document-management — B
无 LLM 摄入与断点续传语义有实现锚点，但专用测试薄弱。
① 对齐：`server/routes/documents.js:13`（POST /api/documents，本地摄入零 LLM 调用）；`:61` 注释明示 crash-between-insert-respond 可恢复语义（"without it the ingest cannot resume"）；`:63/:67` 列表/详情。
② 测试：未发现 test-documents*.mjs 专用件；`test-file-serving.mjs`/`test-migrate-single-to-cell.mjs` 触碰 documents-store——摄入主链测试未证实。
③ 部署：platform `sha-a96731b`（routes/documents.js 于 11-01 f380e62c 改动已在内）。
④ 痛感：routes/documents.js since 9/5 共 2 提交 1 fix（e1f54324）。
⑤ 陈旧度：spec 2026-10-21 vs 代码 2026-11-01——不 stale。

## document-management-ui — C
功能在但 spec 48 天未随代码走，WebSocket 状态面证据不足。
① 对齐：`web/src/pages/DocumentsPage.tsx`（:225-230 drag-drop 上传、:263 upload 图标）；WebSocket 状态事件在 DocumentsPage 前 400 行未见显式 ws 订阅证据——该 Requirement 实现入口未证实（可能在 api 层轮询）。
② 测试：未发现 DocumentsPage 相关 *.test.*——未证实。
③ 部署：platform `sha-a96731b`（web 构建随镜像）。
④ 痛感：web 文档面 since 9/5 有 e25fefa6「知识记忆面」重构等 feat，0 fix 直接命中。
⑤ 陈旧度：spec 2026-09-13 vs 代码（DocumentsPage 所在 web 面）2026-10-31——剪刀差 48 天=**stale**（重构后 spec 未回头核对）。

## document-search-index — B
实现完整但代码自 spec 日零改动，测试只有间接件。
① 对齐：`documents-search.js:24` chunkText、`:49` indexDocumentChunks、`:56` backfillChunks（启动回填）、`:94` searchLibrary（词法+collection 下推）、`:118` readDocumentPage。
② 测试：未发现 test-search-index/chunk 专用件（`test-chunk-failure.mjs` 属 skill 打包域，非本模块）；`test-knowledge-live-binding.mjs` 间接读 searchLibrary——未证实。mtime 2026-11-05（间接）。
③ 部署：platform `sha-a96731b`。
④ 痛感：documents-search.js since 9/5 = b2cacbdc 1 提交，0 fix。
⑤ 陈旧度：spec 2026-09-13 vs 代码 2026-09-13——剪刀差 0（双侧同日冻结），形式上不 stale 但双侧均 54 天未动，属冷区。

## memory-digest-embed-lane — A
自适应预算/删失观测/双端超时契约全链有码有测，fix 闭环快。
① 对齐：fd-memory `src/embed-gate.ts:15-65`（串行 embed+冷却闸 noteEmbedOutcome）；paas `server/cluster-memory.js:25` digestTimeoutMs（注释明示必须高于 fd-memory embed 预算上限）；降级可观测经 digestLadder 三档 warn（`8a80f7de`）。
② 测试：fd-memory `src/test/adaptive-deadline.test.ts`+`embed-gate.test.ts`（10 月内）；paas `scripts/test-digest-timeout-config.mjs`（10-29）。
③ 部署：paas `sha-a96731b` + fd-memory `sha-c83e48b` 双侧均 HEAD 级。
④ 痛感：4ff0a80d「5s→9s」生产超时实锤后一次修死（10-29），此后 0 fix。
⑤ 陈旧度：spec 2026-10-30 vs 代码 2026-11-06——不 stale。

## memory-distiller — B
契约/纪律/调度全对齐，但 10 月 fix 密度全簇最高=真实痛感区。
① 对齐：fd-memory `distiller/app.py:67/:95/:126`（/tag、/promote、/embed 端点）+`engine.py` 契约层；`src/distill.ts:53-66`（live 候选过滤+supersedes 闭环）；`src/distill-scheduler.ts:47-133`（会话边界去抖 5min/60s 双闸）。
② 测试：`distiller/test/test_engine.py` 15 个 test（13533c9）；`src/test/distill.test.ts`/`distill-u-root.test.ts`（10-30 内）。
③ 部署：sidecar `sha-ea3fb14`（源 13533c9）落后 fd-memory HEAD 5 提交——但这 5 提交未触 distiller/ 目录，sidecar 实际无漂移。
④ 痛感：fd-memory 仓 since 10-01 对 distill 链 4 个 fix（978973c 巡检回声 277 条堆积 605k 日烧、ebb04ca supersede 复活、fa254bf 磁盘扫描缺口、9b8b3dd 打标车道三缺陷）——均为生产实锤级。
⑤ 陈旧度：spec 2026-10-30 vs distill-scheduler.ts 2026-10-30——不 stale。

## memory-eval — C
三臂评测脚本与基线在，但「进 CI 必跑」硬要求未证实落地。
① 对齐：fd-memory `scripts/eval-continue.mjs:34`（baseline fixture）+:104（armFilter 单臂网格模式）；`scripts/eval-distill.mjs`（distiller S1 场景回放）。
② 测试：`src/test/eval.test.ts` 存在（仅 2 个 test 块，薄）。
③ 部署：评测为离线车道，无独立部署面（合理）。
④ 痛感：eval 链 since 9/5 0 fix（d4dcc46 10-29 为脱敏顺带）。
⑤ 陈旧度：spec 2026-10-27 vs eval-continue.mjs 2026-10-29——不 stale。**但**：paas `.github/workflows/ci.yml` grep eval/distill=0 命中、fd-memory 仓无 `.github/`——spec「评测 v1 进 CI 且引擎变更必跑」**未证实有 CI 强制**，降为 C。

## memory-federation — A-
组合/凭据纪律与 /hook 兼容面双侧对齐，测试新鲜。
① 对齐：paas `cell-memory.js:23`（CELL_MEMORY_ENABLED 门，默认关）+:58（mcp-fd-memory patch 行）；fd-memory `src/http.ts:216`（POST /hook 上游兼容协议逐字实现）；令牌铸造 paas `server/fleet-memory.js:117`（per-member 懒铸 deployment 令牌）。
② 测试：paas `test/cell-memory.test.mjs`（10-25）+`test/cluster-memory.test.mjs`（10-25）+`scripts/test-cell-memory-gate.mjs`（11-02）。
③ 部署：双侧 HEAD 级（见头注）；619d95d8 曾抓「OFF 下仍带【工作记忆】块」违 spec 场景并修死——spec↔代码闭环实例。
④ 痛感：cell-memory/fleet-memory/cluster-memory 三件 since 9/5 共 12 提交 4 fix（768a48bb 串投、619d95d8 总闸、8b89c936 冒烟收口、4ff0a80d）。
⑤ 陈旧度：spec 2026-10-30 vs 代码 2026-11-06——不 stale。

## memory-portal-ui — A
owner/部署者双 lane+修正手势+漏斗视图全数落码，spec 11-02 最新。
① 对齐：paas `server/routes/memory.js:21`（/api/memory/entries owner 读面代理）+:119（deployer-entries 萬星 lane）；`web/src/pages/MemoryPage.tsx`+`web/src/api/memory.ts`；蒸馏漏斗为主视图（9bf79e5f 11-02 门面批② tier 徽章 token 化）。
② 测试：`scripts/test-memory-face.mjs`（11-02）、`scripts/test-resource-memory-gestures.mjs`（10-28，记住/正典/改 tag 三手势）。
③ 部署：platform `sha-a96731b`。
④ 痛感：memory.js+MemoryPage since 9/5 共 5 提交 0 fix。
⑤ 陈旧度：spec 2026-11-02 vs 代码 2026-11-02——零剪刀差。

## memory-surface-hardening — A-
四需求（输入边界/结构化拒绝/向量规模观测/全表扫描口径）双侧有码有测。
① 对齐：fd-memory `src/test/vector-scale.test.ts:1,29`（vectors.scale 指标含 over_threshold 标记，metrics.ts 供数）；手势写面结构化拒绝：fd-memory `src/http.ts` /pages/mutate 主+paas `server/routes/memory.js:85` 代理 409/502 透传。
② 测试：fd-memory `vector-scale.test.ts`、`http-routes.test.ts`（c83e48b 11-05 面）；paas `test-memory-face.mjs`（11-02）。
③ 部署：fd-memory `sha-c83e48b`=HEAD；paas `sha-a96731b`。
④ 痛感：harden 系 since 9/5 0 fix（本模块即修别人痛的）。
⑤ 陈旧度：spec 2026-10-30 vs 代码 2026-11-05——不 stale。

## memory-tier-promotion — A
AI 封顶 stable、人批才翻 tier 的全链（sidecar→fd-memory→paas 代理→面板）对齐且逐层有测。
① 对齐：fd-memory `13533c9`（promotion_cursor+tier_proposals 表+人接受才翻 origin=human）；sidecar `distiller/app.py:95` /promote（封顶在解析器 canonical→stable）；paas `server/routes/memory.js:58`（GET promotions 代理）+:85（accept/ignore 手势，409 stale 透传）；web MemoryPage 提议区块（6b68a9ed）。
② 测试：paas `scripts/test-memory-promotions-proxy.mjs`（10-30，5 测）；fd-memory `src/test/promotion.test.ts`（10-30）。
③ 部署：三层镜像（platform a96731b / fd-memory c83e48b / distiller ea3fb14）均含晋升链。
④ 痛感：晋升链 0 fix（新车道无生产事故）。
⑤ 陈旧度：spec 2026-10-30 vs 代码 2026-10-30——零剪刀差。

## memory-visibility — A
筛选/forget 审计/tier-tags 读面三需求全对齐，fd-memory 侧 11-05 仍在其上叠加。
① 对齐：fd-memory `src/store.ts:297`（forgetPage 逻辑删+`:304` audit 落账）+`src/http.ts:905`（POST /forget）+`:152`（layer→types 映射 L1/L2 筛读）；owner scope 分区判定 `src/http.ts:185-287`。
② 测试：fd-memory `src/test/reference.test.ts`+`core.test.ts`（c83e48b 内）；paas `test-memory-face.mjs`（11-02）。
③ 部署：fd-memory `sha-c83e48b`=HEAD（oversight 面越权 403 在 c83e48b 注记）。
④ 痛感：visibility 面 0 直接 fix。
⑤ 陈旧度：spec 2026-10-28 vs 代码 2026-11-05——不 stale。

## session-list-management — A-
右键菜单/删除确认/活动会话禁删/turn 状态均有码有测。
① 对齐：`server/routes/chat-history.js:117`（DELETE，409 活动会话/403 非属主）+:137（PATCH 重命名）；`web/src/components/ChatSessionMenu.tsx:29`（Clear+Delete，活动/运行中/排队三态禁删 tooltip :51-62）。
② 测试：`scripts/test-chat-history-delete.mjs`（08-24 偏老）+`test-chat-store-session-open.mjs`（10-28）+`test-chat-store-rename.mjs`（10 月内）。
③ 部署：platform `sha-a96731b`（1390f837 10-27 在内）。
④ 痛感：chat-history 路由 since 9/5 共 7 提交 2 fix。
⑤ 陈旧度：spec 2026-10-21 vs 代码 2026-10-27——不 stale。

## session-ownership — B
归属戳/读面 scope/操作门实现清晰，但测试 37 天未动、spec 36 天未随 e25fefa6 的 ws 归队改动复核。
① 对齐：`server/routes/chat-history.js:100-104`（创建即戳 owner，无主行 admin-only）+`:3`（列表按 requester scope）；turn 归属 `server/turn-dispatch.js`（per-viewer 事件面）。
② 测试：`scripts/test-session-ownership.mjs`（2026-09-30，全簇最老的正名测试件之一）。
③ 部署：platform `sha-a96731b`。
④ 痛感：session 三件（chat-history/share.js/session.js）since 9/5 共 7 提交 2 fix。
⑤ 陈旧度：spec 2026-10-01 vs 代码 2026-10-27——剪刀差 26 天，临界未过 30，不标 stale。

## session-share — B
注册表/限流/双端页面全在，但核心代码 42 天零改动，滥用面只靠单一限流器。
① 对齐：`gateway/share.js:24`（createShareRegistry，24 字符 token）+:97（createRateLimiter 30 读/min，SHARE_RATE_MAX 可调）；`gateway/index.js:717/:735/:742/:753`（mint/list/revoke/公开读）；web `web/src/pages/SharePage.tsx`+`App.tsx:220`（/share/:token 路由）；小程序 `miniapp/src/pages/share/index.tsx`。
② 测试：`scripts/test-session-share.mjs`（10-11，registry 10k mint 去重+wire 双身份门+不可区分 404——注释自述很全）。
③ 部署：platform `sha-a96731b`。
④ 痛感：gateway/share.js since 9/5 1 提交 0 fix（3d68a792 demo mode 顺带）。
⑤ 陈旧度：spec 2026-09-25 vs share.js 2026-09-25——零剪刀差（双侧冻结）；freeze 本身使「公开端滥用控制」spec 需求（擦除语义、rate）无法被新威胁模型复核——关注项非 stale。

## session-solution-capture — B+
提炼入口/示例勾选/落预设三步齐，链路测试在但 UI 件 23 天未动。
① 对齐：`web/src/components/SessionToPresetDialog.tsx:143-174`（真实 examples 摘录+partial PUT）+`ChatSessionMenu.tsx` 提炼入口；落库 `server/routes/custom-presets.js:234`（POST /api/agent/presets）。
② 测试：`scripts/test-session-to-preset.mjs`（10-13）+`test-preset-session-bridge.mjs`（10 月内）。
③ 部署：platform `sha-a96731b`。
④ 痛感：SessionToPresetDialog since 9/5 0 直接 fix。
⑤ 陈旧度：spec 2026-10-21 vs 代码 2026-10-14——负剪刀差（spec 晚于代码），不 stale。

---

## 簇摘要

**最严重三件事**：
1. **memory-eval 的「评测进 CI 且引擎变更必跑」未证实落地**：paas `ci.yml` 与 fd-memory 仓（无 `.github/`）均无 eval 强制门——蒸馏引擎（痛点最密的模块）变更可绕过评测入产，spec 硬门形同虚设（未证实有替代执行点）。
2. **document-management-ui spec 48 天 stale**：09-13 后 e25fefa6「知识记忆面」重构动了文档面，spec 未回头核对，且其 WebSocket 状态事件的实现入口未证实；同簇 document-search-index / document-management 专用测试双双未证实（仅间接件）——document 系是簇内 spec↔测试双薄弱区。
3. **memory-distiller 是全簇真实痛感源**：fd-memory 仓 10 月对 distill 链 4 个生产实锤级 fix（巡检回声 277 条堆积日烧 605k token、supersede 复活、扫描缺口、打标三缺陷），修得快但说明 L2 车道稳定性仍在还债期；另簇内代码最大能力增量（成员知识画像 `1d21317d`，knowledge-profile.js + per-member mcp patch）spec 尚在 active change（add-member-knowledge-profile 26/29）未归档， specs/ 无对应条目=当前最大 shadow 面。

**评级分布**：A×5（digest-embed-lane / federation / portal-ui / surface-hardening / tier-promotion / visibility 中 5 评 A，library-tools A-）· 实计 A/A- 6 · B/B± 8（含 collections/management/search-index/ownership/share/solution-capture/distiller）· C×2（document-management-ui / memory-eval）· D×0。
