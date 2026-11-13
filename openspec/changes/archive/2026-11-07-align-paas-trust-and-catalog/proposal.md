# Align two paas specs with the shipped trust/catalog wiring

## Why

体检增量对账 backlog（optimize-paas-module-audit N-2/N-4/N-6）中三处 spec 漂移，逐条核现文后确认两条属实且可纯文本修：

1. **registry-market-deployment（N-6）**：spec 仍把「`REGISTRY_URL` 直喂 + `MARKET_REGISTRY_TOKEN`」写成部署接线真源；生产 `platform.yaml:104-118` 已切 `FACET_CATALOG_URL`+`FACET_CATALOG_TOKEN`（add-supply-catalog-unification），`registry-bridge.js:37-55` 明确「facet 配置时直喂仅作弃用窗口回退并高声告警，两者并存 facet 胜出」。按 spec 对账生产必得出错误结论。
2. **forward-auth（N-4）**：spec 用「non-exempt」一词带过豁免面，但 `server/auth.js:40-96` 的 `AUTH_EXEMPT_PREFIXES` 已扩到 19 条（小程序登录、bot webhook/relay、app 配对、chart 静态资产、loopback 内部 cron 桥等）。每扩一条都是新信任边界，需要台账纪律。

**核过未动**：`cron-module` 补跑条款、e2e-testing 反向条款、zhiyu-im-bridge 路径笔误、vertical-packs 权威指针均已被 align 批 90acfaf10 修掉（教训：审计卡是快照，改前必须核现文）。

## What Changes

- `registry-market-deployment`：首条 Requirement 按 facet 统一目录读路径改写（保留弃用窗口/回退语义，场景名不丢）。
- `forward-auth`：「Documented trust boundary and scope」补豁免清单台账要求 + 一个新场景。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `registry-market-deployment`：部署接线口径 MODIFIED。
- `forward-auth`：信任边界 Requirement MODIFIED。

## Impact

- 仅 spec 文本；代码零改动。
