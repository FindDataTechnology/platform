# 簇 G2 体检卡 — chat/对话（15 模块）

体检员：G2（chat 全系）。日期：2026-11-06。paas HEAD = 07a8e0c7（2026-11-06 04:36）。
簇级共享证据（各节不重复）：
- **③ 部署态（全体共享）**：`fd-infra-deploy/all-services/prod/platform.yaml:57` 与 `facet.yaml:66` 均为 `platform:sha-a96731b`（源 5e91d61b，2026-11-06 03:55）；`git merge-base --is-ancestor 5e91d61b HEAD` → **ANCESTOR-OK**，距 HEAD 仅 ~41 分钟，chat 全系部署态新鲜。以下各节标「③ 共享·通过」。
- e2e 文件系统 mtime 均为 Oct 11（checkout 产物，不可用）；下文 e2e 老化一律按 **git 最后提交日期** 计。
- chat 面代码（web/src/components、server/agent-session.js、dsh-events.js 等约 20 文件）自 2026-09-05 共 **253 commits**，为全仓最热 UI 簇。

---

## 1. chat-activity-collapse — B
理由：对齐良好、双向新鲜，但小样本上 fix 密度偏高（2/4=50%）。
- ① 入口：`web/src/components/ActivityGroup.tsx:56`（等待提问卡绝不折叠的豁免）、`:61`（`isGroupOpen`/pending 动作自动展开）、`:78-105`（data-open/aria-expanded 折叠渲染）——覆盖 spec 5 条 Requirement 的关键行为（默认折叠+错误/待确认自动展开）。
- ② 测试：e2e `e2e/chat-polish.spec.js`（git 2026-09-08，59 天）承载折叠行为；无专测文件。未证实存在独立 collapse 单测。
- ③ 共享·通过。
- ④ fix 密度：`git log --oneline --since=2026-09-05 -- web/src/components/ActivityGroup.tsx` → 4 commits 中 2 fix（50%，样本小）。
- ⑤ 陈旧度：spec 2026-10-22 vs 代码 2026-10-22，剪刀差 0 天 → 不 stale。

## 2. chat-attachments — B
理由：实现完整且删除链有防护注释，但 e2e 老化 52 天。
- ① 入口：`web/src/components/Composer.tsx:101`（attachments 状态机）、`:110`（拒音频上传注释）；服务端 `server/routes/documents.js:78-95`（`removeDocument` + `removeUploadDir`，注释明确 "a delete never orphans bytes on disk"）↔ spec Req2「stored original removed with document」。
- ② 测试：`e2e/attachment-preview.spec.js` git 2026-09-15（52 天）。test/ 无 attachments 单测。
- ③ 共享·通过。
- ④ fix 密度：attachments 专属路径不可分（与 composer-controls 共用 Composer.tsx，其 fix 密度 6/20=30%）；未证实独立密度。
- ⑤ 陈旧度：spec 2026-10-21 vs Composer.tsx 2026-11-02，剪刀差 12 天 → 不 stale。

## 3. chat-chart-rendering — C
理由：spec 落后代码 31 天越 stale 线，e2e 老化 53 天；但零 fix 说明不痛。
- ① 入口：`web/src/components/EChart.tsx:16-23`（`import("echarts/core")` 懒加载单例，↔ Req3 lazy-load）；渲染/theme 注入同文件。spec 6 条 Requirement 中 refresh 类不在本 spec（`chart-refresh.js:1-2` 头注「openspec: add-chart-data-binding」，且 `openspec/specs/chart-data-binding/` 独立成 spec → 非 shadow）。
- ② 测试：`e2e/chat-chart-rendering.spec.js` git 2026-09-14（53 天）。
- ③ 共享·通过。
- ④ fix 密度：`git log --oneline --since=2026-09-05 -- EChart.tsx chart-bindings.js chart-refresh.js chart-source.js` → 1 commit / 0 fix。
- ⑤ 陈旧度：spec 2026-10-02 vs EChart.tsx 2026-11-02，剪刀差 **31 天 > 30 → stale**（越线 1 天，边缘案例）。

## 4. chat-commands — B
理由：对齐清晰，但寄生在 agent-session.js 热点上（fix 密度 52% 共享）。
- ① 入口：`server/ws.js:481-562`（前导斜杠解析→skill/model/new 分发）、`server/agent-session.js:800`（`command_use` 块 emit，↔ Req2 可折叠块）、`web/src/components/SlashCommandPicker.tsx:38`（picker 组件 ↔ Req3/4）。
- ② 测试：未证实 commands 专属 e2e；autocomplete 行为疑似在 chat-polish/composer-controls.spec.js（2026-10-22）内覆盖。未证实。
- ③ 共享·通过。
- ④ fix 密度：随 `server/agent-session.js` 16/31=52%（共享热点，非 commands 独有）。
- ⑤ 陈旧度：spec 2026-10-21 vs agent-session.js 2026-11-06，剪刀差 16 天 → 不 stale。

## 5. chat-composer-controls — B
理由：10 条 Requirement 全簇最厚，对齐与测试均新鲜，唯 fix 密度 30% 显示持续打磨成本。
- ① 入口：`web/src/components/ControlStrip.tsx:15-19`（restart 语义注释 ↔ Req3）、`:321,350`（流中 agent 切换拒绝 ↔ Req7/8）、`:356,545-551`（context meter，兼 chat-usage-display）；移动端 16px 字号（Req9）在 Composer.tsx。
- ② 测试：`e2e/composer-controls.spec.js` git 2026-10-22（15 天）、`e2e/composer-stop.spec.js` 2026-10-14（23 天）——簇内最Fresh。
- ③ 共享·通过。
- ④ fix 密度：ControlStrip.tsx 20 commits 中 6 fix（30%）。
- ⑤ 陈旧度：spec 2026-10-22 vs ControlStrip.tsx 2026-11-02，剪刀差 11 天 → 不 stale。

## 6. chat-connect-guidance — A
理由：spec↔代码同日落地、零 fix、零漂移；唯缺专属 e2e。
- ① 入口：`server/connect-guidance.js:1-2`（"classify credential-shaped failures into a connect pointer (chat-connect-guidance, design D1/D2)"——文件头直接引用本 spec）、`web/src/components/ConnectCta.tsx`（去连接动作渲染）。
- ② 测试：未证实专属 e2e 文件；深链 `/settings/connections?panel=` 行为或由 settings 侧测试覆盖。未证实。
- ③ 共享·通过。
- ④ fix 密度：`server/connect-guidance.js + ConnectCta.tsx` 1 commit / 0 fix。
- ⑤ 陈旧度：spec 2026-10-19 vs connect-guidance.js 2026-10-19，剪刀差 0 天 → 不 stale。

## 7. chat-history — C
理由：实现活跃、spec 联动好，但 e2e 老化 107 天为全簇最重 + 无单测。
- ① 入口：`chat-history.js`（投影写入）、`server/routes/chat-history.js`（REST 端点）、`web/src/components/ChatSessionMenu.tsx`（列表/重命名/删除 UI）；spec 11 条 Requirement 全簇最多之一，`dsh` transcript 投影（Req11）入口在 chat-history.js。
- ② 测试：`e2e/chat-history.spec.js` git **2026-07-22（107 天，全簇最老）**；session-delete 2026-10-01、session-ownership 2026-10-10 较新；`test/` 无 chat-history 单测。
- ③ 共享·通过。
- ④ fix 密度：`chat-history.js + server/routes/chat-history.js + chat-history-store` 11 commits 中 3 fix（27%）。
- ⑤ 陈旧度：spec 2026-10-20 vs chat-history.js 2026-10-31，剪刀差 11 天 → 不 stale。

## 8. chat-input-focus — B
理由：单 Requirement 模块，对齐无恙；无专属测试。
- ① 入口：`web/src/components/Composer.tsx:263`（`if (focusTick > 0) textareaRef.current?.focus()`——focusTick 外部触发注入）、`:132`（RAF focus）。
- ② 测试：未证实专属 e2e/单测；行为只能借 chat-polish 间接覆盖。未证实。
- ③ 共享·通过。
- ④ fix 密度：并入 Composer.tsx 30%（不可分离）。
- ⑤ 陈旧度：spec 2026-10-21 vs Composer.tsx 2026-11-02，剪刀差 12 天 → 不 stale。

## 9. chat-memory — A
理由：簇内 spec 最新（10-30）、单测专属且 12 天前刚动、fix 密度健康。
- ① 入口：`cell-memory.js:1-15`（cell memory mount + 单源 discipline 文本 "fix-memory-capture-p0 D6"，↔ Req4 note 写纪律单一来源）、`server/cluster-memory.js`、`server/routes/memory.js`（chat 面开关 ↔ Req2）。
- ② 测试：`test/cell-memory.test.mjs` git 2026-10-25（12 天）+ `cluster-memory.test.mjs`、`dsh-profile-memory.test.mjs`——本簇唯一有专属单测的模块。
- ③ 共享·通过。
- ④ fix 密度：memory 面 15 commits 中 4 fix（27%）。
- ⑤ 陈旧度：spec 2026-10-30 vs cell-memory.js 2026-11-06，剪刀差 7 天 → 不 stale。

## 10. chat-outline-navigation — B
理由：spec↔代码同日、零 fix；但整模块 42 天无触碰、e2e 同龄。
- ① 入口：`web/src/components/ChatOutline.tsx:1-5`（文件头即 spec 复述：collapsed edge control + hover 展开列出 user turns）、`:21`（`ChatOutline({entries, onJump})` ↔ Req4 跳转+释放 auto-scroll）。
- ② 测试：`e2e/chat-outline.spec.js` git 2026-09-25（42 天）。
- ③ 共享·通过。
- ④ fix 密度：1 commit / 0 fix。
- ⑤ 陈旧度：spec 2026-09-25 vs ChatOutline.tsx 2026-09-25，剪刀差 0 天 → 不 stale（但双陈：双方 42 天未动）。

## 11. chat-plan-progress — C
理由：客户端冻结在 spec 同日，但服务端 plan 链（dsh-events）在 spec 之后 39 天仍在改——越 stale 线；e2e 42 天。
- ① 入口：`web/src/components/PlanPanel.tsx:1-15`（文件头引用 add-plan-progress-panel；空 plan 不挂载 ↔ Req6）、`:82`（`export function PlanPanel()`）；服务端 `server/dsh-events.js:153-159`（`ctx.planMessage` 缓存快照，↔ Req2/3 persists across turns + connect 推送）。
- ② 测试：`e2e/plan-progress.spec.js`、`e2e/plan-smoke.spec.js` 均 git 2026-09-25（42 天）。
- ③ 共享·通过。
- ④ fix 密度：PlanPanel+task-engine 20 commits 中 3 fix（15%）。
- ⑤ 陈旧度：spec 2026-09-21 vs dsh-events.js 2026-10-30，剪刀差 **39 天 > 30 → stale**（spec 未随 dsh-events 演化回写）。

## 12. chat-streaming — C
理由：全簇痛点热点——fix 密度 52%、13 条 Requirement 最多、spec 追着修改。
- ① 入口：`server/dsh-events.js:365-389`（live delta lane "restore-assistant-stream-020"，text-delta 逐块 emit ↔ Req2/3）、`:496+`（abort/done 重置 ↔ Req4）；`server/agent-session.js:417`（流中切换拒绝 ↔ chat-composer-controls Req7 协同）；前端排队气泡（Req13）在 Composer/Chat。
- ② 测试：`e2e/session-navigation-streaming.spec.js` git 2026-10-19（18 天）、`e2e/composer-stop.spec.js` 2026-10-14、`e2e/chat-turn.spec.js` **2026-08-28（70 天）**。
- ③ 共享·通过。
- ④ fix 密度：`server/agent-session.js` `git log --oneline --since=2026-09-05` → 31 commits 中 16 fix（**52%**；样本 fix：748e51f7、c375f551、9f4434ef 等）。G7 卡 42% 口径（窗口略异）量级一致，证实。
- ⑤ 陈旧度：spec 2026-10-21 vs agent-session.js 2026-11-06，剪刀差 16 天 → 不 stale，但 spec 7 次修改/62 天 = 追修复式演化。

## 13. chat-ui-shell — B
理由：SPA 架构 spec 稳定，唯 chat-layout e2e 老化 69 天；fix 密度不可分离（shell 与全 web/src 共线）。
- ① 入口：`server.js:279`（static SPA + deep-link fallback）、`server.js:238-239`（压缩中间件须先于 express.static）；SPA 面入口 `web/src/pages/ChatPage.tsx`（2026-10-24）。
- ② 测试：`e2e/chat-layout.spec.js` git **2026-08-29（69 天）**、`e2e/chat-deeplink.spec.js` 2026-10-22（新鲜）。
- ③ 共享·通过。
- ④ fix 密度：web/src 全域 253 commits 中 shell 专属不可分；未证实独立密度。
- ⑤ 陈旧度：spec 2026-10-06 vs web/src 最近 2026-11-04，剪刀差 29 天 → 不 stale（贴线）。

## 14. chat-usage-display — A
理由：三处入口全对齐、链路注释直接引用 spec、测试 26 天、零专属 fix。
- ① 入口：`server/dsh-events.js:219-239,533-535`（turn 完成携带 usage，注释 "chat-usage-display"）、`web/src/components/AssistantTurn.tsx:291-301`（turn footer，注释直接引用 spec，history reload 省略而非显示 0 ↔ 诚实展示）、`web/src/components/ControlStrip.tsx:356,545-551`（context meter，`data-testid="strip-context-meter"`）。
- ② 测试：`e2e/pack-usage.spec.js` git 2026-10-11（26 天）。
- ③ 共享·通过。
- ④ fix 密度：`server/usage-telemetry.js` 1 commit / 0 fix。
- ⑤ 陈旧度：spec 2026-10-14 vs ControlStrip.tsx 2026-11-02，剪刀差 19 天 → 不 stale。

## 15. chat-welcome-state — B
理由：对齐好、低痛感；e2e 依赖 59 天前的 chat-polish。
- ① 入口：`web/src/components/ChatWelcome.tsx:65-74`（recent 排序 + `slice(0, RECENT_PREVIEW)` 最近 5 会话 ↔ Req2）、`:119`（`t("chat.welcome.greeting")` i18n ↔ Req3）。
- ② 测试：承载于 `e2e/chat-polish.spec.js` git 2026-09-08（59 天）；未证实专属测试。
- ③ 共享·通过。
- ④ fix 密度：8 commits 中 1 fix（12.5%）。
- ⑤ 陈旧度：spec 2026-10-17 vs ChatWelcome.tsx 2026-10-22，剪刀差 5 天 → 不 stale。

---

## 簇摘要

**三件最严重的事：**
1. **chat-streaming 是痛点热点**：agent-session.js 自 2026-09-05 fix 密度 52%（16/31），证实 G7 的 42% 观察为同源问题；13 条 Requirement 追修复式演化，delta lane（restore-assistant-stream-020）等新能力持续压向同一文件。建议为 streaming 子契约补独立单测而非继续堆 e2e。
2. **chat-history e2e 老化 107 天（全簇最重，超出旁证给的 60-98 天区间上沿）**：`e2e/chat-history.spec.js` git 2026-07-22 后未动，`test/` 无任何 chat-history 单测，而该模块 62 天内 spec 改 6 次、代码改 11 次——回归防护与变更速率严重失配。
3. **spec 剪刀差成簇出现**：chat-plan-progress（39 天）、chat-chart-rendering（31 天）双 stale——服务端 dsh-events/plan 链与 EChart 在 spec 冻结后继续演化；且 chart-refresh 能力已迁至 chart-data-binding spec，chat-chart-rendering spec 未回链说明。另 e2e chat-turn（70 天）、chat-layout（69 天）、chat-polish（59 天）构成第二层老化带。

**旁证核对**：①「chat 面 e2e 老化 60-98 天」——按 git 日期实测为 15~107 天分布，chat-history 107d 已超区间（更严重），证实并加重；②「agent-session.js fix 密度 42%」——本卡口径（since=2026-09-05，regex fix|修复|bug|hotfix）测得 52%，量级一致，证实。

**评级分布**：A×3（connect-guidance / memory / usage-display）｜B×8（activity-collapse / attachments / commands / composer-controls / input-focus / outline-navigation / ui-shell / welcome-state）｜C×4（chart-rendering / history / plan-progress / streaming）｜D×0。簇健康度：中上，痛点集中在 streaming 热点文件与 history 回归防护。
