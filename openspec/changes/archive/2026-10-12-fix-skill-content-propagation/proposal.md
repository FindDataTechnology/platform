## Why

2026-10-12 spider-heal 凭据轮换事故（finddata 侧交接文档 `docs/spider-heal-fleet-egress-handoff.md` P1）
暴露了 pack 技能正文传播的结构性断链：paas 部署侧（`lib/agent-serving.js` `deployToRegistry`）每次
升级都 PUT `skill_md_content` 与版本化的 `skill_md_url`，但 registry 的 `SkillRegistrationRequest`
（`registry/schemas/skill_models.py`）没有 `skill_md_content` 字段——pydantic 在解析时静默丢弃，
正文永远进不了库；`skill_md_raw_url` 只在首次创建时由 `translate_skill_url` 派生一次，更新路径
从不刷新。于是子机冷启动经 `/api/skills/{path}/content` 回退拉取时永远拿到 v1 旧文本——
spider-heal v9/v10 的技能加固根本没到执行体，这正是 agent 重复用旧式 `grep+sed` 读凭据的根因之一。

finddata 侧已直接写库热修（补当前版本正文与 raw_url），但下次 pack 升级正文仍会丢失——
需要 schema/服务端永久修。

## What Changes

registry 侧两处（A+B），paas 侧零改动：

- **A. schema 增字段**：`SkillRegistrationRequest` 增加 `skill_md_content: str | None`，
  与存储模型 `SkillCard` 同名字段对齐。PUT 更新经 `model_dump(exclude_unset=True)` 落库——
  部署侧现有 PUT 即刻生效，正文随版本走；不带该字段的编辑（registry UI）不会误清空已存正文。
- **B. raw_url 派生刷新**：`skill_service.update_skill` 在 updates 含 `skill_md_url` 且与现值
  不同时，重跑 `translate_skill_url` 刷新 `skill_md_raw_url`——把「raw_url 是 skill_md_url 的
  派生值」变成服务端不变量，消灭「展示 v10、实际取 v1」的错位，所有客户端受益。
- **顺手收口**：updates 带来正文变化时刷新 `content_updated_at`（缓存校验用的时间戳不再停在
  创建时刻）；空串正文归一为 None（防误清空语义）。

## Capabilities

### New Capabilities
- `skill-content-propagation`: registry 技能条目的正文随版本传播——PUT 接受内联正文、
  raw_url 随 skill_md_url 派生刷新、内容端点取值永远与当前版本一致。

### Modified Capabilities

## Impact

- 代码：registry fork（`~/code/mcp-gateway-registry`）——`registry/schemas/skill_models.py`
  （request 模型）、`registry/services/skill_service.py`（update 派生刷新）、
  对应单测（`tests/unit/test_skill_models.py` + update 路径测试）。
- 兼容性：纯增量。旧客户端不发送 `skill_md_content` 时行为不变（unset 不落 updates）；
  现有 PUT 消费方（registry UI 编辑表单）不受影响。
- 发布载体：registry 镜像沿标准 TCR 线 + cheap-1 compose 栈滚版；与本地未发布的三笔提交
  （virtual-router scope 修复 / fastembed 瘦身 / card examples）的编组待拍板。
- 不动：paas `lib/agent-serving.js`（已发送正文字段，无需改）；内容端点取值顺序
  （content 优先 → raw_url 回退）维持现状。
