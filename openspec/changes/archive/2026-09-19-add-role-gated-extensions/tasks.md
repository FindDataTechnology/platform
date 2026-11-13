# Tasks — add-role-gated-extensions

## 1. Storage

- [x] 1.1 Add nullable `required_groups` column to `extension_configs` (migration v13 in `db.js`), serialize/deserialize it alongside `permissions` in the record mapping, and verify an existing DB upgrades losslessly (old rows read `requiredGroups: null`) via a startup test against a fixture DB
- [x] 1.2 Expose `requiredGroups` in `GET /api/extensions/mcp` responses and verify with a seeded gated record that the field round-trips

## 2. Auth-off semantics unification

- [x] 2.1 Flip `visibleToUser` in `extension-store.js`: `!user` returns true (owner sees all); update the function comment to state the owner semantics; verify with a unit test covering the three cases (member / non-member / no user, all against a grouped entry)
- [x] 2.2 Flip `visible` in `catalog.js` the same way and verify with a unit test: auth-off catalog response includes role-gated entries
- [x] 2.3 Add a regression test asserting the auth-off full path: `npm start` dev mode (auth off) with a `registry-groups.json` fixture marking an entry gated → `GET /api/extensions/market` includes it

## 3. Cell-owner authorization

- [x] 3.1 Add `requireMcpManage` in `server/auth.js` (auth off ⇒ allow; admin group ⇒ allow; `CLOUD_MODE=1` + `CELL_USER_EMAIL === req.user.email` ⇒ allow; else 403) and unit-test all four branches
- [x] 3.2 Replace `requireAdmin` with `requireMcpManage` on the MCP mutation routes in `server/routes/extensions.js` (POST/PUT/DELETE/PATCH, keep enable toggle separate) and verify: non-admin against a shared-mode server still gets 403; a cell-mode request with matching owner email is authorized
- [x] 3.3 Verify locked-server semantics are unchanged for the cell owner (400 on remove/disable/edit of a locked bundled server) with an API test

## 4. Install admission + stamping

- [x] 4.1 In POST `/api/extensions/mcp`, resolve the submitted name against the merged market catalog (`getMarketCatalog`); if the entry carries groups, reject with 403 unless the requester's groups intersect, and stamp `requiredGroups` on the created record; no match or no groups ⇒ unchanged behavior; verify with API tests for the four scenarios in the extension-marketplace delta (member install stamps, non-member 403 + no record, ungated unchanged, auth-off installs and stamps)
- [x] 4.2 Apply the same admission check to registry skill install (`/api/extensions/market/skills/:name/install`) and verify a non-member install returns an authorization error and creates no skill

## 5. Runtime role filter

- [x] 5.1 Extend effective-profile generation in `dsh-profile.js` (`writeMcpPatch` merge): drop records whose non-empty `requiredGroups` does not intersect the profile user's groups; no identity ⇒ no filtering; verify with unit tests (gated+member kept, gated+non-member dropped, gated+no-user kept, ungated kept) asserting the emitted patch contents
- [x] 5.2 Verify revocation flow end-to-end: with a stamped record and a user whose groups no longer intersect, re-apply the profile (cell boot path with `CELL_USER_EMAIL` or the hot-reload path) and observe the server omitted from the patch while the DB record is untouched

## 6. Docs & wrap-up

- [x] 6.1 Add an operator note to DEPLOY.md: how `registry-groups.json` gates market entries, that gated installs stamp `requiredGroups`, and that a Logto group rename strands gated servers until the mapping is updated
- [x] 6.2 Run the full test suite plus `openspec validate add-role-gated-extensions --strict` and confirm the desktop guardrail: no new behavior reachable with auth off beyond "gated entries now visible" (D1)
