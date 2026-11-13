# add-skill-display-annotations — Design

## Context

注释层契约（`supply-annotation-overlay`）与谦面消费管道 11-02/11-03 已上产，但 skill 全链是空的：壹座扩展页无投影通道、chat 索引无 skills 键、pack-locale 对技能只投影 description。数据侧由 finddata 协同单 `add-skill-supply-annotations` 交付（registry 技能 `metadata.annotations` + paas 仓库注释源 `skills` 键）；本单补三处消费通道，全部沿既有模式镜像实现。

约束：

- `supply-annotation-overlay` 的四源合并序（registry metadata > 仓库注释源 > 仓库目录 > 上游原文）与 zh 唯一回落是既定纪律，skill 面必须同序。
- pack-locale 是零依赖 leaf（gateway 进程内 import），skills 投影扩展不得引入模块图。
- `add-tool-description-enrichment`（在途）共享注释层读面但 Non-goals 明写不碰 skill 与人读渲染；`extension-store.js` 是潜在碰面点，投影入口须唯一。
- 谦面 skills 目录（facet web + bridge）已就绪，本单零代码——它是上游数据到位后的天然验收对照面。

## Goals / Non-Goals

**Goals**

- 壹座 `/api/extensions/skills` 接 locale + 注释投影（registry 来源与文件技能两路）。
- chat 注释索引 `getSupplyAnnotationIndex` 增 `skills` 键，技能调用块渲染通俗标签。
- pack-locale skills 块增 `name` 投影（对齐 agents 写法），`title` 基轨随直出。
- 全链无注释时逐字节回退（渐进上产，数据可后到）。

**Non-Goals**

- 不改 skill slug、安装键、锁定/权限、闭包闸；不做运行时翻译；不动 canonical 轨（归 enrichment 单）。
- 不动谦面（facet）代码——直通+投影已就绪。
- 不做注释的写回/编辑 UI（注释真源在 finddata 仓，发布即数据）。

## Decisions

### D1 技能注释读取两路，同一条投影出口

`/api/extensions/skills` 列表投影按条目 `source`/`origin` 分流取注释：registry 来源（origin registry，经安装落地）读其 `metadata.annotations`；文件技能与 DB 自定义技能读仓库注释源 `skills` 键。两路汇入同一个 `projectAnnotation` 投影函数（zh 唯一回落），响应形状与 MCP 面同构：注释存在时条目增 `annotation` 键，缺省不带键（旧客户端零感知）。

- 替代方案：把文件技能注释也塞进 registry。否决——文件技能不在 registry 在册，伪造注册行破坏真源单一性。

### D2 chat 索引增量而非重构

`getSupplyAnnotationIndex` 产物 `{servers, tools}` 增第三键 `skills`，构建循环复用同一次合并目录读。索引消费者（chat 块渲染）按 `skills[<slug>]` 查 label；查无则渲染不变。索引每会话构建一次的既有节奏不变。

### D3 pack-locale skills name 投影镜像 agents 块

`projectManifestForLocale` 的 skills 块从「仅 description」扩为「description + name（name 仅当基条目声明 `title`）」。镜像 agents 的实现形状（`ov.name !== undefined` 守卫 + `pickLocalized`）。zh 请求路径零改动（原对象直返的不变量保持）。

- `title` 的校验（长度帽、键对齐、覆盖义务）在 finddata 侧校验门与 paas 发布门共同执行；paas 侧投影对「name 覆盖无 title 对位」防御性忽略并按原值直出（校验门红在先，投影不崩）。

### D4 渐进上产，无硬时序依赖

本单三个通道在数据缺位时全部逐字节回退原文——可先合入。finddata 协同单数据到位后：谦面即刻生效（管道现成），壹座扩展页与 chat 块随本单镜像生效。两侧无合入顺序硬约束，验收以双数据源齐为终点。

## Risks / Trade-offs

- **`extension-store.js` 并发改动**：与 enrichment 单同文件。缓解：本单只动 `getSupplyAnnotationIndex` 与新增技能注释装载函数，profile 组装路径不碰；两侧 review 时互查。
- **索引体积**：`skills` 键随技能数线性（当前规模 <30），键值对极小（label+summary），不构成内存面。
- **`title` 未声明的旧 pack**：显示名保持 slug——与今天一致，不强制回炉；pack 源侧渐进补齐（finddata 协同单 D5）。

## Migration Plan

1. `lib/pack-locale.js` skills name 投影 + 单测（对齐 agents 用例形状）。
2. `extension-store.js`：技能注释装载（仓库注释源 `skills` 键）+ 索引 `skills` 键。
3. `server/routes/extensions.js`：skills 列表接 locale + 分流投影。
4. web 技能卡渲染 `annotation?.name || displayName`（谦面已同款；壹座扩展页若有裸显卡片同步）。
5. 数据到位后真机验收：谦面 zh/en 对照 + 壹座扩展页 + chat 技能块。
