# Design: chat-chart-rendering

## Context

The markdown renderer (`web/src/components/Markdown.tsx`) already routes fenced code by language through a custom `CodeRenderer`. It is the natural seam: a fence's language tag is the only signal the model controls, and adding one more branch is a local change with no protocol impact. Shiki is loaded lazily behind a module-level promise singleton, which is the established pattern for "heavy renderer, loaded on first use".

Two properties of the current renderer constrain the design:

- `rehype-raw` is deliberately off so model-authored HTML renders as text. This closes an XSS surface and must not be reopened by the chart path.
- Assistant text streams token by token, so a fence body is frequently incomplete JSON mid-turn.

## Decisions

### Fence contract: `echarts`, body is ECharts option JSON

The model writes:

````
```echarts
{ "xAxis": { "type": "category", "data": ["a","b"] },
  "yAxis": { "type": "value" },
  "series": [{ "type": "bar", "data": [1, 2] }] }
```
````

The body is the ECharts `option` object verbatim. This requires no translation layer, is what the model already knows from ECharts documentation, and keeps the renderer a pure `JSON.parse` + `setOption`.

### Where: a branch in `CodeRenderer`, not a new block kind

Detecting `lang === "echarts"` in `CodeRenderer` and rendering a `<EChart option={parsed} />` keeps the change to one file plus one component. A `render_chart` tool call with a new WebSocket block kind was rejected: it adds protocol surface, server plumbing, persistence, and a transcript-schema change to achieve what a language branch already does. The fence is also visible in the model's own text, so the user sees the same artifact they can copy.

### Fallback is the existing code path, not an error state

`JSON.parse` runs in a `try/catch`. On failure the component renders exactly what it renders today — the highlighted code block. This yields the streaming behavior for free: a partial fence is just an unparseable body, so it shows as code and swaps to a chart when the body completes. No streaming-aware code is needed, and no new error UI.

### Lazy + tree-shaken load

Mirror `getHighlighter()`: a module-level promise that resolves an ECharts instance on first chart. Import from `echarts/core` with explicit `use([...])` registration of only the chart types and components needed (bar/line/pie + grid/tooltip/legend/title, etc.), so the bundle carries only the registered pieces rather than all of ECharts. The chart component holds a `useRef` to the container, calls `setOption` on mount/update, and disposes on unmount.

### Theme and resize

ECharts is initialized with the theme matching the active app theme and re-initialized (or re-themed) when the theme changes, consistent with how shiki emits dual-theme tokens. A `ResizeObserver` on the container calls `chart.resize()`; the observer is disconnected on unmount.

### Tooltip formatter is the one HTML sink to close

ECharts renders a tooltip formatter string as rich HTML. Since the option comes from model output, this is the same class of surface that `rehype-raw` was disabled to avoid. Decision: do not pass raw formatter strings through. Either strip `tooltip.formatter` (and any comparable rich-HTML field) from the parsed option before `setOption`, or constrain tooltips to the default text rendering. The default ECharts tooltip (no formatter) is sufficient for the common case, so stripping is the cheap, safe default.

## Non-goals

- No server-side chart rendering or image export.
- No new WebSocket event or block kind.
- No chart-editing or download-from-chart UI (users can copy the fence).
- No second charting library. Mermaid (diagrams) is a separate, plausible follow-up, not part of this change.

## Risks

- **Bundle size if registration is sloppy.** Mitigated by the `echarts/core` + explicit `use(...)` approach; a chart-free session never loads it.
- **Option fields with HTML semantics beyond `tooltip.formatter`.** Handled by treating the option as data and auditing rich-HTML fields; the spec requires the sanitize/restrict behavior rather than naming one field.
- **Very large option JSON** could be heavy to parse each render. Acceptable for chat-sized payloads; memoize the parse on the fence body.
