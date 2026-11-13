# add-official-starter-teams

## Why

路线线5c：让新用户「快速理解我们的项目」。资产已齐——五枚官方团队种子（AI 公司/内容流水线/
晨报情报站/投研晨会/客服班组，en 副轨随 `add-official-packs-i18n` 就位）、四员官方 Builder
（`add-builder-team-templates`）、三枚官方助手、官方集合读面与登录墙前呈现
（`add-official-pack-showcase`）——但**「新用户第一支团队装哪支、装完看什么」没有答案**：
新手引导（onboarding tour）指向的是桌面机群步骤与入门包，没有一个「官方 starter teams」的
首选序列；每支官方团队也没有面向受众的说明卡（干什么/几岗位/怎么装/装完先看哪块看板）。

## What Changes

- **官方 starter 集（首选序列）**：定义新用户首触序列——`客服班组`（最小满编三岗、节奏最直观、
  凭据缺位如实降级）为默认首选；`AI 公司`（全景示范）与 `内容流水线`（编排/接棒示范）为次选；
  `投研晨会`/`晨报情报站` 为领域进阶。序列 SHALL 呈现在引导与官方集合面，**不强制安装顺序**、
  不改变任何 pack 的安装与实化语义。
- **首触引导接线**：first-run 引导与帮助中心的「开始」路径 SHALL 指向 starter 集（市场官方集合
  深链），桌面机群步保留（那是桌面专属路径）；新用户装完 starter 团队后的落地指引 SHALL 指向
  其驾驶舱与「全队暂停→确认→点燃」的既有纪律。
- **官方团队说明卡**：每支 starter 团队 SHALL 有一张结构化说明卡（一句话定位、岗位构成、节奏、
  需要什么凭据（可缺位如实）、装完先看哪块看板）——数据源自种子 manifest 与 fleet 段（零第二真源），
  经既有 guide 内容模块通道呈现于市场详情与官方集合面（沿 pack-marketplace 的 guide card 机制）。
- **文档面**：说明卡之外，`docs/` 面向受众的「从零到第一支团队」教程 SHALL 与 starter 序列同词表
  （v4 术语），作为 facet docs/官网可链的公开文档（匿名可达，沿 showcase 语义）。
- **明确不做**：不做一键「全套安装」按钮（安装仍是逐 pack 的显式动作）；不改种子内容与铸造链；
  不做新用户自动建队。

## Capabilities

### New Capabilities

- `official-starter-teams`: 官方 starter 团队序列——定义、首触引导接线、结构化说明卡与公开教程的
  同词表供给。

### Modified Capabilities

- `onboarding-guidance`: first-run「开始」路径指向官方 starter 集（桌面机群步保留）。
- `registry-product-home`: 匿名落地页的行动入口增官方 starter 集深链（沿既有 featured 语义，不新开门）。

## Impact

- **web**：引导与帮助中心接线；市场官方集合面呈现 starter 序列与说明卡（消费 `official` 判定与
  guide card 通道）；i18n 五语言同批。
- **内容**：五支 starter 的 guide 内容模块条目（packGuides.ts 既有通道）+ 一篇公开教程
  （`docs/` 下，同词表，v4 术语）。
- **registry 侧（对侧仓）**：落地页行动入口深链——挂账协同项，本仓只交付深链目标。
- **运营**：starter 团队随铸造班上架（与 #3/#4/#5 合班）。
- **不影响**：种子结构、安装/实化链、桌面机群步、市场门。
