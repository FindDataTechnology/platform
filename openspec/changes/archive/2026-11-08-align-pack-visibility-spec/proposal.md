# pack-visibility 回写：可见性不再「发布后不可变」（N-7）

## Why

`pack-visibility` spec 32 天未回访，其中一句已被后续能力推翻：

> The field SHALL be author-controlled at publish time and **immutable per
> published version**, exactly like the rest of the frozen manifest.

`add-facet-content-management` 上了作者控制台的公开/私有开关
（`PUT /api/packs/:id/visibility`，`gateway/packs.js:824` `setVisibility`），作者或
管理员可随时翻转 pack 级可见性。这不是违规，是刻意的运维能力——**但 spec 还写着
「不可变」，下一个人照 spec 写测试会得到一个必红的断言**。

要分清的是两个东西，spec 现在把它们混成一句：

| 层 | 存在哪 | 可变性 |
|---|---|---|
| 版本清单里的 `visibility` 字段 | 冻结的 `pack_versions.manifest` | 真不可变（与清单其余字段同） |
| pack 级生效可见性 | `packs.visibility` 列 | 作者/管理员可随时翻转 |

铭牌（badge）、列表、检索、详情、安装、部署全读后者，所以「生效可见性不可变」
才是被推翻的那部分。其余三条 Requirement 对代码核过，都成立，不动。

## What Changes

- `pack-visibility`「Packs carry a visibility that defaults to public」改写：保留
  两条既有场景，明确版本清单字段冻结、pack 级生效可见性可翻，并新增一条翻转场景
  （作者可翻、非作者 403、审计上翻成 public 就真进市场）。
- 其余两条 Requirement（owner-scoped everywhere / registry assets follow）逐条对
  代码核后不改。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pack-visibility`：一条 Requirement 按现势回写，补翻转场景。

## Impact

- 纯 spec 文本；零代码改动。已核的代码面：`gateway/packs.js:679 visibleTo`
  （owner+admin，陌生人得 404 同形）、`1840 PUT /api/packs/:id/visibility`
  （400/403/404 三态）、`lib/agent-serving.js:797` 与 `gateway/packs.js:589`
  （部署时 registry 条目跟随清单 visibility）。
