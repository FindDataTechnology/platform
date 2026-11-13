# Tasks — fix-fleet-workspace-hygiene

## 1. 渲染与接线

- [x] 1.1 `renderWorkspaceHygiene(stat)`：纯函数；KB/MB 取整规则；无自己的往轮文件时不写「0 个」；说明重复/过期/预算代价
- [x] 1.2 巡逻尾段拼接：有读数追加一行，无读数逐字节不变；边回合不带
- [x] 1.3 `server.js` provider：`readdirSync` + `statSync` 只算顶层，60s 缓存，任何失败返回 null

## 2. 测试（`scripts/test-fleet-workspace-hygiene.mjs`，7 条）

- [x] 2.1 纯函数四条：空/坏输入 → null；小目录 1KB 下限不出现 0.0；大目录 MB 一位小数；无往轮文件不写 0
- [x] 2.2 这一行必须说清代价（重复/过期/扣预算）
- [x] 2.3 接线：有 provider 出现、无 provider 不出现、空目录不出现
- [x] 2.4 接线：edge 回合不带该行
- [x] 2.5 反证：去掉注入 → 接线用例红；装回 7/7 绿
- [x] 2.6 邻接：`test-fleet-report-lane`(44) / `test-fleet-descendant-reports`(4) / `test-fleet-decision-lane`(10) / `test-fleet-memory`(7) 全绿

## 3. 规格

- [x] 3.1 `agent-fleet-report-lane`：MODIFIED「巡视上下文注入」+ 3 个场景

## 4. 上线

- [x] 4.1 快照 d2bd68b → GHA image ✅ → relay OK 4s → digest `sha256:c0368fad` → GitOps 18885c8 →
      ArgoCD 对齐 → platform/facet 滚完 → **舱内 7/7 绿**；并以真实 cell 工作区验证渲染输出
      （325 文件 / 3.2 MB / 自己的往轮 59 个）
- [x] 4.2 归档（`openspec validate --strict` 通过后）
