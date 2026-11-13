# pack-agent-scoping delta

## Purpose

Strengthens focused mode's tool narrowing from composition-time masking to registration-time dropping: an out-of-allowlist tool of an allowlisted server is intercepted before it ever enters the tool registry, so resync-registered tools cannot re-widen the model-facing roster mid-session and registry introspection cannot surface them. The existing guard and mask layers remain as fallbacks; degradation never falls below the previous semantics.

## MODIFIED Requirements

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
