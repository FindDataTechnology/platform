# Tasks — add-facet-client-walkthroughs（F2.1）

- [x] 1.1 connect 真链路：console 铸 wgk 键（platformtest）→ connect 验活 0600（已通）
- [x] 1.2 五 target install --write-mcp 真跑：技能落位+原生配置形状逐个验证
- [x] 1.3 MCP initialize 探针（wgk 头 POST initialize）过一遍端点
- [x] 1.4 设备流缺口核实与处置（Logto 应用注册或文档诚实记录）
- [x] 2.1 实证记录回填 docs/ecosystem/*.md（五家各一节）
- [x] 2.2 OSS 快照推送；#/docs 若需则 facet 滚
- [x] 3.1 归档+路线图 F2.1 ✅+记忆

## 验收实证（2026-10-12 本机真环境）

- connect 真链路：console 会话+CSRF（/api/auth/csrf-token）铸 wgk 键（platformtest）→
  验活 0600 存储、4 可见 server 打印。
- 五 target install --write-mcp 全跑：7 技能/家落位；配置形状逐字节核对
  （.claude.json type/http、.cursor/mcp.json 无 type、zconfig mcp.servers 共存、
  settings.json httpUrl、config.toml [mcp_servers.*]+http_headers）。
- wire 握手：POST initialize（双 Accept）→ 200+serverInfo(fd-cn-report v3.4.7)+
  Mcp-Session-Id——wgk 键全链（safeline→caddy→registry nginx→auth mcp-proxy→mcpgw）通。
- 三个真缺口入档（诚实边界写进五份指南）：①fd-daas/fd-open-data 的 registry nginx
  location 块当前被注释（server 停用/不健康→405，运维项）；②设备流 client_id
  facet-cli 未在 Logto 注册（400）；③探针双 Accept 要求。
