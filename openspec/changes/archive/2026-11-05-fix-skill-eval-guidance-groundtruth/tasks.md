# fix-skill-eval-guidance-groundtruth — Tasks

## 1. judge 提示词改造

- [x] 1.1 `server/skill-eval.js`：judgeUser 构造增加指导文档真值段——supersedes 时旧 body 与候选 body 以盲标「指导文档一/二」提供，文档洗牌独立于回答甲乙丙洗牌；验证：单测——文档段存在、盲标集合与回答标签集合独立
- [x] 1.2 判据文案增加有据性规则（与任一文档一致=有据；文档+任务都不含=无据，对称适用全臂）与「有据性只解决真值核验，质量按完成任务程度评」的防偏置句；验证：单测——判据文案含三要素
- [x] 1.3 指导文档按 `clip()` 同参截断防超长；验证：单测——超长 body 截断后进入提示词

## 2. 回归

- [x] 2.1 既有 skill-eval 单测与 evolution 桥/路由套件全绿；验证：`node --test scripts/test-skill-eval*.mjs` 及孪生套件零失败
- [x] 2.2 非 supersedes 候选（两臂）行为不回潮：无旧文档段、单文档段（候选 body）仍提供；验证：单测——两臂形态的提示词构造

## 3. 实弹验证与收尾

- [x] 3.1 出片（快照→relay→digest 硬门→GitOps demo→ArgoCD hard）；验证：demo pod imageID 与构建 digest 全等
- [x] 3.2 demo 实弹：重铸 §15.135 被拒的 v3 形态候选（政策+条款注记，supersedes 政策 v1 基线）在新评测算下评测，验证政策条款获有据对待；验证：judge 判词不再以「无从考证/臆造」为由单独否定候选臂
- [x] 3.3 若过闸：promote → `evolution_lineage` 落列 + 评审面可见（A2 promote 腿闭环）；若仍拒：判词归因入册（judge 能力边界 vs 设计缺口）
- [x] 3.4 台账/memory 更新 + 归档；验证：memory 索引行含本变更要点
