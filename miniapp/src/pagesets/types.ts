// Page-set hosting types (openspec: add-erp-miniapp-pagesets, D2).
//
// ERP page sets are PAGE-level packs — a manifest declares a list of pages
// with page-level requiredGrants — deliberately a different shape from the
// existing vertical-packs (skill+MCP+agent bundles). We reuse the pack
// METADATA discipline (id/version/specTrace) and the authorization SEMANTICS
// (unauthorized = invisible), never the vertical-pack loading implementation.
//
// These types are intentionally pure (no Taro/React imports) so the registry
// and the authorization decisions they back are unit-testable with node --test.

// Tenant-facing pageset key, as declared in each manifest's
// authorization.pagesetKey (finddata fd-erp-vertical-templates).
export type PagesetKey = "supply-chain.ue" | "supply-chain.se" | "supply-chain.sp" | "supply-chain.cp";

// One page inside a pageset. `path` is the app.config.ts route (statically
// registered — WeChat mini programs cannot register pages at runtime, so
// "unauthorized invisible" lands on entries + a route guard, never on dynamic
// loading). `requiredGrants` are the page-level grants this page's entries
// additionally need beyond the pageset's own grants; P0 manifests carry
// pageset-level grants only, so pages ship with an empty list and P1+ fills
// these as the manifests grow per-page fields.
export interface PagesetPageDef {
  /** Page id from the manifest (e.g. "ue-home"). */
  id: string;
  /** Static route under src/pages (e.g. "pages/ue/home"). */
  path: string;
  /** Entry label (manifest title). */
  title: string;
  /** Page-level grants; empty means "no grant beyond the pageset's own". */
  requiredGrants: string[];
}

export interface PagesetDef {
  key: PagesetKey;
  /** Manifest id (e.g. "supply-chain-ue-commerce"). */
  id: string;
  /** Human name (manifest name). */
  name: string;
  /** The pageset's home/entry page (id ends in -home). */
  homePath: string;
  /**
   * Manifest-level grant catalog (manifest authorization.requiredGrants).
   * Documents the pageset's permission surface; it is NOT an all-or-nothing
   * visibility gate — entries appear on pagesetKey authorization and the
   * server enforces grants per page (design D2).
   */
  requiredGrants: string[];
  pages: PagesetPageDef[];
}
