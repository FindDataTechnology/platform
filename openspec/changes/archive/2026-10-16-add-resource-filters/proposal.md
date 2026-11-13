# Proposal: add-resource-filters

## Why

The resources page（成果）can only narrow by the coarse all/chart/file tabs and a title search, and its cards do not show when a resource was created. As the library accumulates, "last week's PDF" and "the spreadsheets" are indistinguishable from everything else — the page degrades into a pile of cards ordered only by recency.

## What Changes

- File cards display their creation time (short absolute format, full time on hover).
- The web resources page gains two server-applied filters above the list:
  - a **time filter** with presets: 全部 / 今天 / 近7天 / 近30天 (natural-day semantics; the client computes absolute `since`/`until` timestamps from its local clock — no server timezone involvement). No custom range.
  - a **type-group filter** as multi-select chips: 图表 / 文档 / 表格 / 图片 / 幻灯片 / 压缩包 / 网页 / 数据 / 其他, derived from a server-side single-home extension→group map.
- Landing default: the "全部" tab with the common groups (图表/文档/表格/图片) pre-checked; the selection resets to this default on every page entry (no persistence).
- Chips carry facet counts computed against the active time filter but not the type filter; zero-count groups render disabled, not hidden. All filters apply immediately (no apply button) and reset pagination.
- The list API gains `since`/`until` (created-at window) and type-group parameters, plus a facet-count source; sorting stays `created_at DESC`.
- Scope: web client only. The mini program and Expo app keep their current resources surfaces.

## Capabilities

### New Capabilities

- none

### Modified Capabilities

- `resource-library`: the management API requirement — list gains created-at window filtering, type-group filtering, and facet counts alongside the existing type and title-search parameters.
- `resource-library-ui`: the web resources page requirement — time presets and type-group chips with a default selection, facet counts, and creation-time display on cards.

## Impact

- `db.js` — `listResources` WHERE/params extension + facet count query; no migration (`created_at`, `file_mime` exist).
- `server/routes/resources.js` — query param parsing for the list route.
- `packages/core/src/api/resources-api.ts` — query parameter and response types.
- `web/src/hooks/useResourcesStore.ts` — filter state, default selection, facet state, pagination reset.
- `web/src/pages/ResourcesPage.tsx` — filter rows, chip rendering, card time.
- `web/src/locales/*` — group and preset labels.
- No new auth surface, no schema change, no behavior change for mini program / Expo clients.
