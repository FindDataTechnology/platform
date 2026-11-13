# adopt-curated-external-skills

## Why

开源生态里最热门的那几个技能仓（`anthropics/skills` 186k★、`obra/superpowers` 311k★、`VoltAgent/awesome-claude-code-subagents` 26k★）恰好覆盖了我们最空的一条轴：材料广场 197 条技能里，**工程类只有 3 条**（且都来自 2026-10-08 那一次导入），法律 119 条、金融 27 条。外部生态能补的正是这条空轴，而它同时也是许可证最分化的地方——`anthropics/skills` 的许可**逐技能不同**：14 条 Apache-2.0 可再分发，pdf/docx/pptx/xlsx 四条是 Proprietary（"may not create derivative works" / "may not distribute"），doc-coauthoring 干脆没有 LICENSE 文件。

现有货架的两个源（SkillHub / Smithery）都是**搜索引擎**：条目会漂移、会 404、许可证恒为 unknown——这正是转正通道存在的理由，但它缺少一个相反姿态的入口：**人工挑条目、钉死 commit、逐条留证**。同时许可门有一个真缺陷：专有原文（"All rights reserved" + "may not distribute"）一个已知许可 id 都不命中，被归进 `not-declared`，于是拒绝理由写成「上游未声明许可」——与事实相反。

## What Changes

- **新增一类源：精选钉定源（curated pinned source）**。人工挑条目 + 40 位 commit sha 钉死，条目零正文（清单只写运营判断），内容一律运行时从 pin 取。它就是一个普通 adapter（list / get / fetchPackage），注册进现有货架工厂，因此**货架浏览、安装、转正三条既有路径零改动即通**。
- **首批清单**：`anthropics/skills` @ `ca45fc496a3436251f191354091d557da31c15b5` 的 13 条 Apache-2.0 技能。四条专有技能与一条无许可技能**结构性不在清单里**（不靠运行时门去挡），`claude-api` 因超包边界（60+ 辅助文件 > 64 上限）也不列。
- **修正许可门的一处误判**：新增 `proprietary` 轴——声明了「保留所有权利 / 不得再分发」的许可文件是**声明了不给**，不是「没声明」。只在既无宽松也无已知禁止时生效，宽松许可里常见的 "All rights reserved" 样板文字不改变准入结论。
- **修正转正组包的一处崩溃**：`sanitizeFrontmatter` 返回 null（上游 frontmatter 只有 name + description）时，`Object.keys(null)` 会整条崩掉——`skill-creator` 第一条就撞上。现在落成 `{}`，产出一个不带 frontmatter 的合法包。
- **一条可复跑的审计命令**：`scripts/adopt-curated-skills.mjs` 逐条跑许可门并打印裁决，`--emit` 产出转正 manifest + provenance，任何一条被卡即退出码 1（fail-closed）。

## Capabilities

### New Capabilities

（无。精选源是既有货架能力的一个源实现，不是新能力域。）

### Modified Capabilities

- `external-skill-sources`: 新增「精选钉定源」这一类源的要求——sha 钉定、清单不带正文、结构性排除不可再分发的上游条目。
- `official-adoption`: 许可门新增 `proprietary` 轴（专有 = 已声明且不可再分发，不得记作未声明）；转正必须容忍清洗后为空的 frontmatter。

## Impact

- **代码**：`lib/curated-sources.js`（新）、`lib/license-gate.js`（专有轴）、`lib/adoption.js`（frontmatter 空值）、`external-sources.js`（`extraAdapters` 注入缝）、`server/routes/extensions.js`（装配）、`scripts/adopt-curated-skills.mjs`（新）、`scripts/test-curated-sources.mjs`（新）。
- **契约**：无破坏性变更。`createExternalSourceRegistry` 多一个可选参数（缺省行为逐字节不变）；`evaluateLicense` 多一种 `axis` 取值；货架多一个源 id。
- **数据**：本 change 不写生产数据。转正产物由脚本在发布时生成；把它们推上市场与注册处是后续的运营动作（对外可见，需另行确认）。
- **依赖**：`GITHUB_TOKEN` 可选——匿名 60 次/小时在 13 条上会撞墙（实测第 6 条起 403），有 token 时只对 `api.github.com` 挂 Authorization。
