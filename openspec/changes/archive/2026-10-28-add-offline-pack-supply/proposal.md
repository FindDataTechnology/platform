# add-offline-pack-supply — 离线 pack bundle 供给（本地集群的气隙供给面）

## Why

「本地运行和管理多智能体集群」拍板时离线供给被纳入 v1（2026-10-28 D2：要）。现状盘点：装包的唯一供给道是 `POST /api/mypacks/install` 的 {packId, version} 形状——cell 走市场信道服务端取 manifest，Win/Mac 桌面断公网即零供给；但同一端点已存在 `{packId, version, manifest}` 兼容形状且与联网路径**共享同一 installPack 校验管线**。离线 bundle 因此不新建安装链，只新建「把 manifest+资源本体拦到手边」的供给形状：`.yizpack` 单文件（zip：bundle 元信息 + manifest 快照 + 它引用的资源本体），导入落同一条管线。

## What Changes

- **bundle 格式（新）**：`.yizpack` = zip 容器，含 `bundle.json`（格式版本/packId/version/出处/内容清单摘要）+ `manifest.json`（市场版本快照）+ `files/`（manifest 引用的技能体等资源本体，按内容寻址落位）；单文件可拷、可随安装器预置。
- **导入端点（新）**：`POST /api/mypacks/import-bundle`——解包→元信息与 manifest 互校→**原样走既有 installPack 校验管线**（一闸不绕），成功后 pack 呈已安装态且来源标记 `bundle`（可区分的出处行）。
- **付费闸语义明文化**：bundle 导入时市场若可达，照跑既有「付费未成交 402」闸；市场不可达时如实降级（与现状 `{manifest}` 形状同语义），离线场景不在 bundle 上叠许可证执法——离线执法是二期话。
- **安装器预置（可选消费）**：installer's resources 增 `bundles/` 目录，predist 把官方精选入门 bundle（样例舰队包 + 入门技能包）烘进桌面安装包；首启是否消费的引导 UI 归姊妹 change `polish-desktop-fleet-parity`，本 change 只保证文件在且可导入。
- **导出方向（小）**：管理侧/CLI 增「把某 pack 版本打成 .yizpack」的导出命令（市场侧已装版本快照 + 资源本体收拢），作为样例与分发手段；不做浏览器端导出 UI（v1 命令行颗粒足够）。

## Capabilities

### New Capabilities

- `offline-pack-supply`: bundle 容器格式与元信息契约、导入端点的校验/降级/出处语义、导出方向、与安装器预置的衔接。

### Modified Capabilities

- `pack-installation`: `Manifest retrieval is server-side` 要求扩出第三形状——bundle 导入（本地文件拦到手边，校验管线同闸）；安装报告与出处行增 `bundle` 来源标记。
- `installer-distribution`: 打包内容增 `resources/bundles/` 预置目录与 predist 烘焙步骤（空目录可运行、有 bundle 时进安装包）。

## Impact

- **代码**：`server/routes/packs.js`（import-bundle 路由）、新 `server/offline-bundle.js`（解包/互校/文件落位）、`scripts/`（predist 烘 bundle + 导出生成）、`pack-store.js` 不动主链（installPack 原样复用，hooks 记出处）。
- **契约**：新增单端点；既有两种安装形状行为逐字节不变；bundle 来源标记向后兼容（老客户端只见已安装态）。
- **安全边界**：导入端点走与安装一致的 gate；zip 解包有路径穿越与体积闸；bundle 内容仍过 installPack 的全套校验（skill 冲突/MCP 引用/安装报告）——离线不等于免检。
- **依赖**：姊妹 change `add-local-fleet-control-plane` 的 e2e 样例包从这里来（互不强依赖，顺序可调）。
