# Tasks: chat-chart-rendering

## 1. Dependency and lazy loader

- [x] 1.1 Add `echarts` to `web/package.json`.
- [x] 1.2 Add a module-level lazy singleton (`getEcharts()` returning a shared instance) in the chart component file, importing from `echarts/core` and registering only the needed chart types and components via `use([...])`.

## 2. Chart component

- [x] 2.1 Create `web/src/components/EChart.tsx`: props `{ option: object }`; `useRef` container, init on mount, `setOption` on option change, `dispose` on unmount.
- [x] 2.2 Merge the active theme into the option (or init with the theme) and re-theme when the theme changes.
- [x] 2.3 Attach a `ResizeObserver` to the container calling `chart.resize()`; disconnect on unmount.
- [x] 2.4 Strip/restrict rich-HTML option fields (at minimum `tooltip.formatter`) before `setOption` so model content cannot reach the DOM as markup.

## 3. Renderer branch

- [x] 3.1 In `web/src/components/Markdown.tsx` `CodeRenderer`, detect `lang === "echarts"`, attempt `JSON.parse`, and render `<EChart>` when the result is a plain object (memoize the parse on the body).
- [x] 3.2 On parse failure or non-object result, fall through to the existing `HighlightedCode` path unchanged.
- [x] 3.3 Confirm the streaming case needs no extra code: a partial fence falls back to code and upgrades once parseable.

## 4. Agent guidance

- [x] 4.1 Document the `echarts` fence contract for the agent (skill and/or profile guidance) so chart requests produce an `echarts` fence containing an ECharts option object.

## 5. Verification

- [x] 5.1 Manual: send a prompt asking for a bar chart; confirm a chart renders, is themed, and resizes with the window.
- [x] 5.2 Manual: confirm a malformed/partial `echarts` fence shows as a code block and upgrades mid-stream.
- [x] 5.3 Manual: confirm a transcript with no chart never fetches the chart library (network panel) and other languages still highlight.
- [x] 5.4 Manual: supply an `echarts` fence with an HTML `tooltip.formatter` and confirm no markup/script reaches the DOM.
- [x] 5.5 Add an e2e assertion that an `echarts` fence renders a chart and a non-echarts fence still renders code (existing e2e suite conventions).
