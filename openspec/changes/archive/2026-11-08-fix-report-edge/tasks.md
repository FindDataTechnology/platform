# Tasks — fix-report-edge

## 1. 派生（`server/fleet-orchestration.js`）

- [x] 1.1 `expandedEdges` 为每个有 `parentId` 的岗位生成 `{kind:"report", from: 岗位, to: 上级, derived:true}`
- [x] 1.2 方向按 UI 语义：`from` 是报数方（子），`to` 是接收方（上级）
- [x] 1.3 已声明同向 report 边时不重复派生
- [x] 1.4 `orchestration: null` 幂等（原默认参数只覆盖 undefined）

## 2. 校验

- [x] 2.1 声明 report 边时校验 `reporter.parentId === e.to`
- [x] 2.2 矛盾 → 结构化拒绝，文案给出真实上级
- [x] 2.3 一致 → 通过（不落重复边）
- [x] 2.4 头注释纠正（原先写"trigger/report 都是既有机制的图形态"，report 现在是树的投影）

## 3. 测试

- [x] 3.1 新套件 `scripts/test-report-edge-derived.mjs`（5 条）：派生两条、根无报数边、
      一致声明不重复、矛盾声明拒绝并指名真上级、report 边不授予派发
- [x] 3.2 既有 `test-fleet-orchestration.mjs` 的"合法边"用例：把 `b` 的 `parentId` 设为 `a`，
      使其 report 声明**为真**（原来那条断言在描述一个不存在的拓扑）
- [x] 3.5 模板路径（`server/fleet-template.js`）：投影成员时带上 `parentId: parentRef`——
      模板用 `parentRef` 表达上下级，不带就等于把树抹平，官方种子 `content-factory-fleet` 的
      真声明会被误判为假。**反向证明**：去掉这一行 → `test-fleet-templates` 红；恢复后 20/20
- [x] 3.3 **反向证明**：删掉派生循环 → 3 条红；关掉校验分支 → 1 条红；恢复后全绿
- [x] 3.4 相邻套件：orchestration 18、core 22、delegation 25、architect 11

## 4. 门禁

- [x] 4.1 `npx biome check server/fleet-orchestration.js scripts/test-report-edge-derived.mjs scripts/test-fleet-orchestration.mjs` 绿
- [x] 4.2 `openspec validate fix-report-edge --strict` → `is valid`
- [x] 4.3 全量逐文件扫（每文件 100s 超时，隔离克隆内）：439 文件 / **3938 条、3936 绿 / 2 红**；
      两红均为并发线既有（`pack-cell` 的 registry→market 文案、`supply-store-migrate` 的 dual-read
      退出码），在**不含本 change 的远端线**上同样红

## 5. 上线

- [x] 5.1 出片滚版 → 已在产（快照取自远端线 a874caa75 → GHA `sha-18d0c79`，digest `sha256:2d1210d4`，
      relay OK 11:15；fd-infra-deploy `e9c2134` 双 bump → ArgoCD 75s → 两 rollout 完成；
      镜像内确认 `derived: true` 与 `parentId: m.parentRef` 均在）
      ⚠️ 镜像内 `test-fleet-templates` 的种子断言跑不了——`docs/fleet-templates/` **不打进镜像**
      （`ls /app/docs/fleet-templates/` → No such file，`find` 无输出），那两条是读盘用例，
      在镜像里必然红；克隆内同一套件 20/20 绿，故不是回归，是环境缺口（见挂账 6.3）
- [ ] 5.2 观察项：滚版后打开任一舰队的编导面，确认报数边出现且与组织树一致

## 6. 挂账（不在本变更）

- 6.1 无 orchestration 段的舰队目前读面不渲染任何边（两个路由都按 `orchestration ?` 门控），
  故其派生报数边也看不到；要不要让"没有编导声明"的舰队也画树，另裁
- 6.2 其他 cell 若存在"说谎"的 report 声明，保存时会被拒绝（错误已给修法），需一次巡检
- 6.3 官方种子（`docs/fleet-templates/*.seed.json`）不进镜像，导致读盘式种子校验只能在仓内跑；
  若要在产线做同类校验，需把种子打进镜像或改成从 pack 源读
