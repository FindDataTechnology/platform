# 产品身份面如实回写（N-13）

## Why

`project-identity` spec 102 天未回访（全簇最旧）。逐条对代码核，四条身份面里三条是事实性失真——spec 说的「单一一致名」在机器面上并不成立：

| 面 | spec 原文 | 代码实况 |
|---|---|---|
| 启动日志 | ``Platform running at http://<HOST>:<PORT>`` | `server.js:1105` = ``Platform listening at http://${HOST}:${PORT} (agent init in background)`` |
| MCP clientInfo.name | `platform` | 全仓无一是裸名：`paas-chart-refresh`(chart-source.js:29)、`platform-mcp-preflight`(mcp-preflight.js:59)、`paas-connector-paste`(server/routes/connector.js:95)、`paas-publish-tool-gate`(lib/publish-tool-gate.js:273) |
| 知识抓取 UA | `platform-knowledge/1.0` | 该串全仓不存在；实际 `platform-documents/1.0`(server/web-fetch.js:84)、`yizuo-external-skill-sources/1.0 (+https://finddatatech.cloud)`(external-sources.js:163,340) |

`package.json`/`package-lock.json` 名与 `<title>Platform</title>` 两条成立。

本单只做**如实回写**：把规则改成真实的「显示名精确 = Platform，机器标识以 `platform-` 为前缀按组件细分」，并如实登记两处历史前缀（`paas-` = 仓库内部代号、`yizuo-` = 中文品牌罗马化）。**不在这单里改对外标识**——UA 与 clientInfo 会被第三方服务读进日志/白名单，改名是外发动作，需单独拍板。

## What Changes

- `project-identity`「Machine-facing client identifiers use the product name」改写：从「必须等于 `platform`」改为「`platform-` 前缀 + 组件细分」，四枚在册客户端名列全；两处历史前缀如实记为已接受偏差及其来源，并标明下一次触碰该面时归一化。
- `project-identity`「Startup log uses the product name」改写：措辞与 `server.js` 一致（listening + 后台初始化后缀）；「产品名在行首」这个真正的契约保留。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `project-identity`：两条身份面 Requirement 按现势回写。

## Impact

- 纯 spec 文本；零代码改动。遗留待拍：`paas-`/`yizuo-` 两族对外标识是否归一化为 `platform-*`。
