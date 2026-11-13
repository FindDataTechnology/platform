# Design — add-role-gated-extensions

## Context

Groups reach every request as `req.user.groups` (Logto org/role claims, or gateway-injected headers in a hosted cell) — no new identity plumbing is needed. Group-based market filtering already exists (`visibleToUser` in `extension-store.js`), and agent-catalog has the parallel `roles` filter in `catalog.js`. Both currently hide gated entries when no identity exists, which is the opposite of `requireAdmin`'s auth-off behavior (`server/auth.js` allows everything with auth off).

The deployment is deliberately single-machine (gateway + per-user child-process cells; pod-per-user was explored and rejected for this product's scale — tens of users). In a hosted cell, all extension state is already per-user (own SQLite, own `mcp.json`), so "different users see different extensions" is achieved by market filtering plus what each owner installs; role gating exists for operator-curated (registry-sourced) entries.

Two code-level facts shape the install-admission design:

- MCP market installs do not carry the market entry's identity: the client opens the setup form prefilled from the template and POSTs a plain server config to `/api/extensions/mcp`. The server can, however, look the submitted name up in the merged market catalog.
- Registry skill installs go through a dedicated endpoint (`/api/extensions/market/skills/:name/install`) that already knows the entry.

## Goals / Non-Goals

**Goals:**

- Close the role loop for extensions: visibility → install admission → runtime use, all keyed off `req.user.groups` with Logto as the only role source.
- Zero behavior change for the desktop app and auth-off deployments.
- Keep every check server-side; no new trust in the frontend.

**Non-Goals:**

- Any local role/permission store, admin UI for role→resource mapping, or user table.
- Registry-side metadata changes (the registry carries no group metadata; `registry-groups.json` stays the wiring point).
- Runtime role filtering for skills (skills gate at visibility/install only, per product decision).
- Pod-per-user / any deployment-shape change.
- Making bundled market entries groupable — they stay group-less by invariant.

## Decisions

### D1 — Auth-off = machine owner (semantics unification)

`visibleToUser` (`extension-store.js`) and `visible` (`catalog.js`) flip their `!user` branch from "hide gated entries" to "show everything". Rationale: consistency with `requireAdmin` (auth off ⇒ allow), and it removes the only realistic desktop regression path: if group metadata ever reaches a desktop deployment, the owner still sees everything. Alternative considered — keeping strict-hide and documenting "desktop never sees groups" — rejected: two opposite auth-off semantics in one codebase is a trap, and strict-hide protects nothing real (an auth-off deployment has no one to exclude; a cloud cell always has an identity).

### D2 — Cell-owner authorization predicate

Replace bare `requireAdmin` on the MCP mutation routes with `requireMcpManage`, which authorizes when: (a) auth is off, (b) the requester holds the `admin` group, or (c) `CLOUD_MODE=1` and `CELL_USER_EMAIL` equals the requester's email (the cell owner). Condition (c) is trusted because `x-forwarded-email` is only honored with the shared `CELL_GATEWAY_SECRET` in cloud mode (`server/auth.js`). Skills routes stay ungated. Alternative considered — dropping admin gating entirely in cell mode via config — rejected: an explicit owner predicate keeps shared deployments' semantics untouched and self-documents the trust boundary.

### D3 — Install admission derives from the catalog by name

At POST `/api/extensions/mcp`, the server resolves the merged market catalog entry by the submitted server name. If an entry exists and carries groups, the requester's groups must intersect it (403 otherwise), and the stored record is stamped with `requiredGroups = entry.groups`. No match or no groups ⇒ today's behavior, no stamp. This requires no frontend or API contract change — the client already sends the entry's name as the server name. Registry skill installs check the entry directly in their existing handler. Alternative considered — adding an `entryName` field to the POST body — rejected: it changes the API surface and invites spoofing (submitting an ungated entryName with a gated config).

Consequence (accepted): a user who renames a gated entry in the install form installs it un-gated, because the renamed name no longer matches the catalog entry. This is consistent with the threat model — market gating curates the *market path*, and in a cell the owner can always hand-enter an equivalent MCP config anyway; the operator-level hard boundary remains the registry token, which the user never holds.

### D4 — Runtime filter composes into the effective-profile merge

The role filter lives in effective-profile generation (`dsh-profile.js` `writeMcpPatch` merge, alongside the existing `user_mcp_bindings` overlay): a record with non-empty `requiredGroups` is dropped unless the profile's user's groups intersect it. Revocation therefore takes effect at the next patch application — cell boot (boot patch already folds the owner's bindings via `CELL_USER_EMAIL`) or hot-reload — with no record mutation; the config persists so re-granting the role restores the server. Skills are not filtered here (Non-Goal).

### D5 — Storage: nullable `required_groups` column on `extension_configs`

One migration (v13), nullable JSON array, default null; serialized in the record like `permissions` is today. Skills (`custom_skills`) get no column. Alternative considered — deriving required groups at runtime by re-resolving the market catalog — rejected: the catalog is a TTL cache over remote state; gating the runtime on it would make tool availability flap with registry outages.

## Risks / Trade-offs

- [A cell owner can hand-configure an MCP equivalent to a gated market entry] → Accepted by design (D3): the market path is curated, not secret; the registry token stays server-side. If a hard boundary is ever needed, per-user registry tokens are the future mechanism.
- [`requireMcpManage` widens mutation rights in cell mode] → Mitigation: the predicate only activates with `CLOUD_MODE=1` + `CELL_USER_EMAIL` + gateway-secret-verified identity; shared deployments see no change. Locked bundled entries remain immutable regardless of caller.
- [Group rename in Logto or `registry-groups.json` strands installed `requiredGroups`] → Mitigation: harmless failure mode — gated servers disappear until the mapping is fixed; documented operator runbook line in DEPLOY.md.
- [Hot-reload interplay: role-filtered server drops mid-session] → Mitigation: reuses the existing single-flight mutation serialization and dsh hot-swap path (already specced in mcp-integration), so no new race surface.

## Migration Plan

1. DB migration is additive (nullable column) — old code ignores it, new code reads null as "ungated". Rollback = revert code; column can stay.
2. All authorization changes are behind existing env shape — no deployment config changes; `registry-groups.json` remains optional and already documented.
3. Deploy order: single build contains server + (no-op) frontend. Desktop ships the same build with auth off — all new branches dormant by D1.

## Open Questions

- None blocking. (Whether to surface a "role required" hint badge on gated market cards is a UI nicety that can be decided during implementation without touching the specs.)
