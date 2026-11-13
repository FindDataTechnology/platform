# Proposal: desktop-catch-up-release

## Why

桌面安装包只在 `v*` tag 推送时构建（`release.yml:20-22`），且全仓无 autoUpdater（无 electron-updater）。最后一个 tag v1.3.13 停在 2026-10-16 04:22，`package.json` 已到 1.3.17 却从未打 tag——其后 **138 个 commit** 的能力（切窗口不断流、应用中心统一网格、连接中心、语音车道 ASR、角色体系、Agent 集群平台、云目录 last-good 抗抖、`/agents` 白屏修复等）桌面用户一个都没拿到，升级只能去 dl 主机手动重装。同时发现疑似**第三个「漏运行时目录」打包缺口**：electron-builder files 清单（`electron-builder.js:121-168`，宽 glob 覆盖 `server/**`、`lib/**`、`services/**` 等）不含 `agent-runner/**`，而 supervisor 描述符要 spawn `agent-runner/index.js`（`supervisor/descriptors.js:110`）；桌面舰队切片①②恰好赶在 v1.3.13 之前合入、其验收探针跑的是源码树非打包件——打包件里配对启用机位大概率 `ERR_MODULE_NOT_FOUND`。前两例同类病（10-07 漏 `lib/`、v1.3.10 漏 `services/`，清单注释自证）都是装机后才炸，而 `verify-bundle.js` 目前只断言 Node 与 dsh 运行时在位，不护这类缺口。

## What Changes

- **打包缺口修复 + 建制化断言**：files 清单补 `agent-runner/**`；ADDED `release-pipeline` 需求——files 清单 SHALL 覆盖 supervisor 描述符与服务端引用的每个运行时目录，`verify-bundle.js` 在打包前断言（缺目录即 build fail）。把「漏目录」这类病从第三次变成最后一次。
- **干跑确证**：`workflow_dispatch`（只出 artifact 不发 release）跑一次 release 矩阵；安装后冒烟清单：舰队配对真启动（坐实/证伪 agent-runner 缺口）、并发会话切窗、应用中心、连接中心、语音、集群页。
- **补版发布**：bump `1.3.18` → 打 tag → release.yml 出三平台安装包 → `win-install-smoke` → release-sync 链（installer-distribution：dl.finddatatech.cloud + 官网下载中心快照）。发布前后按 AGENTS.md 纪律先跑 `fd-build-channel`——release 矩阵 = 2×macOS（计费 ×10）+ 1×Windows（×2），私有仓额度必须预排，避免重蹈 app-e2e 单次烧 80-170 分钟的坑。
- **走查驱动的 spec 修订（条件性）**：仅当打包件行为与 `desktop-fleet-runner` / `desktop-fleet-console` spec 不符时才追加 spec delta（候选：D6 registry 缺失退出循环、插件热启停「重启应用生效」措辞）；预期主路径零额外 spec delta。
- **明确不做**：autoUpdater（真实产品缺口——没有它每次补版都靠用户手动重装——但改分发模型且涉及签名/渠道设计，另立 explore，不混入补版刀）；切片③设备管理面与部署按钮解锁（roadmap 2026-10-13 已把本地设备群降级为长线线索）；MP 指挥台页面眼见（随下个提审窗，用户行动项）；桌面侧新功能开发（本刀只补版对齐，不加新能力）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `release-pipeline`: 新增「打包树运行时目录覆盖断言」需求——files 清单覆盖描述符/服务端引用的全部运行时目录，verify-bundle 打包前断言，缺失即构建失败

## Impact

- `electron-builder.js`（files 清单 +1 行）、`scripts/verify-bundle.js`（新增目录断言；运行时目录清单的来源——描述符静态扫描或显式清单——design 定）、`package.json`（bump 1.3.18）。
- 发布动作链：tag、GitHub Release、release-sync、dl 主机与官网快照；GHA 私有额度消耗（macOS ×10，先查余额再动手）。
- 用户侧影响：v1.3.13 用户需手动重装升级（无 autoUpdater，本刀不解决，缺口已记录）。
- 桌面舰队面：若 agent-runner 缺口坐实，v1.3.13 用户配对机位一直在失败——补版同时是这处隐性故障的修复发布。
