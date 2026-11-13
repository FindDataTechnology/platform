# add-ecosystem-bridge

## Why

谦面目前只是自家运行时的店面：店里只有自有内容（6 个自有 MCP server、152 条自有技能），外部编辑器用户虽有 CLI 但连接体验半自动（手工到控制台铸 key、CLI 刻意不写 MCP 配置），出向消费不计费。与此同时开源生态的技能包格式与 MCP 已行业标准化、免费可取，而我们的数据 MCP（law-bench、fd-open-data、fd-cn-report）独占却分发面窄。分发层已成商品，谦面的价值应转为**双向桥**：入向吃开源生态把预设做厚（开源素材为填充、自家数据为锚），出向把自家资产送进任意 AI harness 并账实闭环计费——做窄腰，不赢市场品类。

## What Changes

- **入向精选管线**：开源 MCP server 与技能经人工审校（runbook checklist：安全/许可证/质量三轴）入库；开源 server 由我们托管（复用现有 server 模式：cheap 节点容器 + tailnet NodePort + 注册处代理），逐 server egress 白名单、零平台凭据注入；开源技能走注册处技能目录既有渠道、带来源与许可证标记；只开「精选」档，不设社区直灌。
- **出向 CLI 升级**：安装目标扩到 zcode / codex / gemini-cli（claude-code / cursor 已有）；新增 `facet connect` 铸键走查（v1 网页铸造+粘贴，device flow 免粘贴随后），持键后 CLI 可写各 target 的 MCP 连接配置（放宽 facet-editor-cli 的 v1 不写约束）。
- **Claude 市场端点**：谦面生成 `.claude-plugin/marketplace.json` 格式的公开端点，Claude Code 用户 `/plugin marketplace add` 一条命令进店；仅含公开且精选的 pack，MCP 以连接指引出现、不进 plugin 本体。
- **出向计费闭环**：外部 harness 消费生态 MCP 走 wire 线计量 + 调用键月度免费额度（5k 调用/月起步，超额预检 402）；wire 线收尾两件（sub2api 入账管道、账本硬停）并入本版。
- **社区准入**：Logto 公开自助注册，community 组默认只挂 fd-open-data-mcp 与 fd-cn-report（只读）；law-bench 归付费档。
- **A2A 车道不动**：萬星既有按量结算维持，不并轨；本版只补对外文档与示例。

## Capabilities

### New Capabilities

- `ecosystem-curation`: 开源素材（MCP server、技能）的精选审校门、托管隔离姿态、来源与许可证标记、白名单治理。
- `ecosystem-access`: 外部开发者自助注册、community 默认可见面、付费档边界与自助调用键。

### Modified Capabilities

- `facet-editor-cli`: 安装目标从两家扩到六家；新增 connect 铸键走查与 device flow；持键后允许写各 target 的 MCP 连接配置（原「v1 不写 MCP 配置」约束按此放宽）。
- `pack-marketplace`: 新增 Claude 插件市场格式的公开清单端点（仅公开精选 pack）。
- `platform-billing`: 新增生态 MCP 消费的按调用键计量、月度免费额度与超额预检拒绝。

## Impact

- **代码**：`facet/`（CLI targets + connect + marketplace.json 端点）、注册处 fork 谱系 fd 线（wire 线收尾两件；OAuth 发现视探查成本定 v1/v2，见 design gate）、Logto 配置（公开注册 + community 组 + 付费组）、cheap 节点托管面（精选 server 容器）。
- **壹座侧近零改动**：生态技能走注册处技能目录既有渠道，安装/单装机制复用。
- **依赖**：Claude 插件市场清单格式、wgk- 调用键机制（已上线）、sub2api admin API、额度预检（已上线）。
- **风险**：ADR-0017「生态漂移被接受」条款被入向开源 server 触发——需核 fd-1.32 代理行为对当下主流 streamable-HTTP server 的兼容性；开源 MCP 的 AGPL/非商用许可证地雷（逐个过白名单）；跨产品线改动面大（fork 谱系 + Logto + 托管面），切片推进。
