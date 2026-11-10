// Pageset authorization: the read contract and the visibility decisions
// (openspec: add-erp-miniapp-pagesets — "按租户授权组合装载且未授权不可见").
//
// The server is authoritative for every page (api-contract 通用约定); this
// module is the EXPERIENCE layer only. Its one hard rule is fail-closed:
// while authorization is unknown, errored or malformed, NOTHING pageset-
// related is visible and every pageset route is blocked. Invisible ≠ grayed
// out — an unauthorized pageset renders no entry at all.

// Relative imports carry the explicit .ts extension: every module in this
// directory is a deliberate node --test target (pure logic, no Taro/React),
// and Node's ESM resolver needs the extension. Webpack resolves the exact
// path unchanged.

import { PAGESETS, pagesetByPagePath } from "./registry.ts";
import type { PagesetDef, PagesetKey } from "./types.ts";

// REST read (through the base runtime's configured http transport — the same
// taro-http pipeline every other REST call uses, never a bypass):
//   GET /erp/supply-chain/v1/pagesets
//   -> { "pagesets": [{ "key": "supply-chain.ue", "grants": ["catalog.read", ...] }, ...] }
// `grants` is the tenant's granted permission codes within that pageset.
// NOTE: the endpoint is implemented ERP-side (its own change); until it
// ships this read fails -> fail-closed (no pageset visible), which is the
// correct posture for an unauthorized tenant.
export const PAGESET_AUTH_PATH = "/erp/supply-chain/v1/pagesets";

export type PagesetAuthStatus = "unknown" | "loading" | "ready" | "error";

// key -> granted grants. Only keys the server listed are present.
export type PagesetGrants = Partial<Record<PagesetKey, readonly string[]>>;

/**
 * Strict parse of the authorization payload. Anything malformed (wrong
 * shape, unknown key, non-string grants) yields an EMPTY record — fail-closed,
 * never a partial trust.
 */
export function parsePagesetAuth(payload: unknown): PagesetGrants {
  if (payload === null || typeof payload !== "object") return {};
  const pagesets = (payload as { pagesets?: unknown }).pagesets;
  if (!Array.isArray(pagesets)) return {};
  const known: PagesetGrants = {};
  const KNOWN_KEYS: readonly PagesetKey[] = [
    "supply-chain.ue",
    "supply-chain.se",
    "supply-chain.sp",
    "supply-chain.cp",
  ];
  for (const raw of pagesets) {
    if (raw === null || typeof raw !== "object") return {};
    const { key, grants } = raw as { key?: unknown; grants?: unknown };
    if (typeof key !== "string" || !(KNOWN_KEYS as readonly string[]).includes(key)) return {};
    if (!Array.isArray(grants) || grants.some((g) => typeof g !== "string")) return {};
    known[key as PagesetKey] = grants as string[];
  }
  return known;
}

function hasAllGranted(granted: readonly string[] | undefined, required: readonly string[]): boolean {
  if (required.length === 0) return true;
  if (!granted) return false;
  const set = new Set(granted);
  return required.every((g) => set.has(g));
}

/**
 * Whether a pageset's ENTRY may render: the key is authorized, period.
 * Design D2: entries appear on pagesetKey authorization; grants are
 * enforced by the server per page, and page-level requiredGrants (below)
 * only refine which pages inside an authorized pageset are reachable.
 * The pageset's manifest-level grant catalog (registry `requiredGrants`)
 * documents the permission surface — it is NOT an all-or-nothing gate.
 */
export function isPagesetVisible(def: PagesetDef, grants: PagesetGrants): boolean {
  return grants[def.key] !== undefined;
}

/**
 * Whether ONE PAGE of a pageset is reachable: the pageset must be visible
 * AND the page's own requiredGrants must all be granted (empty list = always
 * reachable inside an authorized pageset). This is the route guard's
 * decision for direct URL entry.
 */
export function isPageReachable(def: PagesetDef, pagePath: string, grants: PagesetGrants): boolean {
  if (!isPagesetVisible(def, grants)) return false;
  const page = def.pages.find((p) => p.path === pagePath);
  if (!page) return false;
  return hasAllGranted(grants[def.key], page.requiredGrants);
}

/**
 * Entries a surfaces home may render, in registry order: only pagesets the
 * tenant is authorized for, each carrying only its reachable pages.
 * Unknown/empty authorization -> empty array (fail-closed, nothing renders).
 */
export function visiblePagesets(grants: PagesetGrants): Array<{ def: PagesetDef; pages: PagesetDef["pages"] }> {
  const out: Array<{ def: PagesetDef; pages: PagesetDef["pages"] }> = [];
  for (const def of PAGESETS) {
    if (!isPagesetVisible(def, grants)) continue;
    const pages = def.pages.filter((p) => hasAllGranted(grants[def.key], p.requiredGrants));
    out.push({ def, pages });
  }
  return out;
}

/** Explainable block reason for the guard's user-facing message. */
export function pageBlockReason(def: PagesetDef, pagePath: string, grants: PagesetGrants): string {
  if (!isPagesetVisible(def, grants)) return "当前账号未开通该功能，请联系管理员开通";
  const page = def.pages.find((p) => p.path === pagePath);
  if (page && !hasAllGranted(grants[def.key], page.requiredGrants)) {
    return "当前账号无该页面权限，请联系管理员开通";
  }
  return "当前账号未开通该功能，请联系管理员开通";
}

/**
 * Pure route-guard decision: unknown base pages are allowed (the guard is
 * never mounted on them); everything else needs a settled, authorized read —
 * anything unsettled is "pending" (render nothing, never flash the page).
 * The guard component turns "blocked" into the bounce; tests drive this
 * directly.
 */
export function guardDecision(
  pagePath: string,
  status: "unknown" | "loading" | "ready" | "error",
  grants: PagesetGrants,
): "blocked" | "pending" | "allowed" {
  const def = pagesetByPagePath(pagePath);
  if (!def) return "allowed";
  if (status !== "ready") return "pending";
  return isPageReachable(def, pagePath, grants) ? "allowed" : "blocked";
}
