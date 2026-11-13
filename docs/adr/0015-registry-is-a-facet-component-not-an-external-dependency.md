# Registry is a facet component, not an external dependency

自部署的 mcp-gateway-registry（第三方 OSS + 自家 fork 补丁，`mcp.finddatatech.cloud`）被壹座 MCP 市场、pack deploy、agent-runner 与萬星门面四方消费，此前在架构叙事里是"外部依赖"。谦面（facet）作为独立资源面平台成立后，registry 归屋为谦面的组件——谦面负责其运营与用户面聚合，语义即 CONTEXT.md 的「注册处」；runtime-source 关系不变（ADR-0004），runner 仍归萬星运行面从它取活。

## Considered Options

- **引用**（保持外部依赖）：谦面的核心能力（MCP 目录、运行时分发）就缺自己的底座，"资源面平台"叙事不成立——弃。
- **归屋**（本决策）：管理面与 UI 归谦面；软件不重写（继续 OSS + fork 补丁）。
- **重写**（自研替换合并进谦面单服务）：迁移风险与成本 v1 不值得，仅当 OSS 约束实际咬人时再启——推迟。

## Consequences

- v1 域名与消费者配置不动（cells 的 `REGISTRY_URL`、runner、萬星门面照旧）；域名迁移与 GitOps 重组是 v2 单独变更。
- 消费者最终（v2 域名迁移时）会把 registry 类配置重指谦面管理面。
