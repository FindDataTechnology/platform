## ADDED Requirements

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

## MODIFIED Requirements

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
