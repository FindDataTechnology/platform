# Proposal: chat-chart-rendering

## Why

When a user asks for a chart ("把这组数据画成柱状图"), the assistant can only answer in prose, a markdown table, or a code fence the reader has to mentally execute. The chat already renders markdown and syntax-highlights code blocks, but it has no notion of a rendered chart. ECharts option JSON is a structured, model-emittable format that the renderer simply does not recognize today.

## What Changes

- Render a fenced `echarts` code block in assistant output as a live ECharts chart. All other fenced languages keep their current highlighted-code behavior.
- Lazy-load ECharts on the first chart, mirroring the existing lazy shiki singleton so the base bundle is unaffected.
- Degrade gracefully: any fence body that is not parseable ECharts option JSON (notably a block still streaming, or a malformed chart) renders as the existing highlighted code block and upgrades to a chart once it parses.
- Chart follows the active app theme (light/dark) and re-lays out on container resize.
- Document the fence contract for the model (agent guidance) so chart requests reliably produce an `echarts` fence.

## Capabilities

### New Capabilities

- `chat-chart-rendering`: ECharts rendering of fenced chart blocks in assistant output, including lazy loading, theme integration, resize behavior, and graceful fallback to a code block.

### Modified Capabilities

_None._ The change is additive: existing code-block and markdown rendering behavior is unchanged.

## Impact

- **Code:** `web/src/components/Markdown.tsx` (the `CodeRenderer` language branch), plus a new chart component under `web/src/components/`.
- **Dependencies:** add `echarts` to `web/` (tree-shaken via `echarts/core` + explicit chart/component registration, matching the shiki "only what we register" approach).
- **Agent guidance:** a small addition documenting the `echarts` fence contract.
- **No server, WebSocket protocol, or persistence change.**
