# pack-agent-scoping Specification

## Purpose

Strengthens focused mode's tool narrowing from composition-time masking to registration-time dropping: an out-of-allowlist tool of an allowlisted server is intercepted before it ever enters the tool registry, so resync-registered tools cannot re-widen the model-facing roster mid-session and registry introspection cannot surface them. The existing guard and mask layers remain as fallbacks; degradation never falls below the previous semantics.

## Requirements

### Requirement: Resource scope is derived from the selected preset

The effective resource scope — which MCP servers, skills, and MCP tools the runtime loads — SHALL be derived from the selected agent preset together with the overlay recorded for that preset, over three preset families: a pack persona preset selects focused mode on its persona's resource set; a custom preset (openspec: custom-presets) selects focused mode on its declared resources intersected with what is locally available; and the shipped presets and the built-in local agent select full mode — every installed server and skill, with the tool dimension derived as the union of the installed packs' declared allowlists for each server those packs reference, and the full surface for every server no installed pack references or the user has marked full-surface (spec: full-mode tool scope). The runtime SHALL re-derive the scope at every start, on every preset switch, and on every MCP or skill configuration change, so the composed runtime always matches the derivation; the scope SHALL NOT persist as independent state that can drift — the overlay stores only per-role add/remove preferences, and the per-server full-surface marker is a separate global preference (`toolScope.fullSurface`); neither is ever a materialized resource set (spec: focus-overlay).

#### Scenario: Boot under a focused selection

- **WHEN** the runtime starts while a pack persona is the selected preset
- **THEN** the runtime composes focused (baseline plus that pack's resources) with no user action — a stale full-surface patch left behind by a crash cannot survive a restart

#### Scenario: Switching back restores the full surface

- **WHEN** the user switches from a pack role to a shipped mode or the built-in agent
- **THEN** the next session composes with every installed server and skill; each server referenced by an installed pack carries that pack set's declared tool union unless the user marked it full-surface, and every other server keeps its complete tool surface

#### Scenario: Configuration changes while focused keep the focus

- **WHEN** an MCP server or skill is added, removed, or toggled while a pack role is selected
- **THEN** the resulting runtime still composes focused, applying the change within the focused set

#### Scenario: Pack upgrade re-derives the set

- **WHEN** a focused pack is upgraded to a version that adds or drops MCP references or skills
- **THEN** the focused runtime reflects the new version's resource set on its next composition

#### Scenario: Existing installed packs need no re-subscription

- **WHEN** the deployment upgrades to this change with packs already installed
- **THEN** those packs' skills remain invocable in full mode and focusable in focused mode with no user action (materialization is rebuilt from the durable store)

#### Scenario: Overlay adjustment recomposes the scope

- **WHEN** a role's overlay is adjusted
- **THEN** the next composition of that role's runtime reflects the preset's derivation plus the adjusted preferences

#### Scenario: A custom preset focuses on its declared resources

- **WHEN** the selected preset is a custom preset referencing two skills and one server, one of which is not available in the cell
- **THEN** the runtime composes focused on the baseline plus the two available resources, and recomposes without user action when the unavailable reference becomes available again

### Requirement: Focused mode loads the baseline plus the pack's resource set

In focused mode the runtime SHALL load only the deployment baseline together with the selected persona's resource set — the subset of the pack's resources that the persona's declaration names, defaulting to the whole pack's set when the persona declares none — with the preset's overlay applied after the derivation: additions drawn from the enabled universe, removals of any member of the derived set (spec: focus-overlay). The baseline SHALL be: every server in the operator's mcp.json layer, every server named in `PACK_BASELINE_MCP` that is installed and visible, and the deployment's bundled skills; operators own the baseline and pack manifests cannot extend it (an overlay removal narrows the user's own runtime; it does not edit the baseline definition). A pack's resources SHALL be its pack-owned skills (the rows the install recorded as owned by that pack) and its MCP references that are installed in the cell; a manifest entry skipped at install (name collision with foreign content) is NOT part of any persona's set — the install report, not the manifest, is the record of what the pack owns here. A persona's declaration SHALL name only skills and MCP references within the pack's own lists, and each dimension (skills, MCP) SHALL scope independently: an absent dimension keeps the whole-pack set for that dimension, while a present-but-empty dimension yields none. The user's personal availability settings intersect with the scope: focusing can only remove servers from what the user has enabled, an overlay addition SHALL NOT re-enable a server the user disabled, and a persona whose effective set is empty focuses to the baseline alone.

#### Scenario: Focused tool surface is the pack's plus the baseline

- **WHEN** a subscriber selects a pack role whose pack owns two skills and references two registry servers
- **THEN** the focused runtime exposes exactly those four resources plus the baseline, and no other installed server or skill

#### Scenario: Declared subset narrows the focused surface

- **WHEN** a subscriber selects a pack role whose pack owns three skills and references three servers, and the role's declaration names two skills and one server
- **THEN** the focused runtime exposes exactly those two skills and that one server plus the baseline, and no other installed server or skill

#### Scenario: Undeclared persona keeps the whole pack set

- **WHEN** a subscriber selects a role from a pack whose agents carry no resource declarations
- **THEN** the focused runtime exposes the pack's every owned skill and installed MCP reference plus the baseline — exactly the pre-change behavior, with no re-subscription or migration

#### Scenario: Dimensions scope independently

- **WHEN** a persona declaration names skills but not MCP references
- **THEN** the focused skills are the declared subset while the focused MCP surface stays the pack's whole referenced set (intersected with installed and enabled), and symmetrically for the converse

#### Scenario: Present-but-empty declaration focuses to the baseline

- **WHEN** a persona declaration lists no skills and no MCP references
- **THEN** the focused runtime exposes exactly the baseline

#### Scenario: Persona-only pack focuses to the baseline

- **WHEN** a subscriber selects a role from a pack whose manifest has no skills and no MCP references
- **THEN** the focused runtime exposes exactly the baseline

#### Scenario: Collision-skipped skill stays out

- **WHEN** a pack's skill was skipped at install because a same-named user skill already existed
- **THEN** the focused view excludes that skill name for every persona of the pack, and the user's own skill is visible only in full mode

#### Scenario: Personal disable wins over the manifest

- **WHEN** the user has disabled a server that the focused persona's declaration names
- **THEN** the focused runtime omits that server

#### Scenario: Unresolvable baseline entry is skipped

- **WHEN** `PACK_BASELINE_MCP` names a server that is not installed in the cell
- **THEN** the runtime starts without it and logs a warning instead of failing

#### Scenario: Upgrade with changed declarations re-derives

- **WHEN** a focused pack is upgraded to a version whose persona declaration adds or drops skills or MCP references
- **THEN** the focused runtime reflects the new declaration on its next composition

#### Scenario: Overlay addition extends the focused surface

- **WHEN** a role's overlay adds an enabled server and an available skill
- **THEN** the focused runtime exposes the derived set plus those two additions and the baseline

#### Scenario: Overlay removal may drop a baseline member

- **WHEN** a role's overlay removes a baseline server
- **THEN** that role's focused runtime omits it while every other role and full mode still load it

### Requirement: Focused mode narrows tools within a kept server

When a focused role's effective resource set includes an MCP reference that carries a tool allowlist — the pack-level allowlist narrowed by the role's own `mcpTools` declaration when present — the role's session SHALL expose only the allowlisted tools of that server: tools outside the allowlist SHALL NOT appear in the role's visible tool roster, and a call to such a tool SHALL be denied with a readable reason naming the tool and the role's focused scope, never a silent failure. Baseline servers and references without allowlists SHALL keep their full tool surface exactly as before this change. Interception SHALL be hard — no runtime condition (server drift, tool-set change, restart) may leave an out-of-allowlist tool callable by the role.

Narrowing SHALL operate primarily at registration time: when the runtime's tool registry admits a tool whose name carries an MCP server that has an allowlist in the role's materialized filter and whose leaf is outside it, the registration SHALL be dropped before the tool enters the registry, and this SHALL hold for every registration generation (initial mount and every resync) for the lifetime of the composed runtime. Registration-time dropping is implemented over a runtime-internal seam (an instance-level wrapper on the registry's registration entry point) and SHALL degrade gracefully: when the seam is unavailable, shape-unexpected, or raises, the wrapper SHALL pass the registration through to the original method unchanged, falling back to the previous two-layer semantics — composition-time roster masking plus call-time guard denial — under which a drifted tool set may briefly widen what the roster lists while every out-of-allowlist call is still denied. The effective tool set SHALL be re-derived at every composition from the installed version snapshot, following the same derivation rules as the server and skill dimensions, and the registration-time filter SHALL re-read the materialized allowlist per registration so a hot-reloaded filter governs subsequent generations without a restart.

#### Scenario: Allowlisted tools only in the roster

- **WHEN** a subscriber selects a role whose pack reference to a server declares a three-tool allowlist
- **THEN** the role's session roster lists exactly those three tools of that server and none of its other tools

#### Scenario: Undeclared tool call is denied with a readable reason

- **WHEN** the role's model attempts to call a tool of that server outside the allowlist
- **THEN** the call is denied with a reason naming the tool and stating it is outside the role's focused scope, and the conversation continues

#### Scenario: Role-level narrowing applies below the pack level

- **WHEN** a pack reference declares a five-tool allowlist and the selected role's declaration narrows it to two
- **THEN** the role's roster lists exactly those two tools of that server

#### Scenario: No allowlist keeps the full surface

- **WHEN** a focused role's effective set includes a reference without any allowlist, and a baseline server
- **THEN** both expose their full tool surfaces exactly as before this change

#### Scenario: Server drift never widens callability

- **WHEN** the server adds tools after the pack version was published, or removes an allowlisted tool
- **THEN** the new tools remain uncallable by the role, and a call to the removed allowlisted tool fails with a readable error instead of a silent or hung call

#### Scenario: Resync registration stays dropped

- **WHEN** an allowlisted server re-registers its tool generation mid-session (config HMR or reconnect) after the role composed
- **THEN** the out-of-allowlist tools of that generation do not re-enter the registry, so the model-facing roster does not widen

#### Scenario: Full mode is unaffected

- **WHEN** the user switches from the role to a shipped mode or the built-in agent
- **THEN** every installed server exposes its full tool surface exactly as before this change

### Requirement: Focus is visible to the user

The agent picker SHALL mark pack personas as focused roles, showing the pack identity (cross-referencing the `packId` the catalog serves for pack-sourced entries) together with the role's resource summary — the skill and MCP server counts of that persona's effective set, whether declared or defaulted. The persona text generated for a pack role SHALL state that the role's tools and skills focus on its own resource set, so a request for capability outside the set gets an honest "not enabled for this role" answer that suggests switching modes, never invented results. Focus switching follows the existing preset-switch contract: rejected while a turn streams, applied to the next session, broadcast to all clients.

#### Scenario: Picker badges focused roles

- **WHEN** the catalog serves pack-sourced entries
- **THEN** the agent picker renders each with a focus mark naming its pack and that role's skill and server counts

#### Scenario: Role explains instead of hallucinating

- **WHEN** the user asks a focused role to use a tool outside its resource set
- **THEN** the role answers that the capability is not enabled for this role and points to switching back to a full mode

#### Scenario: Switch rejected mid-stream

- **WHEN** a mode switch is requested while a turn is streaming
- **THEN** the switch is rejected with an error, matching the existing `set_model` / `set_preset` guard

### Requirement: Focus is a property of the shared runtime

Focused/full mode and each role's overlay SHALL be deployment-global state of the shared runtime, consistent with the existing deployment-global preset preference and the v1 shared-session ceiling: every connected client (web, mini-program) sees the same mode and the same adjustments, and a switch or adjustment by any client follows the serialized runtime-mutation path. Per-client scoping is out of scope for v1 and is documented rather than silently discovered.

#### Scenario: Second client sees the same mode

- **WHEN** a pack role is selected and another client connects
- **THEN** that client's runtime view and picker reflect the same focused mode as every other client

#### Scenario: Second client sees the same adjustments

- **WHEN** one client adjusts a role's overlay and another client inspects the same role
- **THEN** the other client's adjustment view shows the same effective set and preferences

### Requirement: Scope savings are measured

The change SHALL ship a measurement probe that reports, for full mode and for each persona of the installed packs on a real deployment: the effective MCP server count with per-server tool counts, and a turn-tracing comparison of recorded token usage for the same prompt on the same model in full mode versus that persona's focused mode. Each persona's tool roster on fd-prod is expected to land materially below the full roster (target band roughly 20–40 tools).

#### Scenario: Probe reports both modes

- **WHEN** the probe runs against a deployment with an installed pack
- **THEN** it reports the full versus focused server and tool counts, and the traced token delta for the reference prompt

#### Scenario: Probe reports per persona

- **WHEN** the probe runs against a deployment with an installed multi-agent pack
- **THEN** it reports the full roster once and, per persona, the focused server and tool counts and the traced token delta for the reference prompt

### Requirement: Full mode narrows pack-referenced servers to their declared union

In full mode, for each MCP server referenced by one or more installed packs, the runtime SHALL expose the union of those packs' effective tool allowlists for that server, intersected with any operator-declared tool face for that server (the operator face is an upper bound — see "操作员声明的 per-server 工具面上界"). A server referenced by no installed pack and carrying no operator face SHALL keep its complete tool surface, exactly as before this change; a server carrying an operator face but referenced by no pack SHALL expose exactly the operator face. A server referenced by any pack that declares `fullSurface` — or by any pack reference that carries no tool declaration at all — SHALL keep its complete tool surface up to the operator face (an absent declaration contributes the full surface to the union, never an empty set; the operator face then caps it).

The union SHALL be recomputed at every composition from the installed pack manifests and the operator declarations — never persisted as a materialized allowlist — so installing, upgrading, or uninstalling a pack re-derives the full-mode surface without further action. When no pack is installed and no operator face applies, full mode SHALL compose with no filter at all, byte-identical to the pre-change behavior.

#### Scenario: Union of two packs narrows a shared server

- **WHEN** two installed packs both reference `fd-quant`, declaring 6 and 9 tools respectively
- **THEN** full mode exposes exactly the union of those tool sets for `fd-quant`, and nothing outside it

#### Scenario: Unreferenced servers keep their full surface

- **WHEN** the user installed an MCP server directly, no installed pack references it, and it carries no operator face
- **THEN** full mode exposes that server's complete tool surface

#### Scenario: An undeclared reference contributes the full surface

- **WHEN** an installed pack references `fd-quant` with no tool declaration while another declares 6 tools
- **THEN** full mode exposes all 50 tools of `fd-quant`, not the 6-tool union — an absent declaration never narrows

#### Scenario: Uninstalling the last referencing pack lifts the filter

- **WHEN** the last installed pack referencing `fd-quant` is uninstalled and `fd-quant` carries no operator face
- **THEN** the next composition exposes `fd-quant`'s complete tool surface

#### Scenario: Uninstalling the last referencing pack leaves the operator face

- **WHEN** the last installed pack referencing a server is uninstalled and the server carries an operator face
- **THEN** the next composition exposes exactly the operator face for that server

#### Scenario: No packs installed composes unfiltered

- **WHEN** the cell has no installed packs and no operator face applies to any installed server
- **THEN** full mode writes no tool filter and the composed runtime matches the pre-change behavior
### Requirement: Per-server full-surface override

The user SHALL be able to mark any MCP server as full-surface from the MCP settings surface. A marked server SHALL expose its complete tool surface in every mode up to any operator-declared tool face for that server, outranking both the full-mode union and any pack-level allowlist for that server — but MUST NOT widen beyond the operator face, which is a platform governance bound. The marker SHALL persist across restarts and recompositions, and SHALL be reversible.

A tool call denied by a pack allowlist SHALL name the server, the tool, and this setting as the escape hatch (the bridge's denial copy points at Settings → MCP); a call denied by the operator face SHALL name the platform tool face as the bound instead. The bridge's guard/restrict execution logic otherwise stays unchanged.

#### Scenario: Override restores the complete surface

- **WHEN** the user marks `fd-daas-mcp` full-surface while an installed pack declares 5 of its 161 tools and no operator face applies
- **THEN** the next composition exposes all 161 tools of `fd-daas-mcp`, in full mode and in focused modes alike

#### Scenario: Override cannot cross an operator face

- **WHEN** the user marks a server full-surface whose operator face excludes specific tools
- **THEN** the composition exposes the operator face — the excluded tools stay out of the roster and uncallable

#### Scenario: Override survives a pack upgrade

- **WHEN** a pack referencing the overridden server is upgraded and the runtime recomposes
- **THEN** the server remains full-surface (bounded only by any operator face)

#### Scenario: Removing the override re-applies the derived scope

- **WHEN** the user removes the full-surface marker from a server
- **THEN** the next composition re-applies the derived scope (pack union intersected with any operator face), in every mode

### Requirement: 操作员声明的 per-server 工具面上界

平台 SHALL 支持操作员在配置仓中为指定 MCP server 声明工具面上界（leaf 名单，git 声明、随镜像分发、逐版本评审）。操作员面 SHALL 在所有模式下作为该 server 可见与可调用工具的上界生效：full mode 的有效面为 pack 声明并集与操作员面之交（无 pack 引用但有操作员面的 server，其面即操作员面）；focused 模式的有效面为角色有效 allowlist 与操作员面之交；基线 server（无 pack/角色声明）带操作员面时其面即操作员面。面外工具 MUST NOT 出现在工具 roster、MUST NOT 可调用（经既有工具面拦截层硬执行），拦截 MUST 给出可读原因并点名操作员面。操作员面上界 SHALL 压过 per-server full-surface 用户覆盖（用户覆盖只能恢复到操作员面，不能越过平台治理边界）。操作员面名单 MUST 可离线测试（名单为受版本控制的常量）。

#### Scenario: 无 pack 引用的基线 server 被操作员面裁剪

- **WHEN** 操作员为基线 server `chatwoot` 声明 98-leaf 面而未装任何引用它的 pack，full mode 组合
- **THEN** 该 server 的 roster 恰为操作员面的 98 个工具，其 fork 专属与发送类工具不出现、调用被拒并点名原因

#### Scenario: 操作员面与 pack 并集求交

- **WHEN** 某已装 pack 对带操作员面的 server 声明 allowlist，其中含操作员面之外的 leaf
- **THEN** 有效面为两者之交，pack 声明不能越过操作员上界

#### Scenario: 用户 full-surface 覆盖不越过操作员面

- **WHEN** 用户把带操作员面的 server 标记为 full-surface
- **THEN** 该 server 恢复到操作员面（而非完整 server 面），操作员面之外的调用仍被拒

#### Scenario: 面外调用被拒且原因可读

- **WHEN** agent 调用某 server 操作员面之外的 MCP 工具
- **THEN** 调用被拦下，错误信息点名该工具不在该 server 的平台工具面内，会话不受影响
