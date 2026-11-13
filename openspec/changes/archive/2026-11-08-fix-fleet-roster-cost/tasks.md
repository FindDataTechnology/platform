# Tasks — fix-fleet-roster-cost

## 1. 名册视图

- [x] 1.1 `server/fleet-turns-view.js` 增 `shapeFleetRoster(fleets)`：六字段投影、默认完整、上限 200、回带 count/total/truncated
- [x] 1.2 `fleet-architect-mcp.js` 的 `fleet_list` 改用该视图 + 紧凑 JSON

## 2. 测试（`scripts/test-fleet-turns-view.mjs` 追加 3 条）

- [x] 2.1 57 支舰队全部下发、只六字段、重字段不出现、truncated=false
- [x] 2.2 超上限：条数封顶 + total 真实 + truncated=true；空/坏输入安全
- [x] 2.3 定量：同一份名册紧凑输出 < 美化输出的一半
- [x] 2.4 反证：退回旧形态（返回原数组）→ 3 条全红；还原 6/6 绿

## 3. 规格

- [x] 3.1 `agent-fleet-architect`：工具面名册条款 + 2 场景

## 4. 上线

- [x] 4.1 快照 6f121f5 → GHA ✅ → relay OK → digest sha256:7e4a27dd → GitOps 5c23c77 → ArgoCD →
      platform/facet 滚完 → **舱内 6/6 绿**（现网基线 a4b4e00bd ⊂ 我的快照基线且无独有提交）
- [x] 4.2 归档（`openspec validate --strict` 通过后）
