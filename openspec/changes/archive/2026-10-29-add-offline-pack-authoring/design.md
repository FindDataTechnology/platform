# Design: add-offline-pack-authoring

## Context

侦察坐实的现状：草稿本体是 cell 本地的（`pack_drafts` 表，CRUD 全离线）；编辑器
（web）持有 `entries → manifest` 的组装逻辑（`publishPack({packId?, manifest})` 直接
POST 完整 manifest）；发布通道是 gateway（需市场可达 + 创作者门）。
`offline-pack-supply` 已提供容器（`buildBundle`/`readBundle`）与**安装**态的导出，
但草稿态没有出口。本设计的核心取舍：**组装留在编辑器、校验与打包放服务端**。

## Goals / Non-Goals

**Goals:**
- 草稿 → `.yizpack`：断网可交付（装到别机/自己的其他机器）。
- bundle → 草稿：往返编辑，round-trip 确定性。
- 与发布语义严格分区（导出≠发布）。

**Non-Goals:**
- 离线**上架市场**（发布仍是在线动作，创作者门/限流照旧）。
- 草稿的云同步/多机协同（草稿保持单 cell 本地）。
- 容器格式改动（复用 `offline-pack-supply`）。
- 服务端重写 manifest 组装逻辑（组装源唯一=编辑器，见 D1）。

## Decisions

### D1 组装在编辑器、校验在服务端——不复制组装逻辑

`entries → manifest` 的组装今天只存在于编辑器（`publishPack` POST 完整
manifest，gateway 校验）。导出端点接受 `{manifest}` 并用 `validatePackManifest`
（与 `installPack` 同一套）把关——**校验规则单源、组装逻辑单源**，服务端只做
「校验 + 打包」。替代项「服务端从 `entries` 编译 manifest」会把组装逻辑复制到
第二处（且要吃透编辑器的条目语义），两处必然漂移，否决。代价：导出请求体
比安装大（带完整 manifest），但导出是低频动作，且与 `publishPack` 的请求
形态对称。

### D2 导出 ≠ 发布：不动任何发布态字段

导出端点 SHALL NOT 触碰 `published_pack_id`、不产生 packId、不递增版本、
不过创作者门。理由：发布语义（版本冻结、标识符服务端分配、创作者门）属于
市场线；离线交付只是「拿到一个可安装的工件」。作者以后想上架，仍走既有
发布（版本从 1 开始或续版本号，与导出无关）。

### D3 round-trip 的确定性来自既有确定性

`buildBundle` 已是确定性打包（条目排序 + 固定日期）。导入→再导出的等价性
因此**不需要新代码**，只需要保证导入的 manifest 与导出的 manifest 逐字节
等价（`readBundle` 已保证）。round-trip 测试 = 容器摘要一致性断言。

### D4 导入=新建草稿，不做「更新已发布草稿」的合并

bundle → draft 一律新建草稿（不按 packId 匹配已有草稿）。理由：草稿与发布
包没有身份绑定（`published_pack_id` 是可选备注），合并语义（覆盖谁？保留谁
的 skills？）是一坑深水；新建+重命名是作者可预期的行为。替代项「按 manifest
.name 匹配更新」会在多机往返时静默覆盖作者改动，否决。

## Migration

- 无数据迁移：两个端点为纯增量，`offline-bundle` 模块零改动。
- 回滚 = 撤两端点与编辑器动作，无残留。

## Verification

- 单测：导出（合法 manifest → 合法 bundle；校验失败 → 结构化错误且与安装
  报错一致）；导入（bundle → 新草稿，已安装列表/技能库/MCP 零变化）；
  round-trip（导出→导入→再导出，摘要一致）。
- e2e：草稿编辑器两动作（导出下载、导入建稿），断言发布按钮不受影响。
- 手动：断网机器上 草稿→bundle→`import-bundle` 装机 全链（与
  `offline-pack-supply` 的安装探针合流）。
