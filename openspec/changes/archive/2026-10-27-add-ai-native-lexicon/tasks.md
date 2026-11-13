# Tasks: add-ai-native-lexicon

## 1. 词位清点与 locale 改值

- [x] 1.1 产出改动总表 `lexicon-map.md`（placed at change root）：grep zh-CN+en locale 中所有含「舰队/Fleet/集群/Cluster（动态义）/功能集/能力包/我的包」字样的键，逐项标注 新值 或 「不动」；显式列出「技能包」不动清单——验证：表内键数与 grep 命中数一致
- [x] 1.2 zh-CN locale 改值（键名零改）：舰队→集群（导航/驾驶舱品牌/徽章/概况页签）、动态集群词组→阵列（我的/创建/详情/解散/载入/composer/会话头部）、功能集等混用→能力包、市场→能力市场——验证：`pnpm --filter web typecheck`（或本仓等价命令）绿 + 快照 CI locale 闸绿
- [x] 1.3 en locale 同步改值：Fleet→Cluster、动态 Cluster（session-bound 组）→Array、pack 文案统一——验证：同 1.2
- [x] 1.4 全仓用户可见文案残扫：`grep -rn "舰队\|功能集" web/src --include="*.ts*" --exclude-dir=locales` 应只剩代码注释（注释可留）——验证：输出为空或仅注释行

## 2. 市场徽章（pack-marketplace delta）

- [x] 2.1 服务端实现读时徽章推导：按优先级 蓝图（manifest 带 fleet/cluster 组织块）→ 分身（有 facade serving 契约角色）→ 助手（有角色）→ 工具（无角色），市场列表与详情响应附带 badge——验证：对含四种结构的 manifest 各取一 representative 条目，响应 badge 正确
- [x] 2.2 徽章前端展示：市场卡片与详情页渲染徽章，zh/en 标签（蓝图/分身/助手/工具 ↔ Blueprint/Facade/Assistant/Toolkit）——验证：存量三条目 CRM 客服套件→工具、分身工坊→助手、寻数分身→分身 免重发即显示正确徽章
- [x] 2.3 徽章推导单测：四种结构的边界样本（含「带组织块且含 serving 角色」→蓝图优先）——验证：新增测试全绿

## 3. 种子显示名

- [x] 3.1 五枚 seed 的 `name` 字段更新（AI 公司/内容流水线/晨报情报站/投研晨会/客服班组），文件名/packId/占位符契约不动——验证：钉住清单真源的既有测试同步期望后全绿
- [x] 3.2 铸造/发布脚本对五枚种子的任何硬编码旧名引用同步——验证：铸造 dry-run 对五种子无旧名输出

## 4. 口径物与外联

- [x] 4.1 供应商命名规约段写入 `docs/creating-packs.md` 与 cluster-pack 创作者指南：包名自由、不审后缀、类型=徽章——验证：文档段落在位且与 spec `native-lexicon` 的 covenant 一致
- [x] 4.2 CMS 双语图解课程改版清单（documentId ialhphcq8nk7n2qvcqk9fkk2，zh/en，列出涉及「舰队驾驶舱」的段落与截图序号）落 `lexicon-map.md` 附节——验证：清单移交内容侧，课程重发不阻塞出片
- [x] 4.3 台账 `docs/registry-maintenance.md` 记账：词位改版出片代 + 种子换名代——验证：发布后补记

## 5. 联动与验证

- [x] 5.1 联动核对：`add-pack-locale-tracks`（E 改名）与供给开放四单引用词典处对齐——验证：相关 change 文档无「舰队/功能集」新引言
- [x] 5.2 出片前绿门：web typecheck + locale 闸 + 徽章单测 + 种子测试 全绿——验证：CI 摘要四绿
- [x] 5.3（出片后执行）真机眼见：zh 界面导航=集群、驾驶舱品牌=集群驾驶舱、agents 页=我的阵列、市场卡徽章四类型至少各一见——验证：走查账号（aloadtree）截图留证

## 6. 提交约束（2026-10-27 实施期实测）

- [x] 6.1 回归扫：`scripts/test-fleet-report-lane.mjs`/`test-fleet-decision-lane.mjs` 的【舰队巡视上下文】【舰队岗位身份】断言、`e2e/facet-shell.spec.js` 的「我的功能集/マイ機能集」按钮名、`e2e/agents-smoke.spec.js` 的 clusters 空态正则、ja locale 残留「機能集」两处——全部修正后相关套件绿（fleet 27/27、board+core+copilot 54/54、locale 闸 5/5）
- [x] 6.2 提交已解（外科 hash-object+update-index，仅 4 处接线入 main `57f33095`；徽章上产眼见见台账 §15.67）——原记：：`gateway/packs.js` 同一批 hunk 里同时含本变更的徽章改动与 add-pack-locale-tracks 泳道的未完成改动（其 `./vendor-onboarding.js` 模块尚未落地，整文件当前 import 即失败）。该文件**不可单独提交**；待 locale 泳道落地后由其后一次提交把两边一并带入，或由该泳道作者先行提交。
