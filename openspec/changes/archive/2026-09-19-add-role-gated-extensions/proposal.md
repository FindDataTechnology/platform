# add-role-gated-extensions

## Why

The hosted deployment needs different users to see different MCP servers and skills, and certain MCP servers to be usable only by users holding a specific Logto role. Half of this exists today — the market already filters registry entries by group, and groups flow from Logto on every request — but the loop is not closed: market visibility hides entries from auth-off (desktop/single-user) deployments inconsistently with admin gating, a normal user in their own hosted cell cannot manage MCP at all (all mutation APIs are admin-gated, while skills are ungated), and a role revoked in Logto has no effect on MCP configs already installed in a user's cell.

## What Changes

- **Unify auth-off visibility semantics**: when no authenticated identity exists (auth off — desktop app, dev mode), the requester is the machine owner and SHALL see all market and agent-catalog entries, matching `requireAdmin`'s existing auth-off behavior. Today gated entries are hidden from auth-off requesters, an inconsistency that becomes a desktop regression risk once group metadata is actually used.
- **Cell-owner MCP self-service**: in a hosted per-user cell (`CLOUD_MODE` with `CELL_USER_EMAIL`), the cell owner SHALL be able to add/edit/remove/enable/disable MCP servers in their own cell without holding the admin group. Shared single-process deployments keep the admin gate unchanged; skills management stays open as today.
- **Role-stamped installs with admission check**: installing a market MCP entry that carries groups SHALL stamp `requiredGroups` onto the installed record and SHALL be rejected server-side unless the requester's groups intersect the entry's groups (defense in depth beneath the market filter). Registry skill installs get the same admission check.
- **Runtime role filter**: effective-profile generation for MCP SHALL omit installed servers whose `requiredGroups` do not intersect the current user's groups, so a role revoked in Logto takes effect on the next profile application without requiring uninstall. Locked bundled servers and servers without `requiredGroups` are unaffected.
- **Invariants kept**: bundled market catalog entries never carry groups; groups for registry entries continue to come from `registry-groups.json` (or registry metadata when it exists); desktop behavior is unchanged in every scenario because all new checks are no-ops without an authenticated identity.

No new role/permission storage is introduced — Logto remains the sole source of roles, consumed as groups via the existing identity pipeline.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `extension-marketplace`: auth-off requesters see gated entries (owner semantics) instead of only group-less ones; market install endpoints enforce group admission for entries carrying groups (MCP and registry skills).
- `extension-runtime-management`: MCP mutation authorization becomes deployment-shaped — admin group in shared deployments, cell owner in per-user cells; extension records gain a `requiredGroups` field stamped at market-install time.
- `mcp-integration`: the effective MCP profile filters installed servers by `requiredGroups` against the current user's groups, extending the existing personal-overlay semantics with role-based removal.
- `agent-catalog`: role-based visibility aligned to the same owner semantics — auth off means all entries visible.

## Impact

- **Server**: `extension-store.js` (`visibleToUser`), `catalog.js` (`visible`), `server/routes/extensions.js` (admission checks, owner-authorized mutations), `server/auth.js` (cell-owner predicate), `db.js` (migration: `requiredGroups` on `extension_configs`), `dsh-profile.js` (profile generation filter).
- **Frontend**: no required changes — gated entries are already invisible in the market; installed-list rows render unchanged (role filtering happens server-side at profile generation).
- **Desktop**: unaffected — every new check is gated on an authenticated identity existing; static analysis guardrail (no role logic on the auth-off path).
- **Deployment**: none; `registry-groups.json` wiring is already supported and documented.
