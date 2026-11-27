// Bulk-update decision logic for the installed-pack list (add-pack-bulk-update).
//
// Split out of the component so the branches that matter are testable with the
// repo's existing `node --test` harness — the web package has no test runner,
// and "verified by not looking at it" is not verification.
//
// Two pure functions, no React, no fetch:
//   · updatablesFrom — the ONE derivation behind the count badge, the per-pack
//     badge and the bulk set (design D2). Two independent comparisons is how
//     "one place says there's an update, the other doesn't" happens.
//   · runBulkUpdate — the serial execution contract (design D1/D3): one failure
//     never aborts the rest, and each outcome is reported as itself.

export interface InstalledLike {
  packId: string;
  name: string;
  version: number;
}

export type BulkOutcome = "updated" | "already-latest" | "failed";

export interface BulkResult {
  packId: string;
  name: string;
  status: BulkOutcome;
  error?: string;
}

/**
 * Packs whose market version is newer than the installed one.
 *
 * `latest` maps packId → the market's newest version. A pack missing from the
 * map is treated as "no newer version known" — which on a partially readable
 * market is the conservative answer (we never invent an upgrade).
 */
export function updatablesFrom<T extends InstalledLike>(
  packs: T[],
  latest: Record<string, number>,
): T[] {
  return (Array.isArray(packs) ? packs : []).filter(
    (p) => (latest[p.packId] ?? p.version) > p.version,
  );
}

/**
 * Execute the bulk update serially over the SAME install chain the single-pack
 * action uses: `subscribe(packId)` then `install(packId, version)`.
 *
 * Three outcomes, and they MUST stay distinct:
 *   updated         — installed a strictly newer version
 *   already-latest  — by the time we got to it, nothing newer existed. NOT a
 *                     failure: reporting it as one sends the user to look for a
 *                     fault that isn't there.
 *   failed          — the subscribe/install threw; carries the reason.
 *
 * A throw on one pack never stops the rest.
 */
export async function runBulkUpdate(
  packs: InstalledLike[],
  deps: {
    subscribe: (packId: string) => Promise<{ packId?: string; version?: number } | null | undefined>;
    install: (packId: string, version: number) => Promise<unknown>;
    onProgress?: (done: number, total: number) => void;
  },
): Promise<BulkResult[]> {
  const results: BulkResult[] = [];
  for (const pack of packs) {
    deps.onProgress?.(results.length + 1, packs.length);
    try {
      const sub = await deps.subscribe(pack.packId);
      const nextVersion = sub?.version ?? 0;
      if (!sub || nextVersion <= pack.version) {
        results.push({ packId: pack.packId, name: pack.name, status: "already-latest" });
        continue;
      }
      await deps.install(sub.packId ?? pack.packId, nextVersion);
      results.push({ packId: pack.packId, name: pack.name, status: "updated" });
    } catch (err) {
      results.push({
        packId: pack.packId,
        name: pack.name,
        status: "failed",
        error: (err as Error)?.message ?? String(err),
      });
    }
  }
  return results;
}
