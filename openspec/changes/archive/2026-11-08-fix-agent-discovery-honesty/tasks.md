# Tasks — fix-agent-discovery-honesty

## 1. 共享定义（`server/agent-discovery.js`，新增）

- [x] 1.1 `searchAgentsView({ all, search, limit })` → `{ agents, total, truncated }`
- [x] 1.2 确定性排序（名称 → id），与 catalog 扫描顺序无关
- [x] 1.3 `limit` 默认 8 / 上限 50 / 非法与 ≤0 回落默认
- [x] 1.4 `formatSearchAgentsText`：截断写「showing N of M matches」+ 收窄/分页提示

## 2. 两个面接同一处

- [x] 2.1 `server/routes/delegation.js` 的 `/agents` 改用 `searchAgentsView`（保留 facade 收窄）
- [x] 2.2 `server/delegation-mcp.js` 的 `search_agents` 改用 `formatSearchAgentsText` + 可选 `limit` 入参
- [x] 2.3 工具描述说明「页被截断会明说」

## 3. 测试（`scripts/test-agent-discovery-honesty.mjs`，6 条）

- [x] 3.1 截断说出真实匹配数（8/12、truncated=true）
- [x] 3.2 未截断 `truncated=false` 且 total 等于条数
- [x] 3.3 `limit` 放大与上界（20→12；999→50；0/abc/-3→默认 8）
- [x] 3.4 顺序确定：同一集合反序输入得到同一页
- [x] 3.5 空关键词列前 N 仍报真实总数；零匹配为空
- [x] 3.6 工具文案：截断页写「showing 8 of 12 matches」，未截断写真实条数
- [x] 3.7 反证：把返回体改回 `{ agents }` → 4 条红（计数与限幅），装回 6/6 绿
- [x] 3.8 邻接：`test-agent-delegation-a2a`(11) / `test-fleet-delegation`(25) / `test-principal-facade`(1) /
      `test-wanxing-facade`(35) / `test-facade-matters`(4) 全绿

## 4. 规格与文档

- [x] 4.1 `agent-delegation-a2a`：MODIFIED「Discovery is two-level」+ 3 个场景
- [x] 4.2 路线图 P2-2 / P2-3 / P2-9 按代码证据改正（早已修，文档陈旧）；P2-6 收窄为「无取消 run + spanMax 只 warn」

## 5. 上线

- [x] 5.1 快照 e4d4b3a（并发会话产出，树内 grep 验证含本提交）→ GHA image ✅ → relay OK 4s →
      skopeo digest `sha256:76c03948` → GitOps 914cd1f → ArgoCD 对齐 → platform/facet 滚完 →
      **舱内跑本套件 6/6 绿**
- [x] 5.2 归档（`openspec validate --strict` 通过后）
