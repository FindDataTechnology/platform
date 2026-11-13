# Design: add-offline-pack-supply

## Context

装机链的既有事实（侦察坐实）：`POST /api/mypacks/install` 已经存在
`{packId, version, manifest}` 兼容形状，注释明写「processed through the
identical validation pipeline (one installPack call, one set of rules)」。离线
供给因此不是新链，而是**把 manifest 与它引用的资源本体拦到手边的容器格式 +
一条走同闸的导入路由**。约束：付费闸与市场可达性语义已有既定行为，离线
场景不得发明新执法。

## Goals / Non-Goals

**Goals:**
- 一个单文件、可校验、可确定性产出的 bundle 格式（导出/导入双向）。
- 导入与联网安装同管线同规则；来源可区分；离线可用不破既有降级语义。
- 安装包可预置官方入门 bundle，为桌面首启的本地集群样例供给原料。

**Non-Goals:**
- 离线许可证执法/签名信任链（二期）；bundle 的市场分发中心（bundle 靠文件
  传递与安装器预置）；浏览器端导出 UI；pack 版本升级的离线编排（升级仍走
  显式动作，可离线用新 bundle 覆盖，属既有 `Updates are explicit` 语义）。

## Decisions

### D1 容器 = zip + 双文档 + 内容寻址清单

`.yizpack` 用 zip 而非 tar（Windows 侧无额外依赖、用户可自解害错），
`bundle.json`（元信息 + sha256 清单）+ `manifest.json`（原样快照）+ `files/`
（资源本体）。摘要清单是**导入期的整体性闸**：任一文件失配即整体拒绝，杜绝
半包。替代项：(a) 只带 manifest、资源仍联网取——不满足气隙；(b) 带全仓库
快照——体积失控且与版本快照语义冲突。否决。

### D2 导入 = 临时区解包 + installPack 原样调用 + 出处标记

`server/offline-bundle.js` 负责解包（路径穿越/体积/摘要三闸）与互校，产出与
`{manifest}` 形状等价的入参，调 `installPack({packId, version, manifest,
source: "bundle", ...})`。installPack 本体只加一个来源透传（hooks/记录），
**校验规则一行不改**——离线不免检是 spec 级承诺。临时区用受控目录 + finally
清理（失败不留残）。

### D3 付费闸：沿用既有语义，不在 bundle 上叠执法

导入路由复用安装路由同一段市场详情查询：可达且付费未成交 → 既有 402；
市场不可达 → 既有降级（继续）。理由：把「离线」与「免付费」绑死是产品决策
而非工程顺手；想离线执法就要先有离线信任根（签名/许可文件），那是二期议题。
替代项「bundle 一律豁免付费闸」会把降价即绕过，否决。

### D4 导出 = CLI 颗粒 + 确定性打包

导出收拢市场版本快照（复用 install 路径的 server-side manifest 获取）与已
安装的资源本体，按清单排序、时间戳归一（固定 epoch）写 zip，保证同输入同
摘要。它是预置烘焙与样例分发的输入源；不做 UI。替代项「渲染层导出」需把
资源本体送浏览器，与 `Manifest retrieval is server-side` 的立规冲突，否决。

### D5 安装器预置 = resources/bundles + 受控清单，构建期验包

predist 从一个仓库内受控清单（如 `bundles/manifest.json`：本地 bundle 路径
+ 摘要）收纳到 `resources/bundles/`，构建期对每个文件跑元信息与摘要校验
（坏包 fail fast）。空清单 = 目录不产出，出包流程零变化。首启消费引导不做
在打包侧（归 `polish-desktop-fleet-parity`）。

## Migration

- 无数据迁移：新端点为纯增量；安装记录加 `source` 字段（缺省 market，历史
  行视同 market，无回填必要）。
- 构建链新增受控清单文件；缺省为空即零行为。回滚 = 撤路由/清单，既有链不变。

## Verification

- 单测：容器三闸（摘要失配/路径穿越/超体检）；导入→安装态等价（与联网同版本
  逐项比）；确定性导出（两次摘要一致）；付费闸两分支（可达 402 / 不可达降级）。
- 合同测试：install 三形状（packId+version / body manifest / bundle）共用管线
  的等价断言（同一 manifest 三种入口产出同一安装报告）。
- 构建期：predist 幂等 + 坏包 fail fast（CI 门）。
- e2e：乘 installer-e2e 轨一幕——断网装机导入预置 bundle 成功（与
  `add-local-fleet-control-plane` 的集群一幕共用走查路径）。
