# resource-library Specification

## Purpose

A durable, typed library of artifacts produced in chat — charts and generated files today, further types by extension — captured from the conversation but owned by the user, independent of any session's lifecycle.

## Requirements

### Requirement: Resources are typed artifacts with provenance

The system SHALL persist resources in the project database as typed rows. Every resource SHALL carry a `type` (v1: `chart`, `file`), a title, a creation source (`auto` capture or `manual` save), and its provenance: the originating session id, a snapshot of that session's title at capture time, and the originating message reference when one exists. Session linkage SHALL be a soft reference that does not cascade: deleting a session SHALL NOT delete its resources, and a resource whose session no longer exists SHALL remain fully readable. Type-specific content SHALL live in an extensible payload (JSON for types that are self-contained, an optional stored-bytes reference for files) so a new type can be added without restructuring existing rows. A chart resource MAY reference one or more chart data bindings (one per rendered series); the reference is to the binding as a data source and does not extend the resource's session provenance.

#### Scenario: a captured chart carries its provenance

- **WHEN** a chart is captured from an assistant message during a turn in session S
- **THEN** the resource records the session id, the session title as it stood at capture time, and the originating message reference

#### Scenario: deleting the source session does not delete resources

- **WHEN** the user deletes the session a resource came from
- **THEN** the resource remains listed and readable
- **AND** its provenance still shows the session title snapshot
- **AND** any jump-to-session affordance for it is absent or disabled

#### Scenario: a multi-series chart holds one binding per series

- **WHEN** a chart resource renders two series and each series is bound to a data source
- **THEN** the resource references two bindings, one per series

#### Scenario: binding references do not outlive their resource

- **WHEN** the last resource referencing a binding is deleted
- **THEN** the binding is no longer referenced by any resource and the cleanup path applies

### Requirement: Chart specs are captured automatically from assistant turns

Every complete assistant turn SHALL be examined for chart specifications, and each one found SHALL be recorded as a resource with no user action. The recognized form SHALL be the existing chart contract: a fenced `echarts` block whose body parses as a JSON object (the same rule the chat renderers apply; a fence that fails to parse is not a chart and SHALL NOT be captured). Capture SHALL happen where turns are mirrored to the project database, so it applies uniformly to turns from every client and from scheduled-task runs. Charts SHALL be deduplicated by content hash across the whole cell: a spec already in the library SHALL NOT create a second entry — its last-seen time is refreshed instead, and the original provenance is kept. Regenerating a turn (an honest re-send, since the runtime has no replace-turn operation) therefore never duplicates charts. The chart's title SHALL default to the option's own title text when present, and to a session-derived label otherwise; retitling is possible afterwards. For every captured chart, the capture path SHALL also retain the MCP tool calls that executed in the same turn (their exact names, arguments, and results) as binding candidates; a candidate SHALL be retained even when no binding is created from it, and SHALL be the only source of candidates later offered to the user. The turn's tool-call record SHALL NOT be treated as a binding by itself — attaching a binding always requires one of the binding creation sources defined by the chart-data-binding capability.

#### Scenario: a chart in an assistant turn is captured without user action

- **WHEN** an assistant turn completes containing a well-formed fenced `echarts` block
- **THEN** a `chart` resource exists with the parsed option as its payload
- **AND** the user did not take any action to create it

#### Scenario: malformed or partial fences are not captured

- **WHEN** an assistant turn contains a fence tagged `echarts` whose body does not parse as a JSON object
- **THEN** no resource is created for it
- **AND** the chat renders it as an ordinary code block, unchanged

#### Scenario: an identical spec never creates a second entry

- **WHEN** the same chart spec is produced again — in another turn, another session, or a regenerated answer
- **THEN** the library still holds exactly one resource for that spec
- **AND** that resource's last-seen time is refreshed

#### Scenario: charts from scheduled-task turns are captured too

- **WHEN** a scheduled task's turn produces a chart
- **THEN** the chart is captured by the same rule as an interactive turn

#### Scenario: same-turn MCP calls are retained as binding candidates

- **WHEN** an assistant turn draws a chart from an MCP call and the chart is captured
- **THEN** the capture records that call's exact name, arguments, and result as a binding candidate for the chart
- **AND** the candidate does not by itself attach any binding

### Requirement: Files enter the library by explicit save, and saved bytes are durable copies

A file SHALL become a resource by explicit save — the user's save action from a chat surface, or the model's save tool during a turn — and only files produced inside the agent workspace SHALL be savable (uploads and documents already have an owning library and SHALL NOT be duplicated here). Every explicit save, from either channel, SHALL pass the same gate and take the same durable path: the file's bytes are copied into the resources data directory under a path derived from the resource id, so the resource survives later changes to the workspace; the resource SHALL record the original workspace-relative path, the byte size, and a content hash. A same-content save SHALL NOT create a duplicate entry. A file exceeding the configured per-resource size cap SHALL be refused with a clear error and nothing SHALL be copied. Saving a file whose source no longer exists SHALL fail with a clear error. Deleting a file resource SHALL remove both the row and the stored bytes.

#### Scenario: saving a generated file makes it durable

- **WHEN** the user saves a workspace file as a resource
- **THEN** the bytes are copied into the resources data directory
- **AND** the resource can be previewed and downloaded even after the workspace file is modified or removed

#### Scenario: a model save takes the same durable path

- **WHEN** the model saves a workspace file through the save tool
- **THEN** the bytes are copied by the same path as a user save, with a source value that distinguishes the model save

#### Scenario: saving the same file twice does not duplicate it

- **WHEN** the user saves a file whose content hash already exists in the library
- **THEN** no new resource is created
- **AND** the user is told it is already in the library

#### Scenario: oversize and missing sources are refused

- **WHEN** the user saves a file larger than the size cap, or one that no longer exists in the workspace
- **THEN** the save fails with a message naming the reason
- **AND** no partial bytes are left in the resources directory

### Requirement: Files a turn produced are captured into the library automatically

Every assistant turn mirrored to the project database SHALL be examined for produced files, and each produced file that passes the gate SHALL be recorded as a `file` resource with `source=auto` and no user action. Which files a turn produced SHALL follow the shared produced-file rule (the same rule the chat clients apply). Each candidate SHALL be gated before capture: its path SHALL resolve inside the agent workspace (lexical containment and realpath), the target SHALL be a regular file within the per-resource size cap, and candidates that fail SHALL be skipped. Capture SHALL store a durable copy of the bytes and the turn's provenance (session id, session title snapshot, message id), deduplicated by content hash across the cell: a candidate whose bytes are already in the library SHALL NOT create a second entry — its last-seen time is refreshed; bytes that differ SHALL create a new row. Capture SHALL apply to every lane that mirrors turns (interactive clients, scheduled tasks, delegation), because it rides the shared mirror funnel. A capture failure SHALL be logged and SHALL NOT fail the message mirror.

#### Scenario: a turn-produced archive appears in Outputs without user action

- **WHEN** an assistant turn's shell call produces an archive in the workspace
- **THEN** a `file` resource for it exists in the library with `source=auto`
- **AND** the Outputs Files panel lists it with the turn's session provenance

#### Scenario: candidates outside the workspace are refused

- **WHEN** the produced-file rule yields a path outside the agent workspace (for example a redirect into `/tmp`)
- **THEN** no resource is created for it

#### Scenario: same bytes refresh, changed bytes add

- **WHEN** a later turn produces a file whose content hash already exists in the library
- **THEN** no second row is created and the existing row's last-seen time is refreshed
- **WHEN** the same path is produced again with different bytes
- **THEN** a new row is created and the earlier row is preserved

#### Scenario: capture never fails the mirror

- **WHEN** the capture path encounters an error (unreadable file, storage failure, unexpected exception)
- **THEN** the assistant message is still mirrored to the database unchanged
- **AND** the failure is logged server-side

#### Scenario: scheduled-task and delegation turns are captured

- **WHEN** a scheduled task or delegation turn produces a workspace file
- **THEN** the file is captured by the same path as interactive turns

### Requirement: Resource management API

The cell SHALL expose a REST surface for the library: list (with type filtering, text search over titles, pagination, a creation-time window, and type-group filtering by file kind), save a workspace file, rename, and delete. The list SHALL accept a creation-time window as absolute `since`/`until` timestamps and a set of type groups: the chart group (matching `type=chart`) plus file groups derived from the file's extension — document, spreadsheet, image, slideshow, archive, web, data, other — under a single server-side extension→group mapping shared by every caller. A resource SHALL match the group filter when its own group is among the selected groups. The surface SHALL additionally expose per-group counts (charts counted in the chart group) computed against the active creation-time window and title search but independently of the type-group selection. Chart payloads SHALL be included in list responses so a client can render charts without a second request. Every mutation SHALL be reflected to connected clients of that cell as a library-change event, so open lists and counts reconcile without a manual reload. For bound charts the surface SHALL additionally expose: attach a binding (from a retained candidate), detach a binding, trigger a refresh, set a binding's refresh rule (TTL and cron), and list a bound chart's observation timeline with its as-of reconstruction query — each mutation broadcast through the same library-change event mechanism. Requests that are not authenticated as the cell's user SHALL be rejected by the existing cell auth gate. All routes SHALL be accessible with the same credentials as the rest of the client API — no new auth mechanism is introduced.

#### Scenario: list, filter, and search

- **WHEN** a client lists resources with a type filter or a title query
- **THEN** only matching resources are returned, most recent first, with pagination metadata

#### Scenario: rename and delete round-trip

- **WHEN** a client renames a resource
- **THEN** the new title is persisted and included in subsequent listings
- **WHEN** a client deletes a resource
- **THEN** it disappears from listings and its stored bytes (for files) are removed

#### Scenario: an open client sees a capture arrive

- **WHEN** a chart is captured while a client has the library open
- **THEN** the client receives the library-change event and can show it without a manual reload

#### Scenario: binding mutations round-trip through the API

- **WHEN** a client attaches a binding from a retained candidate, sets a refresh rule, and triggers a refresh
- **THEN** all three are reflected in the resource's subsequent listings
- **AND** the observation timeline endpoint returns the refresh that just ran

#### Scenario: an unauthenticated refresh request is rejected

- **WHEN** a request to any of the binding or refresh routes arrives without the cell's identity
- **THEN** it is rejected by the existing auth gate, not by new logic

#### Scenario: time window and type groups combine

- **WHEN** a client lists resources with a creation-time window of the last 7 days and the document and spreadsheet groups selected
- **THEN** only file resources created inside the window whose extension maps to document or spreadsheet are returned, most recent first

#### Scenario: facet counts follow the window, not the group selection

- **WHEN** a client requests group counts with a creation-time window set and only the document group selected
- **THEN** counts are returned for every group, narrowed by the window and title search, including groups that are not selected

### Requirement: Stored bytes are served through the existing rooted file route

Stored file bytes SHALL be served by the existing read-only file route with a third configured root pointing at the resources data directory, so the route's existing guarantees — real-path containment, symlink escape rejection, absolute-path rejection, `404` for missing files, inline-versus-download disposition by type — apply unchanged. The resources root SHALL be write-protected in the sense that only the save path writes to it; the serving route SHALL remain strictly read-only.

#### Scenario: a stored file is served like any other rooted file

- **WHEN** a client requests a stored resource file through the file route with the resources root
- **THEN** the bytes are returned with the same disposition rules as workspace and uploads files

#### Scenario: traversal attempts against the resources root are rejected

- **WHEN** a request against the resources root contains `..` segments, an absolute path, or a symlink escaping the root
- **THEN** the request is rejected without reading anything outside the root

### Requirement: Charts already in history can be seeded into the library

A seeding path SHALL exist that scans previously recorded assistant messages and captures their chart fences by the same parse and dedupe rules, so charts produced before the library existed are not lost. Automatic seeding SHALL run at most once per cell, guarded by a completion marker; an explicit operator invocation may re-run it at any time (which may re-create entries a user had deleted — a documented consequence of the manual re-run, never of the automatic one).

#### Scenario: upgrade seeds existing charts

- **WHEN** a cell upgrades to a version with the library and the seeding has never run
- **THEN** charts found in previously recorded assistant messages appear in the library

#### Scenario: the automatic seeding never repeats

- **WHEN** the cell restarts after a seeding run completed
- **THEN** no second automatic seeding occurs
- **AND** resources deleted in the meantime are not resurrected

### Requirement: The model saves files into the library through a turn tool

The cell SHALL expose a model-visible save tool that ingests workspace files into the library during the turn, so a delivered file reaches the library even when the automatic capture rule cannot recognize how it was produced. The tool SHALL accept a list of workspace paths (relative or absolute), at most 10 per call — excess paths SHALL be refused individually with a reason, not silently dropped — and SHALL refuse directories with a reason. The resource title SHALL default to the file name. Saving SHALL be immediate: no user confirmation gate stands between the tool call and the library entry, because the user's conversational request is the confirmation. Every path SHALL pass the same gate as an explicit save (workspace containment, size cap, content dedupe), and the tool SHALL return one result per path — saved, already-saved, or refused with a reason — so the model can report the outcome to the user. A save through the tool SHALL record session-level provenance (the current turn's session id and session title snapshot) without a message reference. The tool SHALL reach the platform over the cell's loopback bridge only: the route it calls SHALL accept loopback callers with no session credential and SHALL reject every non-loopback caller through the existing auth gate.

#### Scenario: a script-produced file reaches the library by tool

- **WHEN** a turn's script writes a file the automatic capture rule cannot recognize, and the model calls the save tool with its path
- **THEN** a `file` resource for it exists in the library with the turn's session provenance

#### Scenario: per-path results come back to the model

- **WHEN** the model calls the tool with three paths of which one is over the size cap
- **THEN** the tool returns two saved results and one refusal naming the reason
- **AND** the two saves stand; the refusal creates nothing

#### Scenario: an already-saved file reports instead of duplicating

- **WHEN** the tool saves a file whose content hash already exists in the library
- **THEN** the result is already-saved, no second row is created, and the existing row's last-seen time is refreshed

#### Scenario: the eleventh path is refused, not dropped

- **WHEN** the model calls the tool with 11 paths
- **THEN** the first 10 are processed normally and the 11th is refused with a reason naming the per-call cap

#### Scenario: a directory is refused

- **WHEN** the model calls the tool with a path that resolves to a directory
- **THEN** that path is refused with a reason and nothing is copied for it

#### Scenario: a non-loopback caller faces the full gate

- **WHEN** a request to the tool's route arrives from a non-loopback address
- **THEN** it is rejected by the existing auth gate, not by new logic

### Requirement: 存单元行 tier/tags 镜像

资源库/成果存单元行 SHALL 携带 `tier`（draft|stable|canonical，默认 draft 于自动捕获）与 `tags` 的镜像字段，若 fd-memory 未配置可全量置空；真源为 fd-memory reference 页，行存镜像只用于列表与筛选性能，tier/tags 变更以一端（fd-memory reference 页）为写主，镜像行 SHALL 经由受信写面同步而非客户端直改。迁移行在历史存量统一初始化为 draft。

#### Scenario: 列表快速筛 canonical 不背跨服务依赖

- **WHEN** 成果页按 tier=canonical 列出
- **THEN** 走本地镜像列一级查询，无需每行实时问 fd-memory

#### Scenario: 记忆服务不可达时的降级

- **WHEN** fd-memory 未配置
- **THEN** 镜像列保持空零值与既有行读不受影响，成果列出照旧（tier 证章灰态）

### Requirement: 手势写面（记住/钉正典/改 tag）

服务端 SHALL 暴露面向存单元行/资料库条目的记忆手势接口：`记住`（已是记忆的幂等注册 / 未注册则建 reference 页）、`标为正典`（tier 晋级，human 来源）、`改 tag`（增删改并写 correction note）；接口 MUST 以用户身份落 origin 与执行幂等，写真源后同步镜像行，任何 fd-memory 失败以结构化降语答（不写乱态）。

#### Scenario: 成果项上点「标为正典」

- **WHEN** 用户对某 draft 成果按 prompt 手势
- **THEN** reference 页 tier=canonical（human 来源）、行镜像同步，及 AI 发本意入进记忆

### Requirement: save 时自动落 reference 页

成果／资料库入仓（auto capture 或 manual save）SHALL 顺路在 fd-memory 建立对应 reference 页：title/summary（从类型与生成上下文派生）、source_ref 指向该库存行、初始 tier=draft、空 tags交由打标支线；未配置记忆服务时该步静默跳过，不阻塞入仓。

#### Scenario: 手动保存文件即落记忆页

- **WHEN** 用户在对话里点「 存入成果 」
- **THEN** 存单元行入仓且 fd-memory 同步出现 reference 记录待打标
