# Tasks — drop-external-market-door

- [x] 1.1 `web/src/pages/AgentMarketPage.tsx` 删除 `agent-market-open` 外链与其未用 import；验证：`grep -n "agent-market-open" web/src` 为空，typecheck 绿
- [x] 1.2 保留并复核 `agent-market-studio`（facet Studio）链接与 `studioHref()` 形状；验证：链接仍指向 `STUDIO_ORIGIN/#/studio`
- [x] 1.3 更新 `e2e/agents-tabs.spec.js`：断言外站市场门不存在、Studio 门存在；验证：该 spec 绿
- [x] 1.4 复跑 `e2e/ia-doorways.spec.js`（市场双 tab、`/packs` 透传）；验证：绿
- [x] 1.5 `npm --prefix web run typecheck` + `npx biome check` + `openspec validate drop-external-market-door --strict`；验证：全绿
