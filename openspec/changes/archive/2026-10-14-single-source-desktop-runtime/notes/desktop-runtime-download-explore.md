# 桌面首启下载运行时 — explore 记录（deferred）

> 来源：`single-source-desktop-runtime` tasks 4.2。本 change 只做到"闭包与镜像同源 + 剪枝同名单"，
> 下面这条是**体积诉求的下一级**，不在本 change 实施，留作独立 explore 的起点。

## 诉求

剪枝后桌面包的 dsh 载荷仍是 ~33MB（@deepseek-ai 面）+ 其余运行时依赖，安装包总体仍在数百 MB
量级（asar:false + 捆绑 standalone Node 的既有形态）。若要把安装包再压一个数量级，唯一的路是
**首启下载**：安装包里不带 dsh 运行时，应用首次启动时从官方分发点下载矩阵闭包。

## 已探明的事实（本 change 顺手核实，供后续 explore 省步）

- **闭包有单源可下载**：`dsh-matrix/` 的 manifest+lock 已冻结全闭包，理论上可发布为一个
  tarball/registry 快照，首启按 lock 校验后解包。
- **boot 门现成**：`lib/dsh-matrix-verify.js` 已能对任意安装根做"lock 逐包比对 + 剪枝名单豁免"，
  首启下载后立刻可验完整性（包括断点续传后的部分解包）。
- **桌面解析路径已就绪**：`dsh-profile.js` 的 `RUNTIME_NODE_MODULES` 无 `DSH_BIN` 时回退
  `APP_NODE_MODULES`——首启方案只需让下载目录成为该回退目标（或注入 `DSH_BIN`），不需要改桥插件链接逻辑。
- **反面证据（重要）**：Windows 打包历史上四次修复都围绕"闭包走丢"（v1.3.2/1.3.3
  `Cannot find package 'cordis-plugin-group'`）。**首启下载等于把闭包完整性从构建期风险挪到运行期风险**，
  需要离线可用性、下载失败重试、企业代理环境、镜像源选择等一整层设计——风险面比当前形态大。
- **镜像侧不可用同一方案**：服务器镜像在 K8s 里冷启动，首启下载会拖长就绪时间并引入外网依赖，
  与现有 `/opt/dsh` 烘焙路线冲突。

## 建议的 explore 切入点（未来）

1. 先量化收益：当前 dmg/exe 中 dsh 载荷的真实占比（GHA release 构建产物 `du`）。
2. 决定分发点：GitHub Release 资产 / 自有 CDN / npm registry 快照，各自的可用性与国内可达性。
3. 设计降级链：下载失败时是否退回"包内最小可运行集"，还是硬失败并提示重试。
4. 只在桌面实施，镜像保持烘焙（两面共享 manifest，不共享交付形态）。
