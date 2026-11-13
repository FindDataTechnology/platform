# Design: add-persona-resource-sets

## Context

`deriveScope(agentPreset)` in `dsh-profile.js` resolves a preset id to an installed pack and returns pack-level `{ mcpKeep, skillsDir }`; both patch writers (`writeMcpPatch`, `writeSkillsPatch`) consume it inside every composition. Skill scoping works because `customSkillDirs` is a flat root list and pack skills already materialize under one root per pack (`skill-materialize.js`); dsh-skill-filesystem scans one level deep and follows symlinks (verified against its source: `stat`-typed symlink dirents are discovered; the nested `personas/` directory would be silently ignored by the flat scan). The manifest validator (`lib/pack-manifest.js`) is the single definition shared by the gateway's publish endpoint and the cell's install path. See proposal.md for motivation.

## Goals / Non-Goals

**Goals:**

- Persona-level derivation without new persisted state: the effective set stays `f(selected preset)` evaluated at every composition (boot, preset switch, MCP/skill CRUD, crash respawn).
- Zero-migration upgrade: installed packs without declarations compose exactly as today.
- One touch point: `deriveScope` and the two patch writers are the only runtime changes; the composition pipeline (ADR-0002 disposable roots) is built so the follow-up changes (overlay, custom presets) feed the same inputs.

**Non-Goals:**

- Subscriber-side overlay and custom presets (follow-up changes ② ③); cross-pack references inside manifests; miniprogram UI parity (web-first, MP keeps the existing pack-identity badge); hard persona length caps; dsh package modifications.

## Decisions

### D1 — Groundwork first: deriveScope becomes a two-stage derivation

Stage 1 (pure refactor, no behavior change, lands as its own commit): split `deriveScope` into `resolvePersona(presetId)` (catalog entry → pack + agent entry from the installed manifest) and `deriveScope(presetId)` (persona → effective set). Stage 2 introduces declaration semantics inside `deriveScope` only. Alternative — rewriting in place — rejected: the refactor step is what the follow-up changes build on and it must be provably inert (same patch bytes for today's packs).

### D2 — Manifest schema and declaration semantics

`agents[i].resources?: { skills?: string[], mcpServers?: string[] }`. Subset validation against the manifest's own `skills[].name` and `mcpServers[].registryName`; duplicates within one declaration rejected; unknown names rejected naming the role. Dimension independence: an absent dimension = whole-pack set for that dimension; a present-but-empty array = none. Alternative — one boolean `strict` flag or a single flat list — rejected: mixed skills-only/MCP-only declarations are the common case (e.g. a role that wants every server but only its own skills).

### D3 — Persona compose roots (the ADR-0002 mechanism)

Layout: `custom-skills/packs/<packId>/personas/<agentId>/<skillName>` → relative symlink to the sibling skill directory in the pack root. Built iff the persona declares a non-empty `resources.skills` (empty or absent → no root); rebuilt idempotently on every `writeSkillsPatch` call from the DB rows — never edited in place. Undeclared personas keep listing the pack root directly (today's path). Uninstall already removes the pack root wholesale (`skillMaterialize.removePackSkills`), which covers `personas/`. Alternatives — per-persona content copies (fallback only if symlinks prove unsupported on a real deployment; safe because roots are disposable) and dsh-side per-skill toggles (upstream, out of reach).

### D4 — MCP dimension is name-list arithmetic, no new machinery

`mcpKeep` becomes `packRefs ∩ declaredRefs` (undeclared → `packRefs`), applied at the existing focus layer in `writeMcpPatch` — after the personal overlay, so "personal disable wins" is inherited unchanged.

### D5 — Badge data path: catalog serializes the role summary

The catalog's pack source (which already turns `manifest.agents` into entries) serializes a per-entry `resourceSummary: { skillCount, mcpCount, declared: boolean }` computed from the installed manifest. The picker renders "「聚焦·<pack>」 N 技能 · M MCP"; undeclared entries show the pack-level counts. Alternative — a separate installed-packs fetch in the web client — rejected: the picker already reads one source, and the summary derives from the same snapshot the derivation uses.

### D6 — Editor: constrained chip pickers + cost readout

Per-role accordion in the pack editor with two chip lists sourced from the draft's own entries (never free-form). Cost readout: persona char count and an approximate token figure (~3 chars/token heuristic, labeled approximate), with a note that the persona bills every turn. No hard cap (see proposal: a tightened limit would strand old packs' upgrades behind re-validation).

### D7 — Probe: per-persona report

Extend `scripts/probe-pack-scope.mjs`: for each installed multi-agent pack, per persona, report effective server/tool counts and the traced token delta (same reference prompt, same model) versus full mode. Acceptance band unchanged (20–40 tools/persona on fd-prod).

### D8 — Seed-pack republish runbook

Edit the 4 gateway seed-pack manifests to add declarations demonstrating the semantics (at least one mixed-dimension declaration, one empty declaration), publish next versions, upgrade on fd-prod, run the extended probe, record numbers in the deploy notes. This doubles as the live exercise of the upgrade-re-derives scenario.

## Risks / Trade-offs

- [Symlink discovery differs under `ctx.fs` untrusted hosts] → The e2e suite materializes persona roots on a real dsh runtime; if the headless profile's `fs` service bypasses symlink following, fall back to copies (D3) — semantically identical because roots are rebuilt from the DB every composition.
- [Manifest size growth from declarations] → Bounded: declarations are name lists ⊆ existing entries; no new limits needed.
- [Old clients rendering new `resourceSummary` fields] → Additive serialization; the MP picker ignores unknown fields (its badge keeps showing pack identity).
- [A declaration names a skill skipped at install (foreign collision)] → The compose root only links directories that exist in the pack root; skipped skills never materialized, so the dangling name silently narrows further — consistent with the install-report-is-truth principle; the probe surfaces it as a count mismatch worth a warning log.

## Migration Plan

1. Land D1 refactor (inert), verify patch-byte equality on the dev cell.
2. Land D2–D5 runtime + validation + web UI; e2e green.
3. Republish seed packs (D8); upgrade fd-prod via the Jenkins `platform` job; probe and record.
4. Rollback: revert the deploy tag; installed manifests with declarations remain in the DB and are ignored by the previous derivation (declarations are additive data — the old code composes pack-wide, which is the declared-default semantics anyway). No data migration to undo.
