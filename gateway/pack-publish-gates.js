// Publish gates as data (creator-pack-forge-support D1) — extracted from
// gateway/packs.js under optimize-paas-module-audit N-9.
//
// The publish route's gate sequence (manifest presence, structural limits, the
// files gate, the tool-declaration gate, sellability, official-EN coverage) is
// collected as ordered verdict items instead of early returns. Publish answers
// the FIRST failing item (its status and body are byte-identical to the
// pre-extraction route); the validate dry-run reports EVERY item so a creator
// sees all problems in one pass. One collector, so the two faces cannot drift.
//
// This unit lifts out cleanly because it depends on nothing but pure helpers and
// the registry's server index: no closures from registerPackRoutes, no store.
// `projectManifestForDetail` deliberately stayed in packs.js — it is a read
// projection, not a gate, and it shares nothing with this file.

import { validatePackManifest as validateManifest } from "../lib/pack-manifest.js";
import {
  declaredToolsByServer,
  toolGateErrors,
  probeMcpToolNames,
  toolFaceErrors,
  toolClosureErrors,
} from "../lib/publish-tool-gate.js";
import { officialEnGateBody, officialEnGateEnabled } from "../lib/pack-locale-coverage.js";
import { resolveBundleSafe } from "../bundle-manifest.js";
import { parseFleetTemplate } from "../server/fleet-template.js";
import { registryServerIndex } from "../registry-bridge.js";
import { sellabilityGate } from "./pack-sellability-gate.js";

// True when the manifest declares any tool leaf names (pack-level allowTools
// or per-role mcpTools) — the publish tool gate's consultation predicate.
const declaresTools = (manifest) => declaredToolsByServer(manifest).size > 0;

// Explicit tool-face gate mode (pack-tool-declaration-gate): off skips the
// gate, warn (the default, and the authoring repo's backfill window) logs the
// violation surface and lets the publish through, enforce rejects. Read per
// request so rollout and rollback never need a restart.
const TOOL_FACE_GATE_MODES = new Set(["off", "warn", "enforce"]);
const toolFaceGateMode = () => {
  const raw = String(process.env.PACK_TOOL_FACE_GATE || "").trim().toLowerCase();
  return TOOL_FACE_GATE_MODES.has(raw) ? raw : "warn";
};

// True when any skill entry carries an auxiliary file set (add-packaged-skills)
// — the operator gate's consultation predicate (see the publish route).
// Shape-tolerant: validate's collect mode reaches it with a manifest whose
// structural errors were already reported (skills present but not an array).
const declaresFiles = (manifest) =>
  (Array.isArray(manifest?.skills) ? manifest.skills : []).some(
    (s) => s?.files && typeof s.files === "object" && !Array.isArray(s.files) && Object.keys(s.files).length > 0,
  );

// The gate's data plumbing: the registry server index (one cached fetch) as
// serverInfo, the minimal streamable-http probe as the staleness fallback, and
// the shipped bundle's own server list as the builtin-capability answer
// (declare-builtin-capability-surface D1/D2). A reference that is neither a
// market entry nor a bundled capability can never bind at install time, so the
// publish face must be able to say so instead of waving it through.
const BUILTIN_REF_MODES = new Set(["off", "warn", "enforce"]);
const builtinRefMode = () => {
  const raw = String(process.env.PACK_BUILTIN_REF_GATE || "").trim().toLowerCase();
  return BUILTIN_REF_MODES.has(raw) ? raw : "warn";
};

let builtinServerNames = null;
function builtinServers() {
  if (builtinServerNames) return builtinServerNames;
  const bundle = resolveBundleSafe({ log: () => {} });
  builtinServerNames = new Set(Object.keys(bundle?.mcpServers ?? {}));
  return builtinServerNames;
}

async function runPublishToolGate(manifest) {
  const index = await registryServerIndex();
  const builtin = builtinServers();
  return toolGateErrors(manifest, (name) => index.get(name) ?? null, {
    probe: (endpoint) => probeMcpToolNames(endpoint),
    logger: console,
    isBuiltinServer: (name) => builtin.has(name),
    builtinRefMode: builtinRefMode(),
  });
}

//
// The publish route's gate sequence — manifest presence, structural limits,
// the files gate, the tool-declaration gate — collected as ordered verdict
// items instead of early returns. Publish answers the FIRST item (its status
// and body are byte-identical to the pre-extraction route); the validate
// dry-run reports EVERY item so a creator sees all problems in one pass. One
// collector, so the two faces can never drift apart.
//
// Item shape: { stage, status, body } — `body` is exactly the JSON a publish
// rejection would carry at that gate (wording, `code`, `toolGate` markers).
// shortCircuit=true (publish) stops at the first failing gate, preserving the
// documented "invalid attempts cost only a pure-function validation" property
// — no registry round-trip on a rejection a cheaper gate already explained.
// shortCircuit=false (validate) collects every gate's verdict in one pass.
// Exported: the N-9 extraction moved this out of gateway/packs.js, which still
// answers it on the publish gate and as the validate route's caller finding.
// Exported: the validate route reports publish eligibility with this same
// reason string, and it stayed in packs.js — one vocabulary, one definition.
export const CREATOR_GROUP_REQUIRED = "Creator group required";

export async function collectPublishVerdict(manifest, { shortCircuit = false, pricing = null, officialAuthor = false, env = process.env } = {}) {
  const items = [];
  const push = (stage, status, body) => items.push({ stage, status, body });
  if (!manifest) {
    push("request", 400, { error: "manifest required" });
    return items;
  }
  const structural = validateManifest(manifest);
  if (structural.length > 0) {
    push("structural", 400, { error: "Invalid manifest", errors: structural });
    if (shortCircuit) return items;
  }
  // Official en-coverage publish gate (overhaul-market-catalog-presentation
  // 4.6): a roster-official author's publish is held to full en coverage of
  // the ORG SURFACE (every declared display field carries its i18n.en
  // counterpart — design D11, specs/official-locale-coverage). Community
  // authors are never constrained; the door itself opens by deployment flag
  // (PACK_OFFICIAL_EN_GATE=1) AFTER P4 fills the catalog's coverage, so
  // in-flight publishes are not cut off mid-flight. The body itemizes the
  // missing field paths — the workbench (4.7) jumps to each gap.
  if (officialAuthor && officialEnGateEnabled(env)) {
    const gate = officialEnGateBody(manifest);
    if (gate) {
      push("officialEnCoverage", 422, gate);
      if (shortCircuit) return items;
    }
  }
  // Attribution discipline (pack-marketplace delta): vendor署名 is stamped
  // server-side from the verified binding, NEVER written into the manifest —
  // a manifest's vendor key is an author-controlled identity claim and fails
  // the gate outright (same for legacy packs: they simply never carry one).
  if (manifest && Object.hasOwn(manifest, "vendor")) {
    push("attribution", 400, {
      error: "Manifests may not carry a vendor attribution claim — attribute at publish time with the verified vendor slug",
      code: "manifest-attribution-forbidden",
    });
    if (shortCircuit) return items;
  }
  // Explicit tool-face gate (pack-tool-declaration-gate D1/D2): every reference
  // must carry an allowlist or a reasoned full-surface marker, and every tool
  // its skills name must sit inside that declaration. Pure functions — no
  // registry round-trip, so it runs before the name gate. The shared shape
  // validator deliberately still accepts "neither" (install compatibility);
  // this gate is where a PUBLISHED version must have decided. Read per request:
  // off skips, warn (default) logs the violation surface and lets the publish
  // through, enforce rejects. The authoring repo's backfill runs in the warn
  // window; enforce flips after it.
  const faceMode = toolFaceGateMode();
  if (faceMode !== "off") {
    const violations = [...toolFaceErrors(manifest), ...toolClosureErrors(manifest)];
    if (violations.length > 0) {
      if (faceMode === "enforce") {
        push("toolFace", 400, { error: "Invalid manifest", errors: violations, toolFace: true });
        if (shortCircuit) return items;
      } else {
        console.warn(
          `[publish-tool-face-gate] warn-only pack='${manifest?.name ?? "unnamed"}' ` +
            `violations=${violations.length}: ${violations.map((v) => v.error).join(" | ")}`,
        );
      }
    }
  }
  // Fleet-template gate (agent-fleet-templates D2): a manifest that carries a
  // fleet section must pass the shared template parser — cycles, bad crons,
  // missing fields AND the orchestration section (validated by the same pure
  // validator the live write face uses, over the template member set —
  // mixed-fleet D3) stop at the mint, never reaching the market. A manifest
  // WITHOUT the section skips this gate entirely: plain packs are untouched.
  if (manifest && manifest.fleet !== undefined && manifest.fleet !== null) {
    const fleet = parseFleetTemplate(manifest);
    if (!fleet.ok) {
      push("fleetTemplate", 400, { error: "Invalid fleet template", errors: fleet.errors ?? [fleet.error] });
      if (shortCircuit) return items;
    }
  }
  // Operator gate (add-packaged-skills D9): files-bearing publishes stay
  // refused until PACK_FILES_ENABLED is switched on. Cells running
  // pre-package validators accept unknown manifest keys silently — without
  // the gate, such a cell would install a degraded, files-dropped skill.
  // Read per-request so operations can flip the switch without a restart.
  if (declaresFiles(manifest) && process.env.PACK_FILES_ENABLED !== "1") {
    push("files", 400, {
      error: "Skill packages are not enabled on this market yet (PACK_FILES_ENABLED); publish without auxiliary files or ask the operator to enable them",
      code: "pack-files-disabled",
    });
    if (shortCircuit) return items;
  }
  // Tool-declaration gate (add-mcp-tool-scoping D5): registry tool_list
  // cross-check with one live-probe fallback per server, plus commercial
  // closure for surface-registered entries. Consulted ONLY when the
  // manifest declares tool names — a pack without declarations publishes
  // exactly as before (no registry round-trip at all).
  // (Both predicates tolerate malformed shapes — validate's collect mode
  // reaches them with a manifest the structural gate already rejected.)
  if (declaresTools(manifest)) {
    let gate;
    try {
      gate = await runPublishToolGate(manifest);
    } catch (err) {
      // The registry index itself is unreachable: for a DECLARING manifest
      // that is a fail-closed verdict (the names cannot be verified), never
      // a silent pass — with the registry back, the publish retried.
      push("tools", 503, { error: `Tool declarations could not be verified against the registry (${err?.message || err}); retry shortly` });
      return items;
    }
    if (gate.errors.length > 0) push("tools", 400, { error: "Invalid manifest", errors: gate.errors, toolGate: true });
  }
  // Sellability gate (add-blueprint-studio 4.2): a PRICED cluster template must
  // carry its casting provenance and a GREEN trial report — assertion-green is
  // the only source of sellability. Free publishes pass (internal distribution
  // is free today, 2026-10-28 decision) but the gap is reported as a note, so
  // the day distribution turns paid the gate bites without a second rewrite.
  const sellability = sellabilityGate(manifest, { pricing });
  if (sellability.errors.length > 0) {
    push("sellability", 400, { error: sellability.errors[0].error, code: sellability.errors[0].code, errors: sellability.errors });
  }
  for (const note of sellability.notes) {
    console.warn(`[publish-sellability-gate] ${note}`);
  }
  return items;
}
