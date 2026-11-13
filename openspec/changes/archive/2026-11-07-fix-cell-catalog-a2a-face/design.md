# Design: fix-cell-catalog-a2a-face

## D1 · 根因与「为什么是补拉而不是换面」

`registry-bridge.js` 的源选择（:51-55）：`FACET_CATALOG_URL` 在 → `doFacetRefresh`（只拉 `/api/mcp-catalog` + `/api/skills-catalog`）；`agentSnapshot` 只有 legacy `doRefresh` 会填 → facet 模式下永远空数组 → cell merged catalog 无 a2a 条目 → `resolveTarget` a2a fallthrough `alive=false` → 全部 a2a 岗 vacant。

生产可读性实况（新镜像 pod 内实测）：registry `/api/agents?limit=100` 带 `MARKET_REGISTRY_TOKEN` 返回 41 agents / **29 a2a enabled**；`mapAgent` 的 `pathToName` 产物（`registry-packs-<packId>-<agentId>[<suffix>]`）与 fleet_members 存量 targetId **逐字吻合**——补拉即自动重新挂接，零迁移。

修法取「facet 源补拉 agents」而非「legacy 全量回切」：mcp/skills 的 facet 投影（gateway configTemplate、requiredGroups、annotations）是 unified 之后的既得契约，不回退；agents 是独立物种，best-effort 并入 facet 刷新即可。

## D2 · 实施形状

```js
async function doFacetRefresh() {
  // mcp + skills（不变，失败照旧 throw → last-good 整体）
  ...
  marketSnapshot = { mcpServers, skills };
  // agents（新，best-effort 独立降级）：registry agents leg 是 cell 目录的
  // a2a 面（agent-catalog spec 既有要求），facet 投影不承载它。
  try {
    const agentsList = await fetchAllPages("/api/agents");
    agentSnapshot = agentsList.map(mapAgent).filter(Boolean);
  } catch (err) {
    console.warn(`[registry-bridge] facet agents fetch failed (keeping last-good): ${err.message}`);
    // agentSnapshot 不动——保 last-good，与 mcp/skills 的失败语义对称
  }
  const sig = ... // 不变（只看 mcpServers/skills，agents 不进 market 广播）
}
```

- `fetchAllPages("/api/agents")` 走既有 `fetchJson`（`REGISTRY_URL`=`MARKET_REGISTRY_URL`||`REGISTRY_URL`、`REGISTRY_TOKEN`=`MARKET_REGISTRY_TOKEN`）——生产 pod 两者都有（实测 200）。
- `REGISTRY_URL` 为空（纯 facet 无 registry 的部署形态）→ `fetchJson` 打空 URL 必失败 → 走同一 warn 分支保 last-good（诚实：该形态本无 agents 面）。
- `mapAgent` 既有过滤（`!a.path || is_enabled===false` → null）照旧。

## D3 · 独立降级语义（与既有纪律对称）

| 面 | 失败时 | 依据 |
|---|---|---|
| mcp/skills（facet 投影） | 整体 throw → last-good 两者 | 既有 |
| agents（registry 腿） | 单独 warn → last-good agents | 本案新增，与 spec「Registry outage does not clear the catalog」同形 |

`market_changed` 广播仍只看 `{mcpServers, skills}` 签名——agents 变化静默生效（`merged()` 每次请求重读 `agentSnapshot`，无需广播）。

## D4 · 复活的连锁面（验证判据）

1. `/api/catalog` 出现 a2a-mode 条目（含 gateway-route url）；
2. 既有 vacant a2a 岗复活：`resolveTarget` alive=true、formation.members servingPath 非空（O8 的解析就位）；
3. member-add 枚举恢复 a2a 目标；
4. O8 召唤计划：servingPath 候选出现；对不齐 facet 台账行的（萬星面部署）仍诚实排除——**O9b 账本归一是显式 Non-Goal，待用户拍板**；
5. 正路径真机钥匙：`pack-demo-fingpt`（registry a2a enabled + 本平台 facet 台账唯一行）——部署一支验证舰队即可完成 O8 4.3 的 summonable 非空判据。

## D5 · 测试

`scripts/test-supply-catalog-yizuo.mjs` 的 facet 渠道桩扩展 `facetResponses`：registry `/api/agents` 应答 + `REGISTRY_URL` 恢复设入 env（该文件当前 `delete process.env.REGISTRY_URL`——需改设，因为它现在是 agents 腿的合法 base）。断言：
1. facet 刷新后 `getAgentEntries()` 非空、a2a 条目 url=`{REGISTRY_URL}/agent<path>/`；
2. agents 拉取失败（401/网络）不影响 mcp/skills 刷新成功、agents 保 last-good；
3. agents 变化不触发 `market_changed`（广播签名不含 agents）；
4. mcp/skills 失败时 last-good 覆盖 agents（既有用例扩展）。
