## Why

插件/技能进场的瓶颈不是代码，是**审校吞吐**：runbook 定了三轴（安全/许可证/质量）+ 五轴（插件另加 P1/P2），却全靠人在台账里手工记录；条目一多，"这条过没过、凭什么过、谁签的、审的是哪个 commit"就变成翻文档。结果是上限只能定得很低（首批 ≤15 server / ≤50 技能），而且这个上限不是政策偏好，是记录方式的副产品。

更麻烦的是**证据与条目分家**：`packs/plugin-catalog.json`（或部署侧 `PLUGIN_CATALOG_FILE`）里有条目，`docs/ecosystem-curation-ledger.md` 里有记录，两边靠人同步——正是"三份清单必有一份是假的"的同型问题。

本变更把审校证据变成条目的一部分，并让出片/上架路径**拒绝缺证据的条目**：不是放宽闸门，而是把"过了什么审"从散文变成可判定的字段，从而让同一批人能安全地审更多条目。

## What Changes

- 供给目录的每条条目 SHALL 携带结构化审校证据：轴结果（安全/许可证/质量，插件再加 P1/P2）、上游钉点（repo + commit/tag）、SPDX 许可证、出网决议（`none` / `allowlist(...)` / `open`）、审校人、日期。
- 出片前置与上架路径 SHALL 拒绝缺证据或不完整的条目，并按轴点名缺的是哪一项；证据过期的条目 SHALL 标记为"待复审"，不得以"已审"状态对外呈现。
- 台账改为**从条目生成**（单一源），不再手工并列维护；生成物与条目不一致时 CI 红。
- 证据的**自动采集**（许可证识别、依赖 advisory 扫描、egress 分类、注入面启发式）SHALL 明确归属外部仓 `mcp-gateway-registry` 的评审流水线，本变更只定义 paas 侧需要消费的证据形状与判定；本仓不实现扫描器。
- **不改**：精选档的准入原则（无社区直灌、无公开提交面）、首批数量上限（政策值仍在 runbook）、五轴的内容（只是要求留痕）、插件只烘入不运行期安装。

## Capabilities

### New Capabilities

- `curation-evidence`: 供给条目的审校证据契约——证据字段与轴枚举、完整性判定、过期与待复审语义、出片上架路径的拒绝规则、台账由条目生成的单一源判据、与外部评审流水线的边界。

### Modified Capabilities

- `supply-catalog`: 目录条目 SHALL 携带审校证据（按 species 要求不同轴），读面 SHALL 能标出"已审 / 待复审 / 缺证据"，缺证据条目 SHALL NOT 以可供给状态呈现。

## Impact

- **packs**：`packs/plugin-catalog.json` 条目 schema 增 `evidence` 块（`axes` / `pin` / `licence` / `egress` / `reviewedBy` / `reviewedAt` / `reviewValidUntil`）。
- **server**：`server/plugin-catalog.js` 的归一化增证据透传与三态派生（`已审` / `待复审` / `缺证据`）；`facet/supply-catalog.js` 的 annotation 增证据摘要字段（不含审校人邮箱）。
- **scripts**：新增 `scripts/check-curation-evidence.mjs`（出片前置与 CI 共用）；新增 `scripts/gen-curation-ledger.mjs`（从条目生成台账 markdown）。
- **docs**：`docs/ecosystem-curation.md` 增"证据字段"一节；`docs/ecosystem-curation-ledger.md` 标注为生成物。
- **测试**：新增 `scripts/test-curation-evidence.mjs`（缺轴/缺钉点/缺 egress/过期四类拒绝 + 完整条目通过）、`scripts/test-curation-ledger-drift.mjs`（手改台账必须让 CI 红）。
- **跨仓**：自动采集器与注册表侧评审流水线在 `mcp-gateway-registry`，需另立变更；本变更在 paas 侧只消费证据形状，未采集时人工填写同样合法（字段在手写路径上不被绕过）。
- **兼容性**：既有条目不打断——首次运行把现有条目判为"缺证据"并在读面标出，不删除、不改供给态；补齐后恢复。
