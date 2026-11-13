## Why

词元已支持视频生成（Seedance 异步任务协议，10-15 已上产），但对外呈现面**零露出**：
首页源码「视频」出现 0 次，介绍文档能力表无视频行，官网页 app 卡片也没有——当前
首页结尾还把产品描述为「语音、重排、搜索」三类能力的印象，落后于版本。同时首页
模型车道段有视觉缺陷：四张车道卡中 TTS 卡正文最短，计量徽标（「按合成字符数计量」）
比其余三张高出 46px（实测 TTS chip 距底 69px vs 其余 21-23px），未贴底对齐。

## What Changes

- **首页源码**（`docs/ciyuan/home-content.html`，单一事实源）：模型车道段保持四卡
  （视频不走车道体系、车道页也不动），但：
  - 段首导语从「三类」改口径（三车道 + 视频能力）。
  - 四张车道卡 `.lane` 改 flex 纵列布局 + `.meter` `margin-top:auto`，四卡等高、
    徽标贴底。
  - 新增「视频生成」呈现：在快速上手区补视频任务 curl 示例（`POST /v1/contents/
    generations/tasks` 创建 + `GET` 同路径轮询），赛道段旁以文字条目列出视频
    端点与计量口径。
- **灌入**：`scripts/apply-ciyuan-home.mjs` 重灌（只写 `home_content`），浏览器双宽复验。
- **官网页**：`fd-official-web` 词元 app 条目补视频能力描述（中英双份），出片滚产。
- **介绍文档**：`finddata/docs/ciyuan-intro.md` 能力清单补视频行 + 快速上手补视频示例。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `ciyuan-product-surface`: 首页能力面从「三车道」扩为「三车道 + 视频生成」；
  新增四卡徽标贴底对齐的可验收口径。
- `ciyuan-partner-intro`: 伙伴介绍材料的能力清单与快速上手补视频能力（口径与
  首页一致；视频不走车道、其端点/计量表述 SHALL 与首页同源）。

## Impact

- 文档/前端资源：`paas/docs/ciyuan/home-content.html`（+baseline 锚保留）、
  `finddata/docs/ciyuan-intro.md`、`fd-official-web` 中英眉稿。
- 官网页出新片滚产（GHA→hkccr→relay→ccr）；首页为设置灌入，无出片。
- 不动 sub2api 代码；不动作计费/路由。
