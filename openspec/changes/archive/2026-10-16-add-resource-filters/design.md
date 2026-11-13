# Design: add-resource-filters

## Context

`listResources`（`db.js`）目前只有 `type` + `title LIKE` 两个 WHERE 条件，web 端 store（`useResourcesStore.ts`）已有 offset 翻页与 WS 全量刷新；卡片不渲染 `createdAt`。资源行已有 `created_at` 与 `file_mime`（入库时由扩展名映射），无需迁移。筛选决策来自 2026-10-16 的探索/grill 会话，本文只记录技术取舍。

## Goals / Non-Goals

**Goals:**

- 服务端可组合的时间窗 + 类型组过滤，与现有 type/搜索参数正交组合
- facet 计数与列表同往返返回，口径一致
- 进入页面即「常见产物」默认视图，行为可预期（无隐藏持久状态）

**Non-Goals:**

- 自定义日期区间、排序控件、筛选状态持久化（grill 定案：均不做）
- 小程序 / Expo 端的筛选 UI（本次仅 web；服务端参数天然可供后续复用）

## Decisions

**D1 过滤在服务端 SQL 完成，分组映射单点放 `db.js`。** 分页与 facet 计数都要求服务端掌握全集，客户端过滤不可行。扩展名→组映射（图表按 `type` 列，文件按 `file_mime` 的 SQL CASE，未命中归「其他」）只定义一份，紧邻 `listResources`，路由层与前端类型从那里推导。备选「映射放前端、服务端收 mime 列表」被否：三端将来复用时口径会漂。

**D2 分组名单（定案）。** 图表｜文档(pdf/doc/docx/md/txt/log)｜表格(csv/tsv/xls/xlsx)｜图片(png/jpg/gif/webp/bmp/svg/ico——svg 归图片，预览按图渲染)｜幻灯片(ppt/pptx)｜压缩包(zip/tar/gz/tgz/7z/rar/bz2/xz)｜网页(html/htm)｜数据(json/yaml/yml/xml——独立成组且默认不勾，避免淹没找文档的人)｜其他(空/未识别 mime)。

**D3 facet 计数随列表响应返回，不做独立端点。** `GET /api/resources` 响应加 `facets: { <group>: n }`，与列表同窗（时间 + 搜索）计算、不受组选择影响——一次往返，计数和列表永远对得上；独立端点是两次往返且可能错拍。SQL 上是同 WHERE 的第二条 `GROUP BY`（CASE 出组列）。

**D4 自然日语义、客户端算绝对时间戳。** 「今天」= 客户端本地零点起；「近7天」= 含今天往回 7 个自然日的零点。客户端把 `since`（及可选 `until`）转成 ISO 8601 字符串传参，服务端只做 `created_at` 区间比较——服务端时区完全不参与，ISO 字符串的字典序即时间序。备选「传预设名、服务端按自己时区解释」被否：托管 cell 时区不可控。

**D5 默认视图常量在 store，每次进页重置。** 默认 = 全部 tab + 预勾 图表/文档/表格/图片；不写 localStorage。理由：可预期的落地页；持久化是用户忘记的隐藏状态。

**D6 组选择与 tab 的组合规则：服务端保持纯 AND，客户端负责自洽。** `groups` 参数（CSV）与现有 `type` 参数服务端各自独立过滤（同时出现就同时生效）；UI 层保证不发矛盾组合：全部 tab 不传 `type`、图表 tab 传 `type=chart` 且不发 `groups`（组行隐藏）、文件 tab 传 `type=file` 只发文件组。

**D7 卡片时间：绝对短格式。** `MM-DD HH:mm`，非当年补年份前缀；`title` 属性放完整时间。图表卡与文件卡一致显示（相对时间会漂，资源库是回翻场景）。

**D8 chips 交互细节。** 多选即时生效、翻页归零；0 计数组置灰不隐藏（布局稳定）；窄屏 chips 换行、时间预设横滚；无匹配时空态文案「没有匹配的资源，试试放宽筛选」，不自动清筛选。

## Risks / Trade-offs

- [SQL CASE 依赖 `file_mime`，早年或未知扩展的行为空 → 归「其他」，不会丢行] → 迁移无感；后续扩组只改映射单点
- [默认预勾会隐藏未勾组的资源，用户可能误以为文件丢了] → 未勾组的 facet 计数仍可见（D3 口径不含组选择），数字诱导放宽；空态文案点名「放宽筛选」
- [组行随 tab 显隐造成三端 UI 分叉] → 本次仅 web（Non-Goal 已圈），服务端参数为另两端留好了路

## Migration Plan

纯增量：无 schema 变更、无新路由、无鉴权面变化，随任意常规版本上线即可；回滚 = 前端还原。

## Open Questions

- 无
