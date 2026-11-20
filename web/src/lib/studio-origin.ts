// Supply-domain Studio origin (add-supply-studio-migration 4.1/2.3).
//
// The creation surface lives on the facet host now; the run domain links
// across (`#` carries facet's own hash router). ONE definition on purpose: the
// three copies drifted — App/AgentMarketPage defaulted to the facet host while
// FleetsPage defaulted to "" — so the team page's 来源蓝图 chip resolved to the
// platform domain and landed on the catch-all error face (live 2026-11-08).
//
// VITE_STUDIO_ORIGIN stays the release-window lever: setting it to "" (or the
// platform origin) keeps the in-domain shape, where /studio answers with a
// cross-domain redirect instead.
export const STUDIO_ORIGIN: string =
  (import.meta as { env?: Record<string, string> }).env?.VITE_STUDIO_ORIGIN ??
  "https://facet.finddatatech.cloud";

/** Supply-domain studio deep link; `search` is the hash-carried query
 *  (`?doc=<id>` / `?new=agent` — the supply-studio 深链契约 keys). */
export function studioHref(search = ""): string {
  return `${STUDIO_ORIGIN}/#/studio${search}`;
}

/** Back-link to one studio document (team detail's 来源蓝图 chip). */
export function studioDocHref(docId: string): string {
  return studioHref(`?doc=${encodeURIComponent(docId)}`);
}

/** True when `href` leaves this origin — callers open those in a new tab and
 *  must not hand them to react-router (it reads absolute URLs as in-app paths). */
export function isCrossOrigin(href: string): boolean {
  return /^https?:\/\//i.test(href);
}
