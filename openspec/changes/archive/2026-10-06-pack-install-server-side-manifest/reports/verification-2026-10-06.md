# pack-install-server-side-manifest — 发版与活链复验记录（2026-10-06 晚）

## 发版链

| 环节 | 结果 |
|---|---|
| 提交 | `eeb689e`（CI 解锁：main 既存 lint 13 errors + pack-skill 守卫放行 fd-legal-search-mcp）+ `01e5c6e`（change 本体） |
| CI（GitHub Actions，fast 项目全量） | **全绿**：lint → typecheck → unit → locales → web:build(e2e seam) → **E2E fast 全过**（含 packs 新用例 4 条：短表安装/私有身份/取包失败零写入/双形态等价） |
| 镜像 | image.yml run 37470361059 success → `hkccr → cheap-3 relay → ccr`，`ccr.ccs.tencentyun.com/yizuo/platform:sha-01e5c6e` 已验证可拉 |
| 三清单同滚 | fd-infra-deploy `c0e4f9c`：platform / platform-demo / facet 三处 → sha-01e5c6e；ArgoCD 同步（operationState=Succeeded），三 pod 均 Running 新镜像，`/app/server/pack-manifest-source.js` 在镜像内核实 |

## 活链复验（真实浏览器，platform.finddatatech.cloud，已登录会话）

1. **数据-自助分析** `50Tp176hW0HYTTWXZbarKA` v1（此前 100% 被雷池 SQLi 规则连接重置）：
   - Pack Market → 详情 → **Subscribe & Install → 成功**，安装回执 8/8 技能 Installed；
   - My Packs 出现 v1（8 技能清单可见）。
2. **数据-指标工坊** `oGURb41bdyAotVGOeBHZUA` v1（此前因 `<script` 403）：
   - 同路径 **Subscribe & Install → 成功**，安装回执 5/5 技能 Installed；My Packs 出现 v1。
3. **磁盘对账**（`kubectl -n fd-prod exec deploy/platform`，cell `1da519d4c1c0bf89`）：
   - `data/custom-skills/packs/50Tp176hW0HYTTWXZbarKA/` → 8 目录，**SKILL.md ×8**；
   - `data/custom-skills/packs/oGURb41bdyAotVGOeBHZUA/` → 5 目录，**SKILL.md ×5**。

## 途中处置的发布阻塞（与本 change 无关但同日发生）

- main 上 CI 因两处**既存**红灯卡死（lint 13 errors + 单测 pack-skill 守卫未放行 fd-legal-search-mcp），e2e 根本到不了——已在 `eeb689e` 清零。
- **TCR 个人版 tag 配额**：yizuo/platform（hk+ccr）满 100 后所有 push 被拒（`tag has reached its limit(100)`）；**v2 API 删除（skopeo delete 按 digest 真删，digest 404 实证）不释放配额**，2h 后仍拒；**控制台删除才回收**（用户清理后 hk/ccr 均 200）。已保留 main + 近期 sha- 锚点；其余旧 tag 清至 ~10。relay 期间一直在对满仓 FAIL（日志可见），清理后自愈。

## 遗留

- 无。既有 packs 的升级/卸载路径未动（本次只换 manifest 来源）。
