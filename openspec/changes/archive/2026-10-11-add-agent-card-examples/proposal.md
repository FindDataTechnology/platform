# add-agent-card-examples

## Why

M3 ②「目录发现+agent card 富化」的基座：agent 名片要有「试问示例」——访客在目录看到 agent 时，一条示例问句比一段描述更能回答「我能拿它干什么」，且可点击直达对话（预填）。card 手工字段今天只有 name/description/capabilities/skills。

## What Changes

- `serving.card.examples`：≤3 条示例问句（每条非空 ≤200 字符），manifest 校验+组合透传；缺省卡片形状不变。
- fd-wanxing 侧消费（另行 change `add-catalog-discovery`）：目录详情展开渲染示例+点击直达对话预填。

## Capabilities

### Modified Capabilities

- `a2a-agent-serving`: ADDED requirement「Example prompts ride the AgentCard」。

## Impact

- 代码：`lib/pack-manifest.js`（CARD_KEYS+校验）、`lib/agent-serving.js`（composeAgentCard 透传）、`scripts/test-agent-serving.mjs`（断言补）。
- 上线：platform 镜像（facet 同镜像）滚 facet；存量卡片不带 examples 形状不变（纯增量）。

## Non-goals

- 不改 registry 条目形状（examples 随 card 字段落 entry，registry 无感）。
