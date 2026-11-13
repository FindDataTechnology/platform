## 1. 门序列收敛（design D1）

- [x] 1.1 从 `gateway/packs.js` publish 路由抽出共享纯读 verdict 收集器 `collectPublishVerdict`（manifest-required → 结构限额 → files 门 → 工具声明门），验证：既有 packs 路由单测全绿（`test-pack-marketplace` 8/8、`test-pack-files-market` 3/3、`test-publish-tool-gate` 11/11）
- [x] 1.2 publish 路由改为消费收集器并按原顺序回放 status code / 响应体（`shortCircuit: true` 保住"拒绝不做 registry 往返"的既有性质），验证：既有 publish 测试逐字节通过 + parity 语料对拍（`test-pack-validate` 8/8）

## 2. validate 路由（design D2 / D3 / D6）

- [x] 2.1 新增 `POST /api/packs/validate`，挂同一 `express.json({ limit: jsonLimit })` 与同一 auth 链，验证：匿名请求得到与 publish 同形的 401（测试断言两体 deepEqual）
- [x] 2.2 实现信封体 `{ valid, errors[], caller: { publishEligible, reason? } }`，非创作者不拒绝而是 `publishEligible:false` + `reason:"Creator group required"`（复用 publish 403 原文），验证：创作者/非创作者两例单测 + 资格话术与 publish 403 原文相等
- [x] 2.3 全量收集语义（不早退），验证：一个同时违反限额 + files 门 + 工具门的 manifest 一次返回三项 errors，各项含 publish 对应标记（`code:"pack-files-disabled"`、`toolGate:true`），且 publish 对同 manifest 的响应体等于 validate 的第一项
- [x] 2.4 packId 续版只读检查（不存在 → "Pack not found"，非作者 → "Only the pack author may publish new versions"），验证：单测断言判词原文、与 publish 403 相等、且版本表无新增行

## 3. 限流分离（design D4）

- [x] 3.1 validate 不触碰 `publishAllowed` 预算，验证：15 次 validate 后无 pack 落库，随后 10 次 publish 全 200、第 11 次 429（预算完整）
- [x] 3.2 独立 per-caller 软上限（`PACK_VALIDATE_RATE_MAX` / `PACK_VALIDATE_RATE_WINDOW_MS` 可调，默认 120/h），验证：`RATE_MAX=2` 时第三次 validate 429 且文案含 validation，同作者 publish 不受影响

## 4. parity 与副作用护栏

- [x] 4.1 parity 语料单测：8 例双端对拍（结构超限 ×4、工具门 ×2、files 门、manifest-required），另加 registry 503 fail-closed 与匿名 401 两例，断言 publish 的 4xx/503 响应体逐字出现在 validate `errors` 中，验证：`test-pack-validate` 全绿
- [x] 4.2 副作用断言：同一 manifest 重复 validate 后无 pack/版本落库，验证：测试通过（15 次 validate 后 `registry.list().total === 0`）
- [x] 4.3 顺手修正 `lib/publish-tool-gate.js` 既有日志 bug（`missing.length - stillMissing` 漏 `.length`，注记恒 NaN），验证：测试输出显示真实计数

## 5. 回归、交付与生产眼见

- [x] 5.1 全量单测 + 相邻 packs 路由回归（14 套 117 项绿；全量 `npm run test:unit` 结果另记）
- [x] 5.2 `openspec validate` 绿 + design.md 回写实施期细化（shortCircuit / packId 顺序 / 形状容错 / NaN 修正）
- [x] 5.3 出片滚产（`fd-build-channel` 判路 → 公开仓免费线 → hkccr → relay → ccr → ArgoCD），验证：image run `38904625661` 绿 447s（四道烟测门）、relay OK 21:09:13、skopeo ccr digest `3631feb2` 实证、fd-infra-deploy `6ce7d05` 三清单（platform/platform-demo/**facet**）rollout 全绿
- [x] 5.4 生产眼见四例：匿名 401（与 publish 逐字节同形）、创作者 200 信封 `valid:true`、非创作者 200 + `publishEligible:false`、**parity 对拍**（非法 manifest 上 publish 400 body === validate `errors[0]`），验证：证据记入台账 `docs/registry-maintenance.md` §12.5
- [ ] 5.5 向 finddata 侧成对 change（facet-market-mcp `market_pack_validate` 工具 + 「谦面工坊」pack）交接路由契约（信封形状、`reason` 原文、全量收集语义、独立限流），验证：对端 change 的 design 引用本契约

## 边界与前置（非本 change 任务，记录备查）

- infra 第零步（范围外，阻塞工坊发布）：`airegistry-tools` 路由修复（GitOps 补 Service）、
  快照回填 7 工具、mcpgw 凭据姿态核验（静态令牌 → 调用者 bearer 转发）、扫描自动下线雷。
- finddata 侧：`market_pack_validate` 工具与「谦面工坊」pack 内容（独立 change）。
