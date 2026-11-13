# Design — add-blueprint-studio

## 决策

### D1 治包 vs 治舰：边界铁定，不做「studio 里顺带调教活舰」

`agent-fleet-architect` 管活舰队（新建/改/停/复），`fleet-blueprint-studio` 管垂直包（蓝图→集群模板→上架）。两处**共享** fleet 段校验函数与「草稿→批准→落地」两段纪律，但职责**互不通融**：

- studio 不引入开停活舰的写路径——由 studio 上架模板装出的集群，后续经营归 owner 面/驾驶舱；
- architect 不引入铸造上架的写路径——活舰队导出为模板属 `agent-fleet-templates` 的「用—养—传」环。

代价是用户多学一条路径；换来的是「包」与「舰」各有一条干净的审计与权限口径。

### D2 蓝图是独立资产，不是「fleet 草稿的冻结体」

蓝图在平台内有自己实体、自己版本、自己批准流水、自己收回态。对客开「NL→包」的产品路径——尤其要开给外部供体——就不能把它退化成为「某次 fleet draft 的凝固体」。平台内实体的 id 与其对外上架的主体（packId）分离；蓝图的名称取中文场景主名。

### D3 校验链复用，严禁第二造

`parseFleetTemplate` / `validatePackManifest` / 发布门 allowTools ⊆ 商业集——三套既有校验器已沉淀完整的错误语义（逐字段指名）。新面再立第二套校验，错误口径就会分岔（此前「模板假拒」就是这类教训）。规格中写死：**错误来源=既有校验器原文**。

### D4 批准分两段：对话级纪律 + apply 重校验兜底

对话级纪律=主人显式批准才推进铸造/上架；apply 重校验兜底=铸造/上架动作在服务端对批准时的同一草稿（按 diff 摘要判定）重跑全套校验，发现与库状态漂移（如依赖 pack 被下架、蓝图被并发改写）时如实报错、拒绝执行。形态与 architect 的「草稿不落库 + apply 重校验」保持一致——主人在新面第一次批时，面对的是同一种信号灯。

### D5 铸造产物带追溯，模板只走一道发行门

铸造产物的 `_casting` 段必须记录：来源蓝图路径、批准凭据（谁批的、什么时间、diff 摘要）、依赖项的 packId 落实（`{{PACK_ID:*}}` 占位逐条补齐）。上架只允许走既有市场发行通道（含工具面声明闭包与商业集闸）；市场专辑里有「集群模板」专辑位，不新建另一道发行/管理通道。

### D6 试跑验收是「可售态」唯一的真源

「能安装/可见」不够——模板要进入**可售态**，必须以试跑断言全绿且报告落账为前提。第三方（vendor）上交的模板强制带「可验收的试跑报告位」。这样就把「没有验收的模板不对外」从纪律写成结构性闸，并与《供给开放》《市场分成》的准入位对账。

### D7 词表与多语言：中文主轨、英文副轨、禁退休词

studio UI 的客面名词以中文主轨（蓝图构造间/构造位/主人闸/遥测槽位）；英文等义仅副轨；「舰队」字样不出现在对客运营面（既有 spec 档案不拔文）。多语言字段形态不在本 change 重造——承接 `add-pack-locale-tracks`。

## 备选与被否

- **studio 与 architect 合面**：被否——把铸造上架与运行调教混进同一记录轨，审计与权限口径分不干净。
- **铸造后人工改模板文本默认被构造链重置**：被否——沿用「用—养—传」的纪律：人工后续改写不被构造链覆盖（即构造链不回写已人工差异的模板）。

## 涉及面（实施者锚）

| 面 | 锚 |
|---|---|
| 蓝图实体存储与路由 | `~/paas/server/` 既有路由与读面惯例（由 apply 会话选定） |
| 校验链 | 既有 `parseFleetTemplate` + `facet-pack-builder/validate_manifest.py` |
| 铸造/上架 | 既有 pack 发行门；依赖占位规则见 finddata `fleet-packs/README.md` |
| 专辑位 | 市场/壹座「集群模板」专辑（姊妹需求书《cluster-rename-and-shelf-views-requirements》） |
| 试跑样件 | finddata `fleet-packs/blueprints/cross-border-ecom-policy`（断言/证据/`_casting` 可参照） |
| 词表 | finddata 根 spec `pack-taxonomy-and-naming`（「构造位/主人闸」骨词） |

## 实施口径对账（2026-10-28 explore 补记）

paas 侧对 finddata《blueprint-studio-implementation-notes》逐条复核（7 条断言 5 条全准）后的口径修正——apply 时以本节为准：

### D3 补充：商业集腿的 consult 复用

spec「校验链含 allowTools ⊆ 商业集」与指引「勿复制发布门闸」并不冲突：`lib/publish-tool-gate.js` 的同步导出（`toolFaceErrors` / `toolClosureErrors`）就是发布门同源闸的纯函数部分，`/validate` 以 consult 模式直接 import 复用——复用不是第二套校验器；异步全量 `toolGateErrors`（含探针）仍只由发布门执行，终闸不变。

### 蓝图库注入随仓俗

`server/routes/blueprints-db.js` 沿 `fleets-db.js` / `clusters-db.js` 同款构造器注入（`file || path.join(storeDir("data"), "blueprints.db")`），测试以参数重指到 tmp——指引的 `BLUEPRINT_DB_PATH` 环境变量方案不采用。

### 校验函数两形状陷阱

`server/fleet-template.js` 同文件两个导出形状不同：`parseFleetTemplate` 返单对象 `{ ok:false, error }`；`resolveFleetTemplateParams` 返数组 `{ ok:false, errors:[{name,error}] }`。蓝图链只用前者（参数槽到铸造/装台时方才 resolve），实现勿混抄。

### 切片落法（用户 2026-10-28 拍板）

Slice 1（任务 1.1-1.3 + 3.1-3.3 服务端脊柱）先行——挂载窗口为 `server.js:284` 之后两行，当前 HEAD 干净；Slice 2（UI）等 `polish-web-surfaces` / `add-fleet-owner-surface` 收口（两案正改 `App.tsx`/`Sidebar.tsx`/`FleetsPage.tsx`）；Slice 3（试跑/可售态，任务 4.x）待 `add-vendor-supply-open` 准入字段收口后对齐，且试跑执行器形状需单独一轮探索。finddata 原型底稿（非权威）复产落点约定为 `docs/blueprint-studio-prototype/`。

### D8 试跑执行器形状（2026-10-28 勘察定案，Slice 3 实施口径）

「装一台跑一轮」= 既有链的**编排**，不新增第二调度器、不新增第二写路径：

1. **装台**：`fetchMarketManifest({packId, version, viewer})`（既有市场读面）取铸造版 manifest → `provisionFleetFromTemplate`（既有装台器；dedup：同 pack+owner 复用既有试跑舰，重跑不铸双舰）。试跑舰命名 `${场景}·试跑`，与正式装作可区分。
2. **点火**：走与 `POST /api/fleets/:id/start` **同一代码路径**（抽 helper 复用，state→active + cadence 启用 + reconcile），不复制启动逻辑；装台器本身"装不自动跑"的纪律不变——点火是试跑的显式动作。
3. **跑一轮**：reconcile 物化的 cron 作业逐个 `cron.runJobNow(jobId)`（既有触发面；这不是第二调度器，是把既有调度器点火一次）；逐岗记录 turnId。
4. **收证**：窗口内轮询 `member_reports`（source=self/derived）与 trace——证据三元组 = `{turnIds, reportIds, sourceRefs}`，逐断言落。
5. **判绿（断言闭集，确定性优先）**：`post-materialized`（成员落位非空）/ `first-round-fired`（指定岗位窗口内有回合）/ `report-landed`（指定岗位窗口内有报数）/ `escalate-bounded`（升级数 ≤ 阈值）。**未知 kind 判不绿并如实报**——不许静默通过（4.2 的结构性闸从这里来）。
6. **落账**：`trial_report_json`（既有存储位）= `{ ranAt, fleetId, assertions:[{id,kind,pass,detail,evidence}], green }`；报告全量落盘可查。
7. **可售态（4.2 的 paas 半）**：blueprint 侧 `trialReport.green` 是唯一真源；市场侧「可售」呈现字段随 `add-vendor-supply-open` 的 vendor 准入位落——跨仓缝，本 change 只保证 paas 半的真相源与 API 形状，不越仓造字段。

**待决/挂后**：LLM 判断言（自由文本断言）不在本片——它破坏「断言全绿才可售」的确定性，须单独立项；断言 kind 的跨仓对齐（finddata `blueprints/schema.md` 契约）在 Slice 3 实施时对账，paas 侧闭集先落地、未知 kind 拒绝而非猜测。

## 验收闸

- `openspec validate add-blueprint-studio --strict` 全绿。
- 需求书 §4 的 7 步旅程全真跑通（一名非内部 owner 仅凭界面完成「场景→草稿→批准→铸造→上架→试跑」）。
- 反向断言：仓库内不出现第二校验器/第二上架通道/第二调度器；错误文案不得超过既有校验器原文的字段粒度。