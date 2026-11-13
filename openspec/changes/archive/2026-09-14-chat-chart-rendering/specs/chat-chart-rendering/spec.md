# chat-chart-rendering Specification

## Purpose

Renders fenced `echarts` blocks in assistant output as live charts, reusing the existing markdown code-block seam, with lazy loading and a fallback that never regresses the current code-block experience.

## ADDED Requirements

### Requirement: Fenced echarts blocks render as charts

The chat renderer SHALL recognize a fenced code block whose language is `echarts` and whose body parses as a JSON object, and render it as an ECharts chart instead of a highlighted code block. The chart SHALL be constructed from the parsed option object only; the renderer SHALL NOT interpret the fence body as HTML. A fence tagged `echarts` whose body does not parse as a JSON object SHALL render as the existing highlighted code block. All other fence languages SHALL keep their current behavior.

#### Scenario: valid echarts fence renders a chart
- **WHEN** assistant output contains a fenced `echarts` block whose body is a valid ECharts option JSON object
- **THEN** the block renders as an ECharts chart
- **AND** the block does not render as highlighted code

#### Scenario: malformed echarts fence falls back to code
- **WHEN** assistant output contains a fenced `echarts` block whose body is empty, truncated, or not valid JSON
- **THEN** the block renders as a highlighted code block
- **AND** no error is surfaced to the user

#### Scenario: other languages are unaffected
- **WHEN** assistant output contains a fenced block for any language other than `echarts`
- **THEN** the block renders as highlighted code exactly as before

### Requirement: Charts upgrade in place while streaming

While an assistant turn is streaming, a fenced `echarts` block MAY be incomplete. The renderer SHALL render the incomplete block as a code block and SHALL replace it with a chart once the block body parses as a valid option object, without requiring any user action or the turn to finish.

#### Scenario: block completes during streaming
- **WHEN** an `echarts` fence begins streaming as partial JSON
- **THEN** it is shown as a code block
- **AND** when the body becomes a complete, valid option object the block becomes a chart without a reload

#### Scenario: interrupted turn leaves a code block
- **WHEN** a turn is interrupted such that an `echarts` fence never completes
- **THEN** the partial block remains a code block

### Requirement: Chart rendering is lazy-loaded

The chart library SHALL NOT be part of the initial frontend bundle. It SHALL be loaded on demand the first time an `echarts` block is rendered, and the loaded instance SHALL be shared across subsequent charts.

#### Scenario: no chart in the transcript
- **WHEN** a transcript contains no `echarts` block
- **THEN** the chart library is not fetched

#### Scenario: multiple charts share one load
- **WHEN** a transcript contains two or more `echarts` blocks
- **THEN** the chart library is fetched once and reused

### Requirement: Charts follow theme and resize

A rendered chart SHALL use the color scheme of the active application theme and SHALL update when the theme changes. It SHALL re-lay out to fit its container when the container changes size.

#### Scenario: theme switch repaints the chart
- **WHEN** the user switches between light and dark themes
- **THEN** an already-rendered chart repaints to the new theme's colors

#### Scenario: container resize re-lays out the chart
- **WHEN** the chat column or window width changes
- **THEN** a rendered chart resizes to its container without clipping

### Requirement: Chart option content cannot inject markup

The renderer SHALL treat the parsed option as data. It SHALL NOT pass chart output through an unsanitized HTML sink, and any option field that ECharts renders as rich HTML (for example a tooltip formatter string) SHALL be sanitized or restricted so that model-authored content cannot introduce executable or arbitrary markup into the application DOM.

#### Scenario: tooltip formatter cannot inject script
- **WHEN** an `echarts` fence supplies a tooltip formatter string containing HTML or script
- **THEN** the resulting tooltip renders without executing script
- **AND** no markup from the fence reaches the application DOM unescaped
