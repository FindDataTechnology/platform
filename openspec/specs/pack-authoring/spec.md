# pack-authoring Specification

## Purpose
How creators compose a pack inside their own cell — drafts, the manifest content model, and the publish action that freezes a version into the marketplace.

## Requirements

### Requirement: Pack drafts persist in the author's cell

A creator SHALL be able to create, edit, and delete pack drafts in their own cell. A draft SHALL contain a display name, description, tags, a list of skill entries, a list of MCP references, and a list of agent persona entries. Drafts SHALL persist in the author's cell storage across restarts and SHALL remain private to the author's cell until published.

#### Scenario: Draft survives a restart

- **WHEN** the author saves a draft, the cell restarts, and the author reopens the pack editor
- **THEN** the draft is listed with all its entries exactly as saved

#### Scenario: Drafts stay private

- **WHEN** a draft exists in the author's cell and it has never been published
- **THEN** no other user can see any trace of it in the marketplace

### Requirement: Drafts can be pre-filled from a custom preset

The platform SHALL provide a server-side conversion that creates a new pack draft from one of the author's custom presets, resolving reference migratability itself. The conversion SHALL carry the preset's display name, persona text, tags, and icon verbatim into the draft and its single agent entry, and SHALL pre-set that agent entry's serving contract to the A2A protocol declaration (the author MAY remove it). Skill references that resolve to the author's own skills or the deployment baseline SHALL be inlined as draft skill entries with their full bodies; references to other packs' skills SHALL NOT be carried. MCP references that resolve to a market-catalog entry SHALL be stored as that entry's registry-name reference; unmatched references SHALL NOT be carried. The conversion response SHALL carry a report listing what was inlined and what was left for the author to replace, and the editor SHALL surface that report. A converted draft is an ordinary draft: it validates, publishes, and diverges from its source preset freely, with no synchronization in either direction.

#### Scenario: All-migratable preset converts clean

- **WHEN** the author converts a preset whose skills are all their own or baseline and whose servers all match market-catalog entries
- **THEN** the created draft inlines every skill with its body, stores every server as a registry-name reference, carries the persona verbatim, pre-sets the A2A serving contract, and the report lists everything as inlined with nothing pending

#### Scenario: Foreign skill is flagged, not carried

- **WHEN** the converted preset references a skill owned by an installed pack
- **THEN** the draft omits that skill and the report lists it as pending replacement, naming the owning pack

#### Scenario: Unmatched server is flagged, not carried

- **WHEN** the converted preset references a server with no counterpart in the market catalog
- **THEN** the draft omits that server and the report lists it as pending replacement

#### Scenario: Converted draft is ordinary

- **WHEN** the author edits the converted draft and publishes it
- **THEN** it goes through the same validation and publish gate as any draft, and subsequent edits to the source preset never reach the published pack

#### Scenario: Serving contract is pre-set but removable

- **WHEN** the conversion creates the agent entry
- **THEN** the entry carries the A2A serving declaration, and the author can remove it in the editor exactly like a hand-authored entry

### Requirement: Skills are composed inline

Each draft skill entry SHALL carry a name, a description, and the full skill body, edited with the same conventions as the platform's custom skills. An entry MAY additionally carry an auxiliary file set (a mapping of relative paths to text contents) and a stored frontmatter object — a package-shaped skill. The editor SHALL validate skill-name format and per-entry size limits (body, auxiliary files, frontmatter together) before a publish can be submitted, and SHALL reject auxiliary paths that escape the skill directory, non-text file kinds, and file names that collide with the rendered skill document under case-insensitive filesystems. An entry without auxiliary files and frontmatter behaves exactly as the single-file skill of the previous contract.

#### Scenario: Author writes a skill body

- **WHEN** the author adds a skill entry with name, description, and body and saves the draft
- **THEN** the entry persists and is listed in the editor with its body editable

#### Scenario: Malformed skill name is caught before publish

- **WHEN** the author enters a skill name with characters outside the allowed format and attempts to publish
- **THEN** the editor blocks the publish and names the offending entry

#### Scenario: Author uploads a package into a draft entry

- **WHEN** the author uploads a skill package (zip) into a draft skill entry
- **THEN** the package is parsed server-side under the platform's package contract (path safety, text-only admission, per-file and per-skill bounds), the entry receives the parsed body and auxiliary file set, and the editor shows the file inventory
- **AND** a package that violates the contract is rejected with a reason naming the offending file or limit

#### Scenario: Author imports an installed multi-file skill into a draft

- **WHEN** the author imports a locally installed skill that carries auxiliary files
- **THEN** the draft entry carries the skill's body, auxiliary file set, and stored frontmatter

### Requirement: MCP entries are picked from the market catalog

The author SHALL select MCP entries from the registry-sourced entries of the cell's market catalog; the draft SHALL store a registry-name reference (with the entry's display metadata for preview). A draft MCP reference MAY carry a tool allowlist: a list of tool leaf names narrowing the reference to exactly those tools. The editor SHALL offer the allowlist as a picker over the server's tool list as served by the market catalog; free-form tool-name entry SHALL be rejected by the editor the same way free-form endpoints are. A draft reference MAY instead be marked `fullSurface` with a reason, declaring that the pack intentionally uses the server's whole tool surface. A draft MAY be saved with neither (work in progress), but publishing requires one of the two (openspec: pack-authoring, Publish requires an explicit tool face and validates it). The v1 editor SHALL NOT offer a free-form endpoint or command entry for MCP entries.

#### Scenario: Picker lists registry servers

- **WHEN** the author opens the MCP picker
- **THEN** the registry-sourced market entries visible to the author are listed and selectable

#### Scenario: No free-form MCP entry

- **WHEN** the author composes the MCP list of a draft
- **THEN** no field accepts a URL or command configuration

#### Scenario: Tool allowlist narrows a reference

- **WHEN** the author picks a registry server and selects three of its listed tools as the reference's allowlist, then saves the draft
- **THEN** the entry persists with the registry-name reference plus exactly those three tool leaf names, and the editor previews the narrowed tool count

#### Scenario: Absent allowlist keeps the full surface

- **WHEN** the author saves an MCP reference without selecting tools
- **THEN** the entry persists as a draft with no allowlist; its published runtime behavior is the full tool surface only if the author marks it `fullSurface` with a reason before publishing

#### Scenario: Tool names come from the picker, not typing

- **WHEN** the author attempts to enter a tool name that is not in the catalog-served tool list for that server
- **THEN** the editor rejects the entry instead of accepting a free-form name

### Requirement: Resource declarations may narrow tools per role

An agent entry's resource declaration MAY carry an `mcpTools` dimension: a mapping from the draft's own MCP references to tool leaf names. The declaration SHALL only narrow — a role's tool set SHALL be a subset of the pack-level allowlist for that reference (or of the server's full list when the pack declares none); a role SHALL NOT widen a pack-level allowlist. Names SHALL reference only the draft's own MCP entries, and tool names SHALL exist within the referenced entry's declared allowlist or its catalog-served tool list. An absent `mcpTools` dimension means the role uses the pack-level allowlist for every reference; a present-but-empty mapping for a server yields no tools for that server to that role. The same dimension semantics as skills and MCP references apply: foreign names are caught before publish, dimensions scope independently.

#### Scenario: Per-role tool narrowing validates

- **WHEN** a role's declaration maps one of the draft's MCP references to two tool names that appear in that reference's allowlist, and the author saves
- **THEN** the entry persists and the role's later focused runtime exposes only those two tools of that server

#### Scenario: Widening beyond the pack-level allowlist is caught

- **WHEN** a role's declaration names a tool that the pack-level allowlist for that reference excludes, and the author attempts to publish
- **THEN** validation blocks the publish naming the role, the reference, and the offending tool

#### Scenario: Foreign server name in mcpTools is caught

- **WHEN** a role's declaration maps a server name that is not one of the draft's own MCP references
- **THEN** validation blocks the publish naming the offending role and server

#### Scenario: Absent dimension inherits the pack-level allowlist

- **WHEN** a role's declaration omits the mcpTools dimension while the pack declares an allowlist for a reference
- **THEN** the role's focused runtime uses that reference's pack-level allowlist exactly

### Requirement: Agents are persona entries

Each draft agent entry SHALL carry a display name, persona text, and optional tags and icon. An agent entry MAY carry a resource declaration naming, per role, a subset of the draft's own skill entries and MCP references; each dimension (skills, MCP) is optional, and an absent dimension means the role uses the whole pack's set for that dimension. The editor SHALL offer per-role resource pickers listing only the draft's own skill entries and MCP references, and SHALL surface a persona cost readout (approximate tokens per turn) alongside the persona text while editing. The editor SHALL NOT accept endpoint, model, or credential fields for agent entries — pack agents run as local personas on the platform's currently selected model.

An agent entry MAY additionally carry a serving contract (`serving`): a declaration that the role is deployable as an Agent Service over the A2A protocol (openspec: a2a-agent-serving). The contract SHALL contain a protocol identifier and an optional manual card declaration; absent card fields SHALL be derived at deploy time from the role's name/description/tags. The contract MAY additionally carry a work rhythm (`serving.rhythm`): a declarative list of schedules (and, in later versions, event sources) the deployed agent works by — a rhythm is the autonomy grant, and a contract without one deploys an agent that only answers (openspec: agent-residency). Rhythm entries SHALL be schedule declarations only; validation SHALL reject rhythm fields that name models, endpoints, or credentials. The contract MAY additionally carry a turn budget (`serving.budget.turnMinutes`): a whole-number ceiling in minutes on any single turn of the deployed agent — the budget is a duration declaration, and validation SHALL reject budget shapes that are not a positive whole number within the platform cap. The contract's card capability declarations live under the contract's own namespace and are distinct from the pack's skill files — same word, different meaning — and validation SHALL reject contract fields that name endpoints, models, or credentials. When no contract is present, every pre-existing rule of this requirement applies verbatim.

#### Scenario: Persona-only agent entry

- **WHEN** the author adds an agent entry with a display name and persona text and saves the draft
- **THEN** the entry persists with exactly those fields and no endpoint or model field exists in the editor

#### Scenario: Per-role picker offers only the draft's own entries

- **WHEN** the author opens a role's resource picker
- **THEN** it lists exactly the draft's skill entries and MCP references, and no free-form skill or server entry exists

#### Scenario: Declaration referencing a foreign name is caught before publish

- **WHEN** a role's declaration names a skill or MCP reference that is not in the draft's own lists and the author attempts to publish
- **THEN** the editor blocks the publish naming the offending role and entry

#### Scenario: Persona cost is visible while editing

- **WHEN** the author edits a role's persona text
- **THEN** the editor shows the current length and an approximate per-turn token cost for it

#### Scenario: Contract-free entries are unchanged

- **WHEN** a draft agent entry carries no serving contract
- **THEN** the entry validates and behaves exactly as before this change

#### Scenario: Minimal contract validates

- **WHEN** the author adds a serving contract consisting of only the protocol identifier and saves
- **THEN** the draft validates and publish succeeds, with card display fields to be derived at deploy time

#### Scenario: Contract cannot smuggle runtime configuration

- **WHEN** a serving contract contains a model, endpoint, or credential field
- **THEN** validation rejects the draft naming the forbidden field

#### Scenario: Card capabilities are namespace-isolated from skill files

- **WHEN** a serving contract declares card capabilities and the pack also ships skill files
- **THEN** the two coexist without collision — the capability declarations never reference or consume the skill files' contents

#### Scenario: Rhythm declares cadence declaratively

- **WHEN** the author adds a serving contract carrying a rhythm of schedule entries and saves
- **THEN** the draft validates and the rhythm travels with the contract as the role's declared work cadence; a contract without a rhythm declares an answering-only agent

#### Scenario: Rhythm cannot smuggle runtime configuration

- **WHEN** a rhythm entry carries a model, endpoint, or credential field
- **THEN** validation rejects the draft naming the forbidden field

#### Scenario: Budget declares a turn ceiling declaratively

- **WHEN** the author adds a serving contract carrying `budget.turnMinutes` of a positive whole number within the platform cap and saves
- **THEN** the draft validates and the budget travels with the contract as the role's declared turn ceiling; a contract without a budget declares no ceiling of its own and the deployment default applies

#### Scenario: Budget rejects non-duration shapes

- **WHEN** `budget.turnMinutes` is not a whole number, is not positive, or exceeds the platform cap
- **THEN** validation rejects the draft naming the offending value

### Requirement: Publish action freezes the next version

Publishing a draft SHALL submit it to the gateway publish endpoint with the author's identity. A successful first publish SHALL return a new pack identifier and version 1; subsequent publishes of the same draft SHALL return the next version number. The draft SHALL remain editable after publishing so the author can prepare the next version. Publish rejections (validation, gate, throttling) SHALL surface in the editor with the returned reason.

#### Scenario: First publish

- **WHEN** the author publishes a draft that passes validation and the creator gate
- **THEN** the response returns a new pack identifier and version 1, and the draft remains in the editor

#### Scenario: Next version

- **WHEN** the author edits a published draft and publishes again
- **THEN** the response returns the same pack identifier with version 2

#### Scenario: Gate rejection surfaces in the editor

- **WHEN** a user without the creator group attempts to publish from the editor
- **THEN** the editor shows the authorization rejection and nothing is published

### Requirement: Pack identifiers are server-assigned

The author SHALL NOT choose the pack identifier. Publishing a draft to a different pack (forking) SHALL be supported by the author explicitly starting a new draft, never by editing an identifier.

#### Scenario: Author cannot set the identifier

- **WHEN** the author composes and publishes a draft
- **THEN** the identifier is assigned by the gateway and is not an editable field anywhere in the editor

### Requirement: Manifests may carry a three-step usage guide

A pack manifest MAY include a `guide` object of the shape `{ steps: [{ title, body }, { title, body }, { title, body }] }` — exactly three steps, each with a non-empty `title` of at most 60 characters and a non-empty `body` of at most 500 characters. The publish validator SHALL reject a manifest whose guide violates this shape (missing steps, wrong count, over-length strings, non-string values) with a readable error, and SHALL accept manifests without a `guide` exactly as before. The guide is content the creator authors in the pack's own language; the platform performs no translation. The creator editor SHALL offer a three-step guide editing section that persists into the draft manifest and is carried through publish unchanged.

#### Scenario: a manifest with a valid guide publishes

- **WHEN** a creator publishes a manifest whose guide has three well-formed steps
- **THEN** the pack publishes and the stored manifest carries the guide unchanged

#### Scenario: a malformed guide is rejected at publish

- **WHEN** a creator publishes a manifest whose guide has two steps, or a step body over 500 characters
- **THEN** publish is rejected with an error naming the guide problem
- **AND** no version is frozen

#### Scenario: packs without a guide are unaffected

- **WHEN** a manifest without a `guide` field is published
- **THEN** validation passes exactly as before this capability

### Requirement: Draft entries carry package content uniformly

A draft skill entry's auxiliary file set and frontmatter SHALL be part of the draft's persisted state regardless of how the entry was created — written by hand, uploaded as a package, imported from an installed skill, or produced by the preset-prefill conversion. Every path that inlines one of the author's own skills into a draft SHALL carry that skill's full stored shape (body, auxiliary files, frontmatter), so a multi-file skill survives the journey into a pack draft without silent loss.

#### Scenario: Prefill from a custom preset keeps files

- **WHEN** the author runs the preset-to-draft conversion and the preset references one of the author's multi-file skills
- **THEN** the resulting draft entry carries that skill's body and its auxiliary file set

#### Scenario: Draft persists files across edit sessions

- **WHEN** the author saves a draft whose entry carries files, closes the editor, and reopens the draft
- **THEN** the entry's file inventory and contents are intact

### Requirement: Publish requires an explicit tool face and validates it

Every MCP reference in a published manifest SHALL carry exactly one of: a non-empty `allowTools` list of tool leaf names, or `fullSurface: true` together with a non-empty `fullSurfaceReason`. A reference carrying neither SHALL fail the publish, naming the pack, the server, and both remedies (declare the tools, or mark the reference full-surface with a reason). A reference carrying both SHALL fail as a shape error.

Tool-level closure SHALL be enforced at publish: every `mcp__<server>__<tool>` reference extracted from the pack's skill bodies SHALL fall inside that server reference's `allowTools`. A `fullSurface` reference is exempt from this closure (its face is the whole surface by definition). A named tool outside the declaration SHALL fail the publish naming the server, the tool, and the skills that reference it.

Declared names SHALL be validated against the referenced registry server's known tool surface, and every allowlist against the server's commercial surface when the server is surface-registered. A name absent from the registry's tool snapshot SHALL fail the publish naming the server and the unknown tools, unless a live probe of the server's tool list confirms the name (snapshot staleness fallback). When the live probe cannot be performed — the endpoint refuses, is unreachable, or answers with a billing or authorization failure — the missing names are UNRESOLVED, never confirmed-absent: the publish SHALL still be refused, and the rejection SHALL state that the names could not be confirmed and name the concrete next step (refresh the registry entry's tool-list snapshot, then publish again, or drop the names) instead of asserting the tools do not exist. For a surface-registered server, any declared tool outside the server's commercial set SHALL fail the publish naming the out-of-surface tools, regardless of probe results. A reference bound to a local (non-registry) server name is exempt from existence and commercial checks — its tool names are validated only where the local server's surface is knowable, and otherwise accepted as declared.

#### Scenario: Undeclared reference fails publish

- **WHEN** the author publishes a draft whose `fd-daas-mcp` reference carries neither `allowTools` nor `fullSurface`
- **THEN** the publish is rejected naming the pack and `fd-daas-mcp`, and the reason lists both remedies

#### Scenario: Both declarations fail as a shape error

- **WHEN** a reference carries both a non-empty `allowTools` and `fullSurface: true`
- **THEN** the publish is rejected naming the reference and the conflict

#### Scenario: Full-surface reference publishes with a reason

- **WHEN** a reference is marked `fullSurface: true` with a non-empty reason
- **THEN** the publish passes the tool-face gate and the version freezes

#### Scenario: Full-surface reference without a reason fails

- **WHEN** a reference is marked `fullSurface: true` with an empty or missing reason
- **THEN** the publish is rejected naming the reference and the missing reason

#### Scenario: Named tool outside the declaration fails publish

- **WHEN** a skill body names `mcp__fd-quant__summarize_drawdown` while the `fd-quant` reference declares only `compute_sma` and `summarize_return`
- **THEN** the publish is rejected naming the server, the tool, and the referencing skills

#### Scenario: Full-surface reference is exempt from closure

- **WHEN** a skill body names a `law-bench` tool and the `law-bench` reference is marked `fullSurface`
- **THEN** the tool-level closure check does not block the publish

#### Scenario: Unknown tool name fails publish

- **WHEN** the author publishes a draft whose MCP reference declares a tool name absent from the registry's tool snapshot for that server and a live probe also does not list it
- **THEN** the publish is rejected naming the server and the unknown tool name, and no version is frozen

#### Scenario: Snapshot staleness falls back to a live probe

- **WHEN** a declared tool name is missing from the registry snapshot but the server's live tool list contains it
- **THEN** the publish passes the name check and the version freezes

#### Scenario: An unavailable probe leaves names unresolved, not absent

- **WHEN** a declared tool name is missing from the registry snapshot and the live probe cannot be performed (the endpoint answers a billing or authorization failure, or is unreachable)
- **THEN** the publish is refused with a reason stating the names could not be confirmed rather than that they do not exist
- **AND** the reason names the next step — refresh the registry entry's tool-list snapshot and publish again, or drop the names

#### Scenario: Out-of-commercial-surface tool fails publish

- **WHEN** the author publishes a reference to a surface-registered server declaring a tool that the server's surface marks internal
- **THEN** the publish is rejected naming the out-of-surface tool, even though the tool exists

#### Scenario: An unlisted server skips commercial closure

- **WHEN** the author publishes a reference declaring tools for a server the registry has not surface-registered
- **THEN** no commercial-closure check applies to that reference (only the existence check does), and the publish proceeds on the name check alone

#### Scenario: Local binding stays exempt

- **WHEN** a reference binds a local (non-registry) server name and declares tools
- **THEN** existence and commercial checks do not apply, and the publish proceeds as declared

### Requirement: 草稿可导出为离线安装包（导出≠发布）

cell SHALL 提供草稿导出：编辑器把草稿编译成完整 manifest 后提交
`POST /api/pack-drafts/:id/export-bundle { manifest }`，服务端以**与安装同一套
`validatePackManifest`** 校验（规则与数量上限一致，离线不免检），通过后打成
`.yizpack`（`offline-pack-supply` 容器：`bundle.json` + `manifest.json` +
sha256 清单 + 确定性打包）返回。导出 SHALL NOT：产生 packId、递增版本、
走创作者门、物化技能/MCP/agent 行、或把草稿标记为已发布——**导出不是发布**，
草稿保持可编辑，后续在线发布沿用既有「冻结下一版本」语义不受影响。

#### Scenario: 断网导出成功

- **WHEN** 编辑器在市场不可达时对草稿执行导出，manifest 通过校验
- **THEN** 返回一个合法 `.yizpack`（digest 可复算），草稿保持可编辑，无任何 packId/版本产生

#### Scenario: 校验失败不落半包

- **WHEN** 提交的 manifest 触发与安装同源的校验错误（如 serving.protocol 非 a2a）
- **THEN** 返回结构化错误（与同内容安装的报错一致），不产出 bundle

#### Scenario: 导出与发布语义分区

- **WHEN** 用户先后执行导出与发布
- **THEN** 导出只产文件，发布才产生 packId/版本；两者互不改变对方的可执行性

### Requirement: bundle 可反向导入为可编辑草稿

cell SHALL 提供 `POST /api/pack-drafts/import-bundle`：接受一个合法 `.yizpack`
（复用 `offline-pack-supply` 的完整校验：摘要/路径/体积闸），把其 manifest 反向
编译为**新的可编辑草稿**（name/description/tags/entries），SHALL NOT 安装该包、
不物化任何技能或 MCP 引用、不触碰已安装列表。导入的草稿与手工创建的草稿
同等可编辑、可再导出、可（在线时）发布。**round-trip 保证**：导出→导入→再导出
SHALL 产出与首次导出摘要一致的 bundle（manifest 相同 → 容器确定性打包相同）。

#### Scenario: 往返编辑

- **WHEN** 作者把导出的 bundle 导入为草稿、修改后再次导出
- **THEN** 新 bundle 的 manifest 反映修改，且容器摘要随内容确定性变化

#### Scenario: 导入是编辑不是安装

- **WHEN** 一个 bundle 被导入为草稿
- **THEN** 已安装 pack 列表、技能库与 MCP 配置均无变化，仅草稿列表多一条

### Requirement: 对外面包可声明收敛的工具面

包清单 MAY 声明 `publicFacing: true`（对外团队）。该声明下，其岗位人格在运行时 SHALL 只挂载
公开面（智能体团队桥与市场公开面），SHALL NOT 挂载内部业务面（数据面/法律面/交易面等），
且 SHALL NOT 挂载本机项目目录的文件读取工具与名册枚举工具（枚举工具会把内部工具名带进回答）。
未声明该键的包 SHALL 保持现有工具面与运行时行为不变。

对外面的具体名单 SHALL 以配置为准，变更时 SHALL 有单测钉住名单与默认剔除项。
被禁工具 SHALL 同时从模型可见名册中移除（不留可见但不可调的残面）。

#### Scenario: 对外面包聚焦收敛

- **WHEN** 一个声明 `publicFacing: true` 的包被安装并物化，其岗位人格完成运行时聚焦
- **THEN** 聚焦名单只含公开面，不含内部业务面，也不含本机项目目录的文件读取工具

#### Scenario: 未声明的包零影响

- **WHEN** 一个未声明 `publicFacing` 的包被物化
- **THEN** 其聚焦名单与变更前一致，既有官方种子与在产团队的运行时行为无变化

#### Scenario: 名册移除不依赖是否存在 MCP 面

- **WHEN** 一个 `publicFacing` 人格聚焦后恰好没有任何 MCP 服务面（允许名单为空）
- **THEN** 被禁内建工具仍从其可见名册移除（可见性拦截独立于允许名单段，仅 guard 拦截不足以称为收敛）

### Requirement: 草稿编辑器提供多语言翻译面

草稿编辑器 SHALL 提供一个翻译工作台：左侧呈现 zh 主轨的显示字段，右侧呈现目标语言的对应覆盖输入，逐字段显示覆盖进度；缺项 SHALL 可一键定位到对应输入框。保存 SHALL 经由草稿条目的既有 i18n 通道写入，发布 SHALL 产出与手写 manifest 等价的 `i18n` 块。不含任何翻译的草稿发布后，其 manifest SHALL 与本次变更前编译出的 manifest 逐字节一致（即不新增空的 `i18n` 键）。

#### Scenario: 作者在编辑器内补齐 en 描述

- **WHEN** 作者在翻译工作台为 name 与 description 填入英文并保存、发布
- **THEN** 发布的 manifest 携带 `i18n.en.name` 与 `i18n.en.description`，英文读面呈现英文
- **AND** manifest 的其余部分与翻译前编译结果除新增 `i18n` 块外逐字节一致

#### Scenario: 覆盖进度精确到字段

- **WHEN** 一份草稿声明 4 条技能而 en 只覆盖 2 条描述
- **THEN** 工作台显示组织面覆盖计数，缺项清单列出那 2 条技能并可跳转到对应输入框

#### Scenario: 不写翻译的草稿不产生空叠加块

- **WHEN** 作者未填写任何翻译就发布草稿
- **THEN** 编译出的 manifest 不含 `i18n` 键，与变更前同草稿的编译结果逐字节一致

### Requirement: 领域与适用人群从受控词表选择

草稿编辑器的领域与适用人群入口 SHALL 是领域词表驱动的选择器（多选、1-3 项），SHALL NOT 提供自由文本 slug 输入。打开一个带有词表外领域取值的存量草稿时，编辑器 SHALL 显式标示该取值不合法并阻止发布，直到改为词表内取值；编辑器 SHALL NOT 静默丢弃或静默改写该取值。

#### Scenario: 选择器只列词表项

- **WHEN** 作者在编辑器中设置领域
- **THEN** 可选项恰为领域词表的项（含其当前界面语言的标签），无自由输入框

#### Scenario: 词表外存量取值被显式标示

- **WHEN** 作者打开一个领域含词表外取值的存量草稿
- **THEN** 该取值以不合法样式显示并给出可读说明，发布按钮在该取值被替换前不可用

#### Scenario: 取值零静默改写

- **WHEN** 作者保存一份含词表外领域取值的草稿（保存而非发布）
- **THEN** 该取值按原样保留在草稿中，不被改写或删除

### Requirement: 发布前的覆盖提示按作者身份分级

草稿发布前，编辑器 SHALL 按发布者身份给出不同强度的覆盖提示：名册官方作者且 en 覆盖不完整时，SHALL 呈现与服务端发布门一致的阻断提示并逐项列出缺失字段路径；非名册作者 SHALL 只看到非阻断的提示，发布动作照常可用。编辑器本地的提示 SHALL NOT 成为唯一的执行点——服务端发布门仍是真值。

#### Scenario: 官方作者被本地阻断提示拦截

- **WHEN** 一名名册作者尝试发布 en 覆盖不完整的草稿
- **THEN** 编辑器在发出请求前呈现阻断提示，逐项列出缺失字段路径，并给出跳转到翻译工作台的入口

#### Scenario: 社区作者只看到提示

- **WHEN** 一名非名册作者尝试发布同样未覆盖的草稿
- **THEN** 发布请求正常发出并按服务端规则成功，编辑器仅显示可关闭的提示

#### Scenario: 服务端仍是真值

- **WHEN** 编辑器本地判定已覆盖而服务端判定未覆盖（例如词表或分母差异）
- **THEN** 发布被服务端结构化错误拒绝，编辑器如实呈现该错误而非掩盖
