# add-vendor-supply-open · Design

## Context

现状关键事实（摸排锚点）：

- 发布资格判定单点在 `gateway/packs.js:1039-1045`（`mayPublish = accessMode==="open" || isCreator`），creators 组配置在 `facet/index.js:85`。
- registry 是外部自托管 fork（cheap-8，`mcp.finddatatech.cloud`），fork 纪律见 `registry-lineage` spec；本仓对其只有读（`registry-bridge.js`）与 agent 部署写（`lib/agent-serving.js`）。MCP 上牌 = 运维手工 `POST /api/servers/register` + toggle（`servers/fd-health-mcp/README.md:36-44` 实证）。
- 工具面闭包校验在 `lib/publish-tool-gate.js` + `registry-bridge.js:234-265`（`metadata.surface.commercial_tools`）；发布门对非在册 server 有 local-binding 豁免、安装层硬拒——语义断层本单只记观察不动。
- 同名包 409 先例：`facet/publish-gate.js`（pre-route 模式）。

## Goals / Non-Goals

**Goals:**
- vendor 主体「注册即得」且能力闸与归属分离：组/绑定表管资格，档案管署名/配额/收益归属。
- 供方上牌全程仓内 workflow 闭环，registry 侧改动控制在最小（仅启用受控写入通道），不建供应商直触面。
- 车主发布门对 vendor 不松不降：同一 manifest 校验、同一闭包闸、同一速率限。

**Non-Goals:**
- 分成账本/结算（`add-market-revenue-share`，本单只落收益归属骨架字段）。
- registry fork 的自助门户、外部 MCP broker 生态（workflow 形状预留，不实现）。
- registryName 校验语义断层修正（记观察项，四闸对外语义逐字节不动）。

## Decisions

- **D1 资格判定以平台绑定表为准，Logto 组作通行证同步而非运行时依赖。** 注册即得 = 平台表 `vendor_profiles` + `vendor_members`（主体-账号绑定）落行即生效；发布资格判定改为 `isCreator || hasActiveVendorBinding`。Logto `vendors` 组的写入通过既有组同步通道作为展示/互通标记，不做运行时强依赖——避免发布路径引入对 Logto management API 的调用。备选（组即唯一事实源）被否：组变更需要管理面写权限且判定链变长，与「组决定能力 + 平台表管归属」的四闸先例不一致。

- **D2 上牌=平台 workflow 代客写入，registry 仅小改开受控通道。** gateway 新增 onboarding 路由族（提交材料→审查状态机→selfcheck 执行→调 registry register/toggle），registry fork 侧仅需确认/启用 `POST /api/servers/register` 的受控启用（现默认 disabled），凭据走 `registry-credentials`/`MARKET_REGISTRY_TOKEN` 既有轨道。备选（registry fork 加自助门户）被否：跨仓大改、违反「registry 内部使用」的用户裁决（2026-10-27：以后接入外部 MCP 很可能，但当前不自建门户）。

- **D3 双形接入从 day one 同轨：vendor-hosted 与 platform-hosted。** vendor-hosted 只声明 reach 端点与出站姿态材料；platform-hosted 沿用 `ecosystem-curation` 的 per-server egress posture 容器模式。审查轴两形公共（主体/许可证/工具面闭包），仅托管落实步分岔。这样未来「接入外部 MCP」只是第三种材料变体，workflow 车道不换。

- **D4 供应商署名=服务端投影，manifest 不承载署名声明。** 发布时发布者仅可声明归属主体 id，网关校验绑定后从档案取公开署名落条目；呈现时取当前档案值。理由：manifest "SHALL NOT carry author-controlled identity claims" 的既有纪律延伸到署名，杜绝任意冒名。备选（manifest 内 vendors 字段）被否：可被任意伪造且与不可变版本冲突（署名更新会污染历史版本语义）。

- **D5 审查状态机最小化：submitted → in-review → onboarded | rejected(axis)。** 状态流转只由系统动作（自检完成/审查结论）与供应商动作（提交/撤回/重提）驱动；rejected 必须带轴（材料不全/许可证/配额/声明闭包/商业集）。状态对供应商全程可读，与台账一致。

## Risks / Trade-offs

- [注册即得被滥用：批量注册主体占名/刷上架] → 主体名全局唯一 + 配额档（名下 server/发布物数量）+ 既有发布滥用控制（rate limiter）对 vendor 同轨；收益归属字段与分成账在分成单结算时再收紧。
- [registry fork 改动失控] → fork 侧改动清单进台账并遵守 `registry-lineage` 的「只增不改/换版可回滚」纪律；workflow 对 registry 不可用如实降级（重试+挂起在途上牌单，不伪造在册）。
- [selfcheck 对 vendor-hosted 外网 server 不可靠（超时/偶发失败）] → selfcheck 独立预算与重试（沿用 fleet 采样超时独立预算先例），失败归入「声明不全/不可达」分类而非静默放行。
- [vendor 绑定与署名投影的一致性] → 呈现时读档案当前值；条目行只存绑定关系 id，不缓存署名文本，避免档案更新后的陈旧署名。
- [PACK_ACCESS_MODE=open 与 vendor 资格的关系读者混淆] → spec 明确：open 模式任何已认证用户可发（无归属署名可用），closed 模式 admission = creators ∪ 绑定 vendor；两者并行不悖。

## Migration Plan

1. 落表：`vendor_profiles`（主体名唯一索引、公开署名、联系凭据、配额档、收益归属字段）、`vendor_members`（绑定+角色+审计）、`vendor_onboarding`（状态机+材料+台账行）——gateway 库迁移，沿用既有 migration 模式。
2. 发布资格判定改造（`gateway/packs.js:1039-1045` 单点）+ 署名投影，向后兼容：无 vendor 绑定时行为与现行逐字节一致。
3. onboarding 路由族 + selfcheck 执行器 + registry 写入适配（复用 `registry-bridge` token 轨道）。
4. 暴露面：facet/壹座市场端本单不要求新 UI（API 先行，console 写作面沿用既有 manifest-publish 流 + 归属声明参数）。
5. 回滚：资格判定回单点 creators 判定即恢复现行语义；onboarding 表可停写保留（台账语义不删）。

## Open Questions

- vendor 配额档的分档数值（server 数上限/发布物上限）——商业侧定档即可，不阻塞本单 task 切分（默认档先行）。
- registry fork 侧 `register` 端点启用的运维窗——与 cheap-8 部署节奏协调，排任务时留外部依赖标记。
