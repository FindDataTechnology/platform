// Trial handoff (complete-creator-loop D2). The supply domain never executes a
// pack: "try it" means "put this pack in a workspace that can run it". Two
// shapes, both already existing machinery:
//
//   • in-domain (the creator is already on 壹座): subscribe + install the same
//     way the market detail dialog does, then the caller opens chat;
//   • cross-domain (the creator is on the facet shell, a different process and
//     a different login): hand off through the same `deployCastPack=` deep link
//     the deploy action uses — 壹座 opens that pack's detail and the shipped
//     install → "打开对话" path takes over.
//
// Pure helpers here so node --test can pin the rules without a DOM.

export type TrialTarget = { ok: true; packId: string } | { ok: false; reason: "unpublished" };

/**
 * Whether a draft can be tried at all.
 *
 * A draft that has never been published has no pack id, and the install path
 * takes ONLY `{packId, version}` — the cell fetches the manifest from the
 * market under the caller's identity (`pack-install-server-side-manifest`).
 * There is therefore nothing to install and nothing to hand off: the honest
 * answer is "publish a version first", not a button that fails.
 */
export function trialTarget(draft: { publishedPackId?: string | null } | null | undefined): TrialTarget {
  const packId = typeof draft?.publishedPackId === "string" ? draft.publishedPackId.trim() : "";
  return packId ? { ok: true, packId } : { ok: false, reason: "unpublished" };
}

/**
 * The cross-domain deep link. `/packs` is what the deploy handoff already uses
 * (it redirects to the merged market surface); `trial=1` only marks the intent
 * — the install-and-open-chat behaviour behind it is the shipped one.
 */
export function trialHandoffHref(runOrigin: string, packId: string): string {
  const base = String(runOrigin || "").replace(/\/+$/, "");
  const qs = new URLSearchParams({ deployCastPack: packId, trial: "1" });
  return `${base}/packs?${qs.toString()}`;
}
