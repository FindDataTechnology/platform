// crm-desk-pack.js — the CRM 客服套件 pack's platform-side contract surface
// (add-crm-desk-pack-embed task 5.x). The pack content lives at
// packs/crm-desk-suite/ (manifest + merchant skill); this module exposes the
// pieces tests and tooling assert against, so the repo has ONE place that
// knows how the pack binds to the platform.
//
// Face model: the pack declares the chatwoot reference fullSurface (the 98
// name list would exceed the pack manifest's per-reference allowTools cap and
// duplicate a governance decision); the EFFECTIVE face is the operator-declared
// per-server face (lib/operator-tool-face.js), which caps every mode. Tests
// assert both halves: the manifest says fullSurface with a reason, and the
// operator face is exactly the standard 98.

import { readFileSync } from "node:fs";
import { repoRoot } from "../paths.js";

export const CRM_DESK_PACK_DIR = "packs/crm-desk-suite";
export const CRM_DESK_PACK_MANIFEST_PATH = `${CRM_DESK_PACK_DIR}/manifest.json`;

let cached = null;

export function crmDeskPackManifest() {
  if (!cached) {
    cached = JSON.parse(readFileSync(repoRoot(CRM_DESK_PACK_MANIFEST_PATH), "utf8"));
  }
  return cached;
}

// The chatwoot reference of the pack manifest, shape-checked.
export function crmDeskPackChatwootRef() {
  const ref = crmDeskPackManifest().mcpServers?.find((m) => m?.registryName === "chatwoot");
  if (!ref) throw new Error("crm-desk-suite manifest has no chatwoot reference");
  if (ref.fullSurface !== true || !ref.fullSurfaceReason?.trim()) {
    throw new Error("crm-desk-suite chatwoot reference must declare fullSurface with a reason (the operator face is the bound)");
  }
  return ref;
}
