## Context

- 首页权威副本 `paas/docs/ciyuan/home-content.html` 经 `scripts/apply-ciyuan-home.mjs`
  做管理 API 部分 PUT（只写 `home_content` 键，`omittedSettingKeys` 机制保证不重置
  其他设置）；上轮已建立，基线锚 `home-content.baseline-2026-10-05.html` 保留。
- 车道段现为四张 `.lane` 卡（ASR/TTS/rerank/websearch），CSS 在
  `#fdr-lanes .lanes`（grid auto-fit minmax(240px,1fr)）。
- 视频能力事实（explore 取证）：网关 `POST|GET|DELETE /v1/contents/generations/tasks`
  （四前缀注册），要求 openai/composite 分组 + 组内可调度到 Seedance 上游账号；
  Seedance 计费走 result token（`completion_tokens`）。开源兼容的 `/videos` 路由
  仅对 Grok/Composite 开放（openai 组 404）——文档口径必须写原生任务协议路径。
- 官网页：`fd-official-web` 的 `src/content/apps/zh|en/finddatarouter.md`，
  上轮已滚过一版（sha-710bfb4）。

## Goals / Non-Goals

**Goals**
- 首页、官网页、介绍文档三处口径同步含视频能力；匿名可见。
- 四车道卡徽标贴底对齐，桌面与窄屏都不破。

**Non-Goals**
- 控制台车道页（`/lanes`）不加视频行（视频不走车道体系；车道页四行结构不动）。
- 不新增独立「视频车道」；不宣传具体模型名清单（上游可变）。
- 不给图像生成做同批露出（视频为本轮用户点题；图像留待后续按需）。

## Decisions

**D1：视频以「非车道能力」呈现，不塞进 `.lanes` 网格。** 车道体系=平台池抽象
（rerank/websearch/audio 各一上游平台），视频走既有 Grok-media 转发面，不是同构
体系；塞进四卡网格会坏「车道」语义且需动车道页。改为：段首导语提「三车道 + 视频」，
车道网格保持四卡（微调布局修正对齐），视频以快速上手 curl（创建+轮询）与一段
能力条目呈现。

**D2：对齐修法=flex 纵列 + margin-top:auto，而非固定高度。** `.lane` 加
`display:flex;flex-direction:column`，`.meter` 加 `margin-top:auto`——正文行数
不同的卡自然等高（grid 行拉伸）且徽标贴底；不改字号/内边距，视觉零漂移。
备选 `min-height` 硬编码行高上限，脆弱（文案一改即破）。

**D3：视频端点口径用原生任务协议。** `/v1/contents/generations/tasks`（POST 创建
+ GET 轮询 + DELETE 取消）。理由：该路径对 openai 组真实可用（`/videos` 对 openai
组 404，写了就是错口径）。示例带 `model` 与 `content` 字段形状（Ark 原生）。

**D4：官网页随常规出片滚产。** `fd-official-web` 为公开仓（免费线），改两
markdown 文件 → `fd-build-channel pick` 出片 → GitOps 滚 fd-web。

## Risks / Trade-offs

- [口径漂移再发生] → 三处（首页/官网页/介绍文档）同批改；spec 已把「视频条目
  与首页表述一致」写进伙伴材料需求，归档后主 spec 即执法口径。
- [灌入覆盖设置] → 灌入脚本只 PUT `home_content`（上轮实测其他设置不变）；灌入后
  回读核 `site_name` 等键不变。
- [CSS 改动波及他段] → 改动只加在 `#fdr-home .lane` / `.meter` 选择器下，不触
  hero/终端段样式；双宽浏览器复验。

## Migration Plan

1. 改 `home-content.html`（导语 + CSS + 视频块）→ `apply-ciyuan-home.mjs --dry-run`
   → 实灌 → 回读设置核验 → 浏览器桌面+窄屏复验（徽标贴底 + 视频块可见）。
2. 官网页两份 md 改 → 提交推 main → 出片 → GitOps 滚 fd-web → 线上眼见。
3. 介绍文档改 → 无出片（finddata/docs 非仓）。
4. 回滚：首页=灌 baseline；官网页=GitOps 回滚上一 sha。
