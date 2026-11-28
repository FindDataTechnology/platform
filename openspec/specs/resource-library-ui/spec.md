# resource-library-ui Specification

## Purpose

The client surfaces where users discover, inspect, and manage their resources: a browsing page in each client, save affordances inside the conversation, and live reflection of library changes.

## Requirements

### Requirement: Web resources page

The web client SHALL provide a resources page at `/resources`, reached from the sidebar's Resources tab, listing the cell's resources most-recent-first with a type filter (all / charts / files) and a title search. Above the list the page SHALL offer two filter rows: a time filter with presets (all / today / last 7 days / last 30 days, no custom range) and a type-group filter as multi-select chips over the server's groups. The group row SHALL show the chart group plus the file groups on the all tab, only the file groups on the files tab, and SHALL be absent on the charts tab; the time filter SHALL apply on every tab. Entering the page SHALL land on the all tab with the chart, document, spreadsheet, and image groups pre-checked, and the selection SHALL reset to that default on every page entry — no persistence of the user's filter state. Time presets SHALL use natural-day semantics, with the client deriving absolute window timestamps from its own local clock. Chips SHALL carry per-group counts computed against the active time filter, and a group with zero matches SHALL render disabled, not hidden. Filter changes SHALL apply immediately — no apply action — and reset pagination. Every entry SHALL display its creation time in a short absolute format with the full timestamp available on hover.

Chart entries SHALL render as live charts through the client's existing chart component, not as static previews or code. File entries SHALL show the file name, type, and size, and SHALL open in the existing preview drawer, with the drawer's download path available for stored bytes. Every entry SHALL offer rename and delete (delete behind a confirmation), and a jump-to-source affordance that opens the originating session when it still exists and is absent or disabled otherwise. An empty library SHALL render an explanatory empty state, not a blank panel; a filter combination that matches nothing SHALL render an explanatory no-match state that keeps the filters intact rather than clearing them. Labels SHALL resolve from the internationalization bundle. A bound chart entry SHALL additionally show a source line naming the server, tool, and the as-of moment of its latest data, a refresh action, and a stale badge with the failure reason when its binding is marked stale; an unbound chart SHALL NOT show a source line or refresh action. The chart view SHALL offer a data-period filter over the stored series (recent windows such as last 6 months / last year / all). These bound-chart affordances SHALL be presented without changing the chart renderer.

File entries SHALL additionally offer selection for batch export: a checkbox per file entry, a select-all-files affordance, and an export action that packages the selected files' stored bytes client-side into a single zip download (`outputs-<date>.zip`). Chart entries SHALL NOT participate in the selection (their checkboxes are absent), and the export action SHALL be absent while no file is selected. Batch export SHALL reuse each file's existing stored-bytes serving path — no new server route — and SHALL NOT alter the per-entry download, preview, rename, delete, or jump affordances.

#### Scenario: the page renders both types

- **WHEN** the user opens the resources page with captured charts and saved files present
- **THEN** charts render as live charts and files render as file entries in one list
- **AND** the type filter narrows the list to a single type

#### Scenario: landing defaults pre-check the common groups

- **WHEN** the user enters the resources page
- **THEN** the all tab is active and the chart, document, spreadsheet, and image groups are checked
- **AND** after changing filters, leaving and re-entering the page restores that default selection

#### Scenario: a time preset narrows by natural day

- **WHEN** the user selects the today preset
- **THEN** only resources created since the client's local midnight are listed

#### Scenario: the group row follows the tab

- **WHEN** the user is on the all tab
- **THEN** the group chips include the chart group and the file groups
- **WHEN** the user is on the files tab
- **THEN** the chart chip is absent
- **WHEN** the user is on the charts tab
- **THEN** the group row is absent and the time filter still applies

#### Scenario: facet counts follow the time filter

- **WHEN** the user narrows the time preset to last 7 days
- **THEN** each chip's count reflects that window regardless of which groups are checked
- **AND** a group with zero matches in the window renders disabled, not hidden

#### Scenario: filters apply immediately and reset pagination

- **WHEN** the user toggles a group chip after scrolling through paginated results
- **THEN** the list reloads from the first page without an apply action

#### Scenario: a file resource previews from its stored copy

- **WHEN** the user opens a stored file resource
- **THEN** the preview shows the stored bytes, regardless of the state of the original workspace file

#### Scenario: cards show their creation time

- **WHEN** the user views a file entry
- **THEN** its creation time appears in a short absolute format, with the full timestamp available on hover

#### Scenario: jump back to the source conversation

- **WHEN** the user activates the jump-to-source affordance of a resource whose session still exists
- **THEN** the client opens that session
- **WHEN** the session no longer exists
- **THEN** the affordance is absent or disabled and the entry remains usable otherwise

#### Scenario: empty state

- **WHEN** the library has no resources
- **THEN** the page explains what will appear here and offers no dead actions

#### Scenario: no-match state keeps filters intact

- **WHEN** the active filters match no resources
- **THEN** the page explains that nothing matched and suggests relaxing the filters
- **AND** the filter selections are unchanged until the user edits them

#### Scenario: a bound chart shows its source line

- **WHEN** the user views a chart bound to an MCP data call
- **THEN** a source line names the server, the tool, and how old the shown data is
- **AND** an unbound chart in the same list shows no source line and no refresh action

#### Scenario: a stale chart says so

- **WHEN** a bound chart's binding is marked stale after a failed refresh
- **THEN** the entry shows a stale badge with the failure reason
- **AND** the chart still renders its last good data with its source line reporting the data's age

#### Scenario: batch export packages selected files

- **WHEN** the user selects two or more file entries and activates the export action
- **THEN** a single zip download SHALL be produced containing each selected file's stored bytes under its displayed name
- **AND** chart entries SHALL be absent from the archive regardless of any filter state

#### Scenario: export affordance tracks selection

- **WHEN** no file entry is selected
- **THEN** the export action SHALL be absent
- **AND** selecting and then deselecting every file SHALL hide it again

### Requirement: Saving a file from the web chat
The web chat SHALL expose a save-to-resources action for files it already recognizes as workspace files — from the preview drawer and the turn artifact strip at minimum — without requiring the user to leave the conversation. On success the user SHALL receive confirmation; when the library already holds the same content, the action SHALL report that instead of creating a duplicate. A failed save SHALL surface the reason (for example: too large, or the file no longer exists).

#### Scenario: save from the preview drawer
- **WHEN** the user opens a workspace file in the preview drawer and activates save-to-resources
- **THEN** the file is stored and a confirmation appears
- **AND** the resource is immediately visible on the resources page

#### Scenario: save from the turn artifact strip
- **WHEN** the user activates save-to-resources on a file entry in the turn artifact strip
- **THEN** the file is stored and a confirmation appears
- **AND** the entry's save state updates to already-in-library without a page reload

#### Scenario: already in the library
- **WHEN** the user saves a file whose content is already stored
- **THEN** no duplicate is created and the user is told it is already in the library

### Requirement: Miniprogram resources page

The mini program SHALL provide a standalone resources page, entered from the history surface's resources group. It SHALL list the cell's resources (charts and files) and, for charts, re-render them through the client's existing canvas chart renderer. For stored files it SHALL offer the mini program's native preview for types the platform supports (`openDocument` for office and PDF documents, the image viewer for images) and a forward-to-chat action for sharing a file onwards; a type the platform cannot preview SHALL offer forward instead of a broken or empty preview. Rename, delete (with confirmation), and jump-to-source SHALL be available, with the same absent-when-gone rule as the web page. A bound chart entry SHALL show the same source line and offer the same refresh action and data-period filter as the web page; a stale binding SHALL show the stale badge. Against a cell older than this capability the bound-chart affordances SHALL hide themselves (the chart still renders, no error is surfaced) — the version-skew degradation the library already follows for its whole surface.

#### Scenario: a chart resource renders in the mini program

- **WHEN** the user opens a chart resource
- **THEN** it renders as a canvas chart, or degrades to its code block without surfacing an error

#### Scenario: a stored document previews natively

- **WHEN** the user taps a stored document resource (office document or PDF)
- **THEN** the mini program downloads it and opens it in the native document viewer

#### Scenario: an unpreviewable type offers forwarding

- **WHEN** the user taps a stored file whose type the mini program cannot preview
- **THEN** the client offers forwarding the file to a WeChat chat instead of attempting a preview

#### Scenario: jump back to the source conversation

- **WHEN** the user activates jump-to-source on a resource whose session still exists
- **THEN** the client returns to the chat with that session active

#### Scenario: a bound chart refreshes from the mini program

- **WHEN** the user taps refresh on a bound chart and the cell supports the capability
- **THEN** the chart redraws with the new data and the source line's as-of moment advances

#### Scenario: an older cell degrades silently

- **WHEN** the mini program's cell does not yet support bound charts
- **THEN** charts render as before with no source line, no refresh action, and no error

### Requirement: Miniprogram in-chat file chip

In a completed assistant message, a markdown link whose target resolves to a file inside the agent workspace SHALL render as a tappable file chip instead of the existing copy-to-clipboard link behavior. Tapping it SHALL offer preview and save-to-resources. Once saved, the chip SHALL reflect the saved state so a second save is not attempted. Links that are not workspace files — external URLs and non-file targets — SHALL keep the existing clipboard behavior unchanged.

#### Scenario: a file link renders as a chip

- **WHEN** a completed assistant message contains a link to a generated workspace file
- **THEN** it renders as a file chip, not as a plain clipboard-copying link

#### Scenario: preview and save from the chip

- **WHEN** the user taps a file chip
- **THEN** an action sheet offers preview and save-to-resources
- **AND** after saving, the chip shows the saved state

#### Scenario: ordinary links are unchanged

- **WHEN** a completed assistant message contains an external URL
- **THEN** tapping it keeps the existing clipboard-copy behavior

### Requirement: Library changes appear live

Both clients SHALL reflect library changes without a manual reload: when a resource is captured, saved, renamed, or deleted (including from the other client), an open resources list SHALL update, and count indicators on navigation surfaces (the mini program history group) SHALL stay current while that surface is on screen.

#### Scenario: a chart captured mid-conversation appears

- **WHEN** a chart is captured while the user has the resources page open
- **THEN** the chart appears without the user reloading

#### Scenario: the group count follows the library

- **WHEN** the mini program history surface is open and a resource is added or removed
- **THEN** the resources group's count reflects the change

### Requirement: The observation timeline is visible on the web

The web resources page SHALL expose, for each bound chart, its observation timeline: the list of refreshes with moment, trigger, outcome, and change counts, filterable by observation time, where each entry with changes offers the chart view as of that refresh. Viewing an as-of state SHALL be clearly distinguished from viewing the current chart, and returning to the current view SHALL be a single action. The timeline SHALL state, in a human-readable way, what each refresh did — appended, revised, resourced, unchanged counts and anomalies — using the internationalization bundle.

#### Scenario: the timeline lists what refreshes did

- **WHEN** the user opens a bound chart's timeline
- **THEN** each refresh appears with its moment, trigger, outcome, and per-classification counts in human-readable form

#### Scenario: viewing and leaving an as-of state

- **WHEN** the user opens the as-of view of a refresh and then returns to the current view
- **THEN** the as-of state is visually distinguished while active, and the current chart is restored with one action

### Requirement: Web chat surfaces turn artifacts in a strip
After each assistant turn, the web chat SHALL surface an aggregated strip of the files that turn's tool calls produced or modified. The strip's file set SHALL be derived from the paths those tool calls produced (never from workspace scanning), deduplicated by path, and shown at latest state. Which calls count as producing a file SHALL follow the produced-file rule: a call that only read, listed, or searched contributes nothing, and a shell call contributes only the outputs its command declares. A candidate path SHALL be shown only when the file exists in the workspace. Each strip entry SHALL display a save state — not in library, or already in library by content — and offer preview and save-to-library actions. The strip SHALL be synthesized at render time only: it SHALL never be persisted into message content, SHALL never enter model-visible history, and SHALL render identically for historical sessions.

#### Scenario: unlinked file still surfaces
- **WHEN** a turn's tool call writes a workspace file and the assistant's text references it only in prose or not at all
- **THEN** the turn artifact strip lists that file with preview and save actions

#### Scenario: save state reflects library membership
- **WHEN** a strip entry's file content is already in the library
- **THEN** the entry displays the already-in-library state and a save attempt reports no duplicate

#### Scenario: repeated writes to the same path dedupe
- **WHEN** a turn's tool calls write the same path multiple times, or a file is rewritten across turns
- **THEN** the strip shows one entry per path at its latest state

#### Scenario: a shell-produced archive surfaces
- **WHEN** a turn's shell call produces an archive in the workspace and the assistant's text does not link it
- **THEN** the turn artifact strip lists the archive with preview and save actions

#### Scenario: read-only calls add nothing to the strip
- **WHEN** a turn's calls only read, list, or search files and produce nothing
- **THEN** the strip is absent for that turn rather than listing the files those calls named

#### Scenario: a candidate that no longer exists is not shown
- **WHEN** a produced path is no longer present in the workspace by the time the strip renders
- **THEN** the strip omits that entry

#### Scenario: the strip is synthesized, never persisted
- **WHEN** a message with a turn artifact strip is reloaded or exported
- **THEN** the stored message content is unchanged and contains no strip markup
- **AND** the model's view of the conversation history does not include the strip

#### Scenario: historical session renders the strip
- **WHEN** a past session is reopened and its turns' tool blocks record file paths
- **THEN** those turns render the turn artifact strip derived from the recorded tool data

### Requirement: 成果页三层 tier 收纳

成果页 SHALL 在类型组筛选之外提供 tier 视图：默认按「草稿（draft）/ 成果（stable）/ 正典（canonical）」三层收纳或按 tier 徽章列表展示，各层带计数；tier 视图与现有类型/时间筛选可叠加；未配置记忆服务的部署 SHALL 灰态隐层不报错；i18n 走既有 bundle。

#### Scenario: 一进页面看见风格区分

- **WHEN** 用户进成果页且多 tier 混合
- **THEN** 三层层头与计数清晰，草稿视觉权重低于正典

### Requirement: tags 列与筛选

成果页条目 SHALL 显示 tags（为多测）；筛选栏 SHALL 提供 tag 筛选（可多选），与 tier/类型/时间互筛选；AI 提议的 tag 徽标与人类确认的未标区分；无 tag 的条目不得消失，以一个「未打标」组显系。

#### Scenario: 按 tag「章程」筛选

- **WHEN** 用户勾选 tag=章程
- **THEN** 只显示已标「章程」的条目（人类确认与 AI 提议各异色）

### Requirement: 三手势（记住 / 标为正典 / 改 tag）

成果页每条目 SHALL 提供「记住」、「标为正典」、「改 tag（增/删/改）」三手势；手势 SHALL 经服务端写面生效（直接改真源并同步镜像），AI 提议与人工确认在 UI 明示；改 tag SHALL 在条目内就地编辑（预填现值、可接受/修改/删除 AI 提议、Enter 提交、Esc 放弃，且不遮挡页面其他内容）；手势失败 SHALL 走降语反馈而不置乱态。

#### Scenario: 弹窗接受一个 AI 提议 tag 并删另一个

- **WHEN** 用户在改 tag 编辑面接受「章程」并删「备忘」
- **THEN** 页面即时反映新 tags，并各自记人/AI 来源

#### Scenario: 放弃编辑不改动数据

- **WHEN** 用户在编辑面按下 Esc 或「取消」
- **THEN** 条目的 tags 与编辑前一致，且不发出任何写请求

### Requirement: 资源面的状态词汇与破坏性确认

`/resources` 的所有状态徽章 SHALL 使用状态词表 token（如 tier 徽章的「正典」高亮走 `status-waiting`，而不得手写 `amber-500` 等具名色阶）；删除资源 MUST 经主题化确认对话框（危险变体、焦点落取消、Esc 等同取消），MUST NOT 使用浏览器原生 `confirm()`。

#### Scenario: tier 徽章走词表

- WHEN 资源条目渲染 draft/stable/canonical 三档 tier 徽章
- THEN 颜色来自主题 token（canonical 为 warning 系高亮），标签文字始终在场（颜色永不单独表意）

#### Scenario: 删除须确认

- WHEN 用户点击资源的删除按钮
- THEN 弹出主题化确认框，焦点落在取消侧；确认后才执行删除，且不弹出浏览器原生 confirm

### Requirement: 图表系列的序列色阶

图表渲染（EChart）SHALL 在 option 未自带色板时，按序应用 `series-1..4` 序列色阶（运行时从主题 token 解析，随暗亮主题联动）；option 自带 `color` 数组时数据优先。单系列图表因此呈现为灯色。

#### Scenario: 多系列不越阶

- WHEN 一张图表含两个及以上数据系列且未自带色板
- THEN 系列颜色取自 series-1..4 顺序；暗亮主题切换后重新解析生效

（实施备注：视觉评审在生产环境观察到的「配额计量 tile 彩虹」不在本分支的 `/resources` 面上——本分支该页为资源库（图表/文件列表）。若后续引入配额 tile，按 DESIGN.md 序列色阶与状态词表执行，并回补本能力的对应需求。）
