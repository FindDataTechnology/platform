# Tasks: add-offline-pack-supply

## 1. bundle 容器与校验

- [x] 1.1 新 `server/offline-bundle.js`：`.yizpack` 读写（zip：`bundle.json` + `manifest.json` + 可选 `files/`），元信息与 sha256 清单模型；路径穿越/体积/摘要三闸（`scripts/test-offline-bundle.mjs` 9 测试全绿）
- [x] 1.2 确定性打包：条目排序 + 时间戳归一（固定 epoch），同输入两次导出摘要一致（单测红绿）

## 2. 导入端点

- [x] 2.1 `server/routes/packs.js` 增 `POST /api/mypacks/import-bundle`（与安装同 gate）：解包 → 完整性校验 → `installPack` 原样调用（`source: "bundle"` 透传）；raw 字节/base64 双入口；目标 packId/version 不符即 400；`scripts/test-pack-import-bundle.mjs` 6 测试全绿
- [x] 2.2 `pack-store.js` installPack 只加来源透传（记录 + 安装报告 `source` 字段，缺省 market）；既有调用方行为等值（先跑既有 pack 测试防回归）
- [x] 2.3 付费闸接入：复用安装路由的市场详情查询——可达付费未成交 402、不可达降级；单测两分支（2.4/2.5）；市场不可达不虚构购买态
- [x] 2.4 合同测试：同一 manifest 三形状（packId+version / body / bundle）产出同一安装报告（逐字段等价断言）

## 3. 导出方向（CLI）

- [x] 3.1 CLI 导出动作（`scripts/` 或既有 facet CLI 颗粒）：给定已装 packId+version 收拢 manifest 快照 + 资源本体产出 `.yizpack`；不改安装态；重复导出摘要一致（用 1.2 的确定性保证）
- [x] 3.2 用导出产物做往返测试：清态 cell 导入 = 联网安装同版本逐项等同（技能体/MCP 引用/bot 单元/agents 声明）

## 4. 安装器预置

- [x] 4.1 受控清单（`bundles/manifest.json`）与 predist 烘焙到 `resources/bundles/`：幂等（先清空再按清单重建）、坏包 build 期 fail fast（跑完整 `readBundle`）、空清单零变化；`npm run predist` 已接入 `scripts/bake-bundles.mjs`
- [ ] 4.2 首次预置放入官方入门样例（与 `polish-desktop-fleet-parity` 的种子舰队对齐，避免两处造两份样例）——样例来源以该 change 定稿为准，先接管线空跑

## 5. 见证

- [x] 5.1 单测/合同测试全绿（`test-offline-bundle.mjs` 9 + `test-pack-import-bundle.mjs` 6）+ `openspec validate add-offline-pack-supply --strict` 绿（全仓 `npm test` 随批末统一跑）
- [x] 5.2 导入腿并入平台中立探针 `electron/local-cluster-probe.mjs`（随包发布，release.yml 的 windows 默认腿 + mac dispatch 腿各调一次）：预装包登记可见 → 导入 → 已安装态可见 → 来源标记 bundle。**双平台已双绿**：两腿各自完成「夹具/预装包导入 → 已安装态可见 → 来源标记 bundle」（run `40676023413` / `40678629642`）
