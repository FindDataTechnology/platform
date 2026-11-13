# Tasks: add-focus-overlay

## 1. Storage + API (D1, D3)

- [x] 1.1 Add `focus.overlay.<presetId>` preference read/write helpers in `db.js` (value shape `{addMcp, removeMcp, addSkills, removeSkills}`, all-empty deletes the key); verify with a unit test round-tripping a diff and deleting on empty
- [x] 1.2 Add `GET /api/agent/overlay?preset=` (returns the stored diff plus addable universes: enabled/visible servers, available skills) and `PUT` (validates string arrays, dedupes, rejects a name in both add and remove for a dimension) in `server.js`; verify an unauthenticated request is rejected and a malformed PUT returns 400 naming the field
- [x] 1.3 Wire PUT onto the serialized runtime-mutation path (reject while a turn streams via the `set_preset` guard, wait-for-idle, rewrite both patches, broadcast picker refresh); verify a PUT during an active stream is rejected and one at idle rewrites `mcp.patch.yml` + `skills.patch.yml`

## 2. Composition — MCP layer (D2)

- [x] 2.1 In `writeMcpPatch`, capture the available-server map after availability/group/credential filtering and before the focus keep-set; after focus, apply overlay `add` (restore from the captured map by name) then `remove` (delete); verify with unit tests that a disabled, group-gated, and credential-less server each stay absent despite `add`
- [x] 2.2 Add the `+overlay[add:…,remove:…]` composition log line and a warn log naming dangling entries; verify the log appears in a dev-cell composition with a stored overlay
- [x] 2.3 Verify no-overlay parity: with no stored key, the written `mcp.patch.yml` is byte-identical to the pre-change writer output (diff in a unit test)

## 3. Composition — skills layer (D2)

- [x] 3.1 Extend `skill-materialize.js` root builder: effective list = (declared ∪ whole-pack) ± overlay, intersected with materialized directories; build the persona root whenever the preset has an overlay (including undeclared personas); verify root contents for declared-with-overlay, undeclared-with-overlay, and dangling-add cases
- [x] 3.2 `writeSkillsPatch` passes the preset's overlay into derivation; verify byte-identity with no overlay and a correct root listing with one, in unit tests mirroring 2.3

## 4. Web panel (D4)

- [x] 4.1 Role-detail 资源微调 section: effective set with per-item remove toggles, add chip-pickers from the GET universes, apply button calling PUT with the next-session note; verify a round-trip (add server, remove skill, apply, reopen) shows the adjusted set
- [x] 4.2 Panel state reflects deployment-global semantics (a second client's view refreshes after a PUT broadcast); verify in a two-page e2e

## 5. Probe, e2e, deploy (D5)

- [x] 5.1 Extend `scripts/probe-pack-scope.mjs` with a `--overlay` pass reporting per-persona derived vs derived±overlay surfaces; verify a local run prints both blocks for a role with a stored overlay
- [x] 5.2 New e2e `e2e/focus-overlay.spec.js`: adjustment applies next session, survives restart, upgrade with dangling entries converges silently, baseline removal is role-scoped, MP parity absent by design; verify the suite is green alongside the existing pack-agent-scoping suite
- [x] 5.3 Deploy after add-persona-resource-sets is live; verify the probe on fd-prod and record deployment-global semantics + MP fast-follow note in the deploy notes
