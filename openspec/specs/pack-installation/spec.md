# pack-installation Specification

## Purpose
What subscribing to a pack does inside the subscriber's cell: one-click materialization of a version snapshot into skills, MCP connections, and agents — with conflict handling, per-part reporting, explicit updates, and uninstall semantics.

## Requirements

### Requirement: One action materializes the whole pack

Subscribing to a pack SHALL be a single user action that installs the subscribed version's snapshot: every skill becomes available for invocation through the platform's existing skill pipeline, every MCP reference becomes an installed connectable server, and every agent entry becomes selectable in the agent picker. No part of the install SHALL require per-part user actions. A pack whose skills carry executable-content files (scripts) SHALL present exactly one upfront acknowledgment naming the count of script files before the install proceeds — one acknowledgment for the whole pack, never per part; a pack without script files keeps the previous zero-friction flow. A skill entry with an auxiliary file set SHALL materialize as a complete directory tree (skill document plus auxiliary files) so the runtime resolves the skill's resources against its own directory; an entry without one materializes exactly as the single-file skill of the previous contract.

#### Scenario: Full pack installs in one action

- **WHEN** a user subscribes to a pack with two skills, one MCP reference, and one agent
- **THEN** after the single subscribe action completes, both skills are invocable, the MCP server is installed and connectable, and the agent appears in the picker

#### Scenario: Multi-file skill materializes as a tree

- **WHEN** a subscribed pack contains a skill whose entry carries `references/method.md` and `scripts/run.py`
- **THEN** the installed skill's directory contains the skill document and both auxiliary files at their relative paths, and a conversation referencing them resolves the paths against the skill's directory

#### Scenario: Script-bearing pack asks once, upfront

- **WHEN** a user subscribes to a pack whose skills carry three script files in total
- **THEN** the install flow presents one acknowledgment naming three script files, and confirming it installs the whole pack
- **AND** an install request for a script-bearing pack that arrives without the confirmation marker is rejected server-side and installs nothing

#### Scenario: Script-free pack keeps the zero-friction flow

- **WHEN** a user subscribes to a pack whose skills carry no executable-content files
- **THEN** the install proceeds exactly as before with no acknowledgment step

### Requirement: Installed content is a version snapshot

Installed skills, MCP references, and agent entries SHALL come from the manifest of the version that was subscribed. They SHALL keep working unchanged regardless of later marketplace events: the author publishing newer versions, or unpublishing the pack entirely.

#### Scenario: Author's new version does not propagate

- **WHEN** the author publishes version 2 and a subscriber installed version 1
- **THEN** the subscriber's skills, MCP connections, and agents still behave exactly as version 1 defined

#### Scenario: Unpublish does not remove installed content

- **WHEN** the author unpublishes a pack that a subscriber installed
- **THEN** the subscriber's installed skills, MCP connections, and agents keep working

### Requirement: Skill conflict policy — never overwrite foreign content

A pack skill whose name collides with an existing skill not owned by that pack (user-created or from another pack) SHALL be skipped and reported with the collision reason; the existing skill SHALL be untouched. Skills owned by the pack itself SHALL be replaced by the pack's current content on install and upgrade — body, auxiliary file set, and stored frontmatter replaced wholesale, with files removed in the new version swept from the materialized tree. The cell SHALL track which skills each installed pack owns.

#### Scenario: Name collision skips and reports

- **WHEN** a pack contains a skill `contract-review` and the subscriber already has a user-created skill with that name
- **THEN** the install completes with that skill skipped, the existing skill is unchanged, and the report names the collision

#### Scenario: Upgrade replaces the pack's own skill

- **WHEN** a subscriber upgrades a pack whose new version changed a skill the pack had installed
- **THEN** the skill is updated to the new version's content

#### Scenario: Upgrade sweeps dropped files

- **WHEN** a pack's new version removes an auxiliary file that the previous version had installed
- **THEN** the materialized skill directory no longer contains that file

### Requirement: MCP references resolve through the subscriber's own credentials

Each MCP reference SHALL resolve through the existing registry-market install path using the subscriber's own registry credential; the pack SHALL NOT carry or transfer any secret. A server already installed in the cell SHALL be reused, not duplicated. A reference whose name matches a locally installed server row (a user-deployed server, not a registry-market entry) SHALL bind to that local row: the binding is recorded with the pack's installed state, the local row's configuration is neither overwritten nor extended by the install, and no group gate applies to a local binding. A reference that resolves to neither — no registry catalog entry and no local row of that name — SHALL be reported as awaiting-local-binding in the install report without blocking the other parts; it becomes a bound reference when a server of that name is later installed or connected in the cell, with no reinstall of the pack required. A reference that names a registry entry the subscriber cannot use — the server is no longer in the visible catalog, or the subscriber's groups do not grant access — SHALL be reported as unavailable in the install report without blocking the other parts. An allowlist declared on the reference SHALL travel with the resolution: reused, bound, and awaiting-local-binding references all keep their declared tool names in the installed record, to take effect in focused mode (openspec: pack-agent-scoping).

#### Scenario: Registry MCP installs under the subscriber's credential

- **WHEN** a subscriber without a live registry credential subscribes to a pack with a registry MCP reference
- **THEN** the install routes through the existing connect flow for that credential before the server connects, and the pack carries no secret of any kind

#### Scenario: Already-installed server is reused

- **WHEN** a pack references a registry server the subscriber already installed
- **THEN** the install reuses the existing configuration and the report marks the part as reused

#### Scenario: Missing server is reported, not fatal

- **WHEN** a pack references a registry server that is not in the subscriber's visible market catalog and no local server of that name is installed
- **THEN** the rest of the pack installs and the report names the unresolvable reference with its reason

#### Scenario: Local same-name row binds without overwriting

- **WHEN** a pack references a server name that exists in the cell as a user-deployed (non-registry) server row
- **THEN** the install records a binding to that local row, the local row's configuration is untouched, and the report marks the part as bound

#### Scenario: Unresolved local name awaits binding

- **WHEN** a pack references a server name with neither a registry catalog entry nor an installed local row
- **THEN** the install completes for the other parts and the report marks the reference as awaiting-local-binding with guidance to install or connect a server of that name

#### Scenario: Later local install activates the binding

- **WHEN** an installed pack holds an awaiting-local-binding reference and the user installs or connects a server of that name
- **THEN** the reference becomes bound on the next composition without any reinstall of the pack

#### Scenario: Local binding carries no group gate

- **WHEN** a pack references a local server name and the subscriber holds none of the groups any registry gate would consult
- **THEN** the local binding still records and the local server remains usable through the pack's roles

### Requirement: Install report

Every subscribe, upgrade, and unsubscribe action SHALL produce a per-part report stating, for each skill, MCP reference, and agent, one of: installed, reused, replaced, skipped or unavailable with a reason, bound or awaiting-local-binding with guidance, or removed. The report's skill rows SHALL additionally state the entry's auxiliary file count and name the entry's script files, so a subscriber can see what file content arrived. The UI SHALL show the report after the action.

#### Scenario: Partial failure is visible

- **WHEN** a subscribe completes with one skill skipped for a name collision and one MCP reference unresolvable
- **THEN** the report lists every part with its outcome, and the failed parts carry their reasons

#### Scenario: Binding states are visible

- **WHEN** a subscribe completes with one MCP reference bound to a local server and another awaiting-local-binding
- **THEN** the report lists both with their binding outcomes, and the awaiting part names what the user can do to activate it

#### Scenario: File content is disclosed per skill

- **WHEN** a subscribe completes with a skill that installed six auxiliary files, two of them scripts
- **THEN** that skill's report row states six files and names the two script files

### Requirement: Pack agents run as local personas

A subscribed pack's agent entries SHALL appear in the subscriber's agent picker and, when selected, SHALL run as a local persona in the subscriber's runtime — the platform's currently selected model with the pack persona's behavior — composed with the pack's resource set and the deployment baseline (openspec: pack-agent-scoping): the pack's own skills and MCP references plus the deployment's always-on baseline, not the subscriber's entire installed surface. Switching back to a shipped mode or the built-in agent restores the full surface.

#### Scenario: Pack agent selectable and local

- **WHEN** a subscriber selects a pack's agent and sends a message
- **THEN** the persona runs in the local runtime and can invoke the pack's skills and MCP tools plus the deployment baseline in the same conversation

#### Scenario: Focus follows the existing switch contract

- **WHEN** a subscriber selects or deselects a pack's agent
- **THEN** the focus change applies through the same preset-switch path as before this change (rejected while streaming, applied to the next session, broadcast to clients)

### Requirement: Updates are explicit

When the marketplace holds a newer version of an installed pack, the installed pack SHALL surface an update affordance showing the installed and latest version numbers. Upgrading SHALL be an explicit user action that materializes the new version under the same conflict policy. The system SHALL NOT propagate new versions automatically, and downgrade SHALL NOT be offered.

#### Scenario: Update badge appears

- **WHEN** the author publishes version 3 and a subscriber has version 2 installed
- **THEN** the subscriber's installed-pack view shows that an update to version 3 is available

#### Scenario: Upgrade is opt-in

- **WHEN** the update affordance is visible and the subscriber does not act
- **THEN** nothing about the installed version 2 changes

### Requirement: Unsubscribe removes pack-owned content only

Unsubscribing SHALL remove the pack's owned skills and agent entries. It SHALL warn before removing a pack skill whose content the user modified after installation — modified meaning the body, the auxiliary file set, or the stored frontmatter diverges from the installed version's manifest. It SHALL NOT remove MCP server configurations, which are shared utilities that manual installs and other packs may also reference.

#### Scenario: Uninstall removes skills and agent

- **WHEN** a subscriber unsubscribes from a pack with two skills and one agent
- **THEN** the pack-owned skills disappear from the skill list and the agent disappears from the picker

#### Scenario: Modified skill warns before removal

- **WHEN** a subscriber edited a pack skill's content and then unsubscribes
- **THEN** the uninstall flow warns that the modified skill will be lost and requires explicit confirmation

#### Scenario: Edited auxiliary file also warns

- **WHEN** a subscriber edited one auxiliary file of a pack skill and then unsubscribes
- **THEN** the uninstall flow warns that the modified skill will be lost, same as a body edit

#### Scenario: MCP configurations survive unsubscribe

- **WHEN** a subscriber unsubscribes from a pack whose MCP reference was installed by the subscribe action
- **THEN** the MCP server configuration remains installed and connectable

### Requirement: The cell records installed packs

The cell SHALL record each installed pack (identifier, version, per-part state) and expose the list to the user. This installed-pack state — not the gateway's subscription records — is what determines what is materialized in the cell and what the update and unsubscribe flows act on.

#### Scenario: My packs lists versions

- **WHEN** a user with two installed packs opens the installed-packs view
- **THEN** both packs are listed with their installed version numbers and per-part status

### Requirement: Manifest retrieval is server-side

Installing a pack SHALL NOT require the client to transmit the pack manifest.
The install endpoint SHALL accept `{packId, version}` and retrieve that
version's manifest from the marketplace server-side before running the existing
validation and materialization pipeline. A request that still carries a
manifest body SHALL continue to be accepted and SHALL be validated by the same
rules (rolling compatibility). **A third shape SHALL be accepted: a locally
supplied offline bundle, whose manifest snapshot and resource files enter the
identical pipeline through `POST /api/mypacks/import-bundle` (`offline-pack-supply`
capability) — no separate validation chain, identical rules.** Retrieval SHALL
be performed under the calling user's identity so that private-pack visibility
semantics are unchanged. If the manifest cannot be retrieved, the install SHALL
fail with a clear error and materialize nothing.

#### Scenario: Client sends only packId and version

- **WHEN** the UI posts `{packId, version}` for a pack whose manifest contains code snippets
- **THEN** the server fetches the manifest from the marketplace, validates it, and materializes the pack exactly as before

#### Scenario: Private pack visibility follows the caller

- **WHEN** a user installs a private pack they are allowed to see
- **THEN** the server-side retrieval is evaluated under that user's identity and succeeds; a user without access gets the same not-found behavior as the market listing

#### Scenario: Retrieval failure installs nothing

- **WHEN** the marketplace is unreachable or the version does not exist
- **THEN** the response reports the failure and no skill, MCP reference, or agent is written

#### Scenario: Body manifest still accepted

- **WHEN** a request includes a manifest body during the compatibility window
- **THEN** it is processed through the identical validation pipeline as a server-retrieved manifest

#### Scenario: Offline bundle enters the same pipeline

- **WHEN** a valid `.yizpack` is imported on a machine with the marketplace unreachable
- **THEN** the pack installs through the identical validation and materialization pipeline, and the install record and report mark the source as `bundle`

### Requirement: 安装来源可区分

安装记录与安装报告 SHALL 记录来源字段（`market` | `bundle`；历史行缺省视为
`market`）。SHALL 保持向后兼容：既有读面与客户端不识别该字段时行为不变，
不因来源字段产生新的安装门。

#### Scenario: 老读面不受影响

- **WHEN** 一个只认识既有字段的读面列举已安装 pack
- **THEN** 输出与引入来源字段前等价，仅多出可忽略字段

### Requirement: 可更新数量在已装列表可见

已装功能集列表 SHALL 在存在可更新包时显示可更新数量（例如「3 个可更新」），该数量 SHALL 由「已装版本 < 市场最新版本」逐包比对得出，与单包更新按钮的判据**同源**（不得一处显示有更新、另一处不显示）。数量为 0 时 SHALL NOT 显示该提示——没有待办时不制造噪音。

市场不可达时 SHALL 如实降级：不显示数量提示，且 MUST NOT 把「查不到最新版本」渲染成「已是最新」。

#### Scenario: 有更新时显示数量

- **WHEN** 用户装了 5 个包，其中 2 个的市场最新版高于已装版
- **THEN** 列表顶部显示「2 个可更新」
- **AND** 那 2 个包各自仍显示自己的更新按钮（单包入口不因批量入口出现而消失）

#### Scenario: 全部最新时不显示

- **WHEN** 所有已装包都已是市场最新版
- **THEN** 列表不出现可更新数量提示

#### Scenario: 市场不可达时如实降级

- **WHEN** 市场列表读不到
- **THEN** 不显示可更新数量
- **AND** MUST NOT 显示「已是最新」——那是把未知当成已知

### Requirement: 一键更新全部是显式动作的批量执行

列表 SHALL 在可更新数量大于 0 时提供「全部更新」动作。触发后 SHALL 对每一个可更新的包**串行**执行既有升级路径（同一订阅 + 安装链、同一冲突策略），MUST NOT 引入第二条安装路径或新的传播机制。

该动作 SHALL 是一次显式用户动作，SHALL NOT 由计时、进入页面或任何后台流程触发；MUST NOT 自动升级、MUST NOT 降级。执行期间 SHALL 呈现进行中状态并禁止重复触发。

#### Scenario: 批量走同一条安装链

- **WHEN** 用户点「全部更新」且有 2 个包可更新
- **THEN** 两个包各自经既有的订阅 + 安装调用完成
- **AND** 每个包的冲突处理与单包升级时一致

#### Scenario: 不自动触发

- **WHEN** 用户打开已装列表但从不点击「全部更新」
- **THEN** 没有任何包被升级，已装版本不变

#### Scenario: 执行中不可重复触发

- **WHEN** 批量更新正在进行
- **THEN** 「全部更新」动作不可再次触发
- **AND** 界面显示进行中状态

### Requirement: 批量结果逐条如实回执

批量更新结束后 SHALL 逐条呈现每个包的结果，区分为 `updated`（已升到新版本）、`already-latest`（执行时已是最新）、`failed`（附失败原因）。MUST NOT 把失败项汇总成一个笼统的「部分失败」而隐去具体包与原因。

任一条失败 SHALL NOT 中断其余包的更新。失败项 SHALL 在列表中保持可见（其更新按钮仍在），使用户可以单独重试。

#### Scenario: 部分失败不掩盖

- **WHEN** 3 个包可更新，其中 1 个安装失败
- **THEN** 呈现结果显示 2 个 updated、1 个 failed 并附该包的失败原因
- **AND** 该失败包仍显示更新按钮，可单独重试

#### Scenario: 失败不中断其余

- **WHEN** 第一个包在批量中失败
- **THEN** 其余包仍继续更新并按各自结果回报

#### Scenario: 已是最新被如实标注

- **WHEN** 某个包在批量执行到它之前已被其它途径升到最新
- **THEN** 它的结果为 `already-latest`，MUST NOT 报成 `failed`
