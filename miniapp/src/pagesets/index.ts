// Public surface of the pageset host layer (P0, openspec add-erp-miniapp-pagesets).
//
// P1+ integration points (documented, not yet wired — P0 adds no pages):
//   - app.config.ts: append "pages/<surface>/..." routes per phase (static
//     registration is a WeChat constraint; the registry only drives entries
//     and guards, never dynamic loading).
//   - Each pageset page: wrap its body in <PagesetGate pagePath=...>.
//   - Each pageset home: render entries from useVisiblePagesets().
//   - Identity switches (runtime.switchBase, re-bind): call resetPagesetAuth()
//     before the next boot so grants from the previous origin never leak.

export { PAGESETS, pageByPath, pagesetByPagePath, pagesetByKey } from "./registry.ts";
export {
  isPageReachable,
  isPagesetVisible,
  pageBlockReason,
  parsePagesetAuth,
  PAGESET_AUTH_PATH,
  visiblePagesets,
} from "./authorize.ts";
export { resetPagesetAuth, usePagesetAuthStore } from "./store.ts";
export { guardDecision, PagesetGate, useVisiblePagesets } from "./guard.tsx";
export type { PagesetDef, PagesetKey, PagesetPageDef } from "./types.ts";
