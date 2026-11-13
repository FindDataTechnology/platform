# Tasks

## 1. 内容作者

- [x] 1.1 staging/source-snapshot.json：10 支团队 × 35 岗的改版前 persona/技能名/mcp 全量快照
- [x] 1.2 staging/registry-allowtools.json：8 个 registryName 的真实工具叶名真值
- [x] 1.3 teams/ontology-build.json：柏讯本体建设 5 岗（原 64-114 字 → 410-474 字，补 report_status 槽位）+ 3 技能
- [x] 1.4 teams/web-content.json：官网内容 5 岗 + 3 技能（断言溯源/机器可读/四岗交接）
- [x] 1.5 teams/intel-sentiment.json：情报舆情 4 岗 + 3 技能 + 补钉 fd-sentiment（二梯队缺陷）
- [x] 1.6 teams/wanxing-ops.json：萬星机群运营 3 岗 + 2 技能
- [x] 1.7 teams/facet-ops.json：谦面运营 3 岗 + 2 技能（证据阶梯/可见性盘点）
- [x] 1.8 teams/lex-marketing.json：识律营销 4 岗 + 3 技能（量级话术/能力清单/选题卡）
- [x] 1.9 teams/statute-tracking.json：法规追踪 3 岗 + 2 技能（三分类判据/条级解析）
- [x] 1.10 teams/zhengxin-monitor.json：政心监测 3 岗 + 2 技能（就绪门/异动卡）
- [x] 1.11 teams/crossborder-policy.json：跨境电商政策 3 岗 + 3 技能（四路巡检/监管代码/三判据）
- [x] 1.12 teams/wire-artifact-team.json：柏讯产物构建 2 岗 + 2 技能（信号归并/草稿纪律）

## 2. 门禁与发布

- [x] 2.1 staging/publish-batch2.mjs：读面→合并（persona 精确替换 + skills/mcp upsert）→结构零 diff→内容基线→validatePackManifest→POST
- [x] 2.2 scripts/test-business-teams-content-baseline.mjs：静态门 5 条（覆盖/persona/skills/mcp/结构）
- [x] 2.3 dry-run 全绿（10/10）×2 轮（首版+转义修复版）
- [x] 2.4 `--fire` 真发布 ×2 轮：首版 10/10（v8/v6/v10/v5/v4/v5/v6/v13/v5/v5）+ 字面转义修复版 10/10（v9/v7/v11/v6/v5/v6/v7/v14/v6/v6）
- [x] 2.5 API 回读 10/10 合规 ×2 轮（v+1/skills/mcp/槽位/字面转义全清）

## 3. 走查与收尾

- [x] 3.1 生产走查 15/15：货架 10 卡+46 卡墙、详情逐支（版本/三桶/内容标记/无转义）、构建器画布门面、fork 深链、匿名登录墙+官方资产预告
- [x] 3.2 台账 §15.122（内容口径 + fd-sentiment 缺陷 + 字面转义事故三律）
- [x] 3.3 双推（origin + gitee）
- [x] 3.4 archive（主 spec 三条 MODIFIED 超集并入 + ADDED 溯源立法；validate --specs 233/0）
