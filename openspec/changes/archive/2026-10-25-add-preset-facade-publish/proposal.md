# add-preset-facade-publish

> 2026-10-25 分身词汇决议（§15.39）与分身工坊自部署（§15.40）之后的 v2 收口件。采纳断点
> 已由工坊对话路径补齐（装→聊→拿→发）；本 change 补 GUI 路径——不会写 manifest 的用户
> 在壹座自建预设的一键发布流里点一个复选框，预设即以「AI 分身」身份发布。

## Why

分身能力的创建路径现有两条：手写 manifest（工程师级）与分身工坊对话（要装包、要聊）。
壹座自建预设的「发布并部署」一键流是普通用户已经会的路径——预设里本来就有 persona
（接待人设）与技能（语料），桥面已经把 persona 组成带服务契约的角色。缺的只是发布时
一个「作为 AI 分身发布」的开关：开了，manifest 多一个 `facade` 块；不开，逐字节照旧。
这使分身创建收敛为「勾一个框」，且零平台后门——块走既有发布门校验。

## What Changes

- **确认步挂开关**：PresetPublishFlow 确认步新增「作为 AI 分身发布」区块——
  - 开启时发布的 manifest 携带 `facade` 块：`reception` = 本流组成的服务面角色
    （多于一个时发布者选定；桥面恒组一个），`corpus` = 本包全部技能名，
    `delegation` = `[]`（纯接待起步），`stance` = `"hosted"`（访客免费）。
  - 组成结果不含服务面角色或不含任何技能时，开关不可用并说明原因。
  - 开关关闭时发布的清单与现状逐字节一致。
- **零服务端改动**：`facade` 块随既有 manifest 走既有发布门
  （`validatePackManifest` 已对该块做存在性与类别校验）；发布后的部署步、
  目录徽标、分身入口全部复用 add-principal-facade 的既有能力。

## Impact

- 代码：`web/src/components/packs/PresetPublishFlow.tsx`（开关+选定）、
  五语言 locale（`presetPublish.facade*`）、`e2e/preset-publish-flow.spec.js`
  （挂块正例 + 禁用反例）。
- 规格：principal-facade 增一条要求（预设流挂分身块）。
- 不动：发布门、校验器、部署面、目录面、工坊 pack、寻数分身。
