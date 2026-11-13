# 生态桥兼容性核查（add-ecosystem-bridge 1.1）

日期：2026-10-07 · 核查对象：fd-1.0.0（上游 1.32.0 收敛线）注册处代理面对「当下主流 streamable-HTTP MCP server」的兼容性。触发：ADR-0017「生态漂移被接受……若未来对外生态互操作收紧，重估」条款被入向开源 server 首次触发。

## 结论（钉版/出局规则）

**传输与协议层：兼容，无需钉版动作。** 开源 streamable-HTTP server 可按现有 server 接入形态直接进注册处。

**逐 server 接受性：走既有健康探测机器，不新增豁免。** 每个新 server 注册时照常探测（initialize 过才算 healthy，nginx 才生成代理块——已知竞态坑：首探常败，须带 `MARKET_REGISTRY_TOKEN` 手动重探，见 docs/pack-marketplace.md §3.1）。

**stdio-only server（filesystem/fetch/git/memory/sequential-thinking/yfinance 等）：不直连，托管时包 HTTP 壳。** 注册处代理只说 HTTP 传输（streamable-http/sse 双支持），stdio server 需 supergateway/mcp-proxy 类壳转成 streamable HTTP 再按常轨注册——这是 1.4 的托管模式决议，不是注册处的缺口。

## 证据链

1. **代码级**（fd 谱系 `registry/core/mcp_client.py`）：代理用官方 MCP Python SDK 的 `streamablehttp_client` + `sse_client` 双传输；协商序 = URL 后缀（`/mcp`→streamable-http，`/sse`→SSE）→ server 条目 `supported_transports` 声明 → 探测兜底（先试 streamable-http）；连接前过 url_guard SSRF 门。协议版本协商委托 SDK，注册处自身不钉协议版本。
2. **依赖钉版**（`pyproject.toml`）：`mcp>=1.9.3` 浮动下限——镜像构建时解析。fd-1.0.0 构建于 2026-10-05，SDK 为近期版（支持 2025-03-26 / 2025-06-18 协议族）。**注意**：这意味着「SDK 传输层」随每次镜像构建浮动，与 ADR-0017「MCP 语义冻结在 1.32 时代」的直觉不同——冻结的是注册处自身 API 代码，不是 SDK 传输栈。重建镜像时 SDK 会前进，属安全单行道之外的**良性浮动**，但换镜像前两套测试照跑即覆盖。
3. **线上实证**：
   - 2026-10-05 wire 客户真回合经网关全链通（law_search/yearbook_read 真数据）——streamable-HTTP 上游（law-bench 等）过代理的完整证据。
   - 2026-10-07 探针：`POST /fd-open-data-mcp/mcp`（protocolVersion 2025-06-18）→ 401 + 双 WWW-Authenticate 头，第二头带 `resource_metadata` 指引——前沿门说 streamable 语义（POST+JSON-RPC），未因协议版本拒绝。

## 已知缺口（记档，不在 1.1 修）

- 401 响应带两条 WWW-Authenticate（裸 `Bearer` + 完整版）——部分客户端困惑，随 5.1 OAuth 三件修。
- 探测-注册竞态（首探 unhealthy 不自愈）——既有坑，开源 server 批量注册时会高频踩到，1.4 托管流程把「注册→手动重探」写进操作步骤。

## 出局规则（若未来踩到）

上游 server 要求注册处不支持的传输扩展（如 elicitation、新传输类）时：该 server 出局或等 SDK 浮动吃到——不做注册处侧定制协议代码（维持 ADR-0017 独立谱系纪律：不为生态兼容改自有代码）。
