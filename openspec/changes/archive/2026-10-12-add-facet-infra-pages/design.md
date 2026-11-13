# Design: add-facet-infra-pages

## Context

数据面已在注册处（见 proposal Why 的摸底）：server 条目带 `license`/
`provider_organization`/`tool_list`（工具对象含 name+description）；skill 条目带
`repository_url`/`author`/`tags`/`metadata.extra`。桥（`registry-bridge.js`）与 facet
路由（`facet/mcp-catalog.js`）目前把这些字段裁掉了，只透出 6 个卡片字段。注册处
零改动。

## Goals / Non-Goals

**Goals**：三个面（MCP 卡片+深度、skills 目录、基建叙事）在谦面域闭环；深度载荷惰性；
无字段如实标注。

**Non-Goals**：不改注册处；不做工具调用示例的「试跑」（只读展示，运行试跑是后续线索）；
不做 skills 的安装动作（安装面仍属壹座/客户端 CLI）。

## Decisions

1. **深度载荷走新只读端点**（如 `/api/mcp-catalog/:name`）：卡片列表保持现有形状
   （6 字段），深度端点才带 toolList/provenance——列表不进默认载荷（spec 已锁）。
2. **桥映射保留字段而非重取**：`mapServer` 加 `license`/`providerOrganization`/
   `toolList`（已有）/`numTools`；`mapSkill` 加 `repositoryUrl`/`author`/`tags`。
   registry-bridge 的 marketSnapshot 已按 TTL 刷新，零额外请求。
3. **skills 路由复用同一条可见性规则**：`listVisible` 的组过滤逻辑对 skills 同样适用
   （groupsFor("skills", name) 已在映射里），一条过滤函数服务两面。
4. **视图内切换而非新 hash**：深度视图在 `#/mcp` 内以选中态切换（卡片→详情返回），
   不新增顶层 hash——壳的 hash 表不动，spec 已锁「depth views stay inside the mcp hash」。
5. **生态标注复用既有 tags**：注册处 server 的 `tags` 含 `ecosystem`/`official` 标记
   （生产实证：eco-mcp-fetch 带 ["ecosystem","official"]）；无标记的条目按
   provider_organization 与 tags 推断展示，不编造。
6. **i18n**：新 UI 文案五语齐（`check-locales.js` 门）。

## Risks / Trade-offs

- [tool_list 快照陈旧] → 深度页如实显示捕获时间/无快照标注；补齐走既有
  `refresh-registry-tool-list.mjs`。
- [180 技能列表体积] → skills 目录分页或客户端搜索（照 packs 目录先例：分页+当前页
  过滤），不一次全量渲染。
- [可见性泄漏] → 深度端点必须复用同一 viewer 过滤（不能只按 name 查），组门控条目对
  无权者 404（照 packs 私有包姿态）。

## Migration Plan

无数据迁移。部署 = 常规镜像滚动（platform/facet 同镜像双角色，facet 服务承接新路由）；
回滚 = revert 即回旧卡片面。

## Open Questions

（无——分页尺寸与叙事文案措辞属实施自由度。）
