// ── `bench` land-at-install (openspec: add-pack-bench-ability) ──────────────
//
// Install is the only place a pack's declaration meets a deployment. This
// module turns `manifest.bench` into one report item whose status is from the
// closed set in lib/pack-bench.js. It never throws and never fails the install:
// a bench entry that cannot land is a reported absence, not a broken pack —
// the same shape as `awaiting-local-binding` (MCP) and `awaitingCredential`
// (bots).
//
// Two stores, not one: a fork READS from the source tier's store (official /
// pack -> the platform store) and WRITES into the declared store (usually the
// customer's). Collapsing them into one would make a fork look for the official
// template inside the customer's database, where it has never been.
//
// `share` has no install step: it is resolved when the fork is PUBLISHED, so
// install records the declaration and moves on.

import {
  resolveStore,
  storeToken,
  probeSource,
  fetchEnvelope,
  importEnvelope,
} from "./bench-store.js";

/** Which store a source tier lives in. Official/pack assets are platform-side. */
export function sourceHomeFor(tier) {
  return tier === "customer" ? "customer" : "platform";
}

export async function installBenchEntry({ manifest, db = null, env = process.env, hooks = {} }) {
  const bench = manifest?.bench;
  if (!bench) return null;

  const base = {
    mode: bench.mode,
    assets: Array.isArray(bench.assets) ? [...bench.assets] : [],
    store: bench?.store?.home ?? null,
    source: bench?.source
      ? { name: bench.source.name, version: bench.source.version, digest: bench.source.digest }
      : null,
  };

  const resolver = typeof hooks.resolveBenchStore === "function" ? hooks.resolveBenchStore : null;
  const resolve = (home) =>
    resolver ? resolver({ home, manifest }) : resolveStore(home, { db });

  if (bench.mode === "share") {
    // The pack IS the distribution: its embedded envelopes land in the
    // declared store on install. An author who wants their assets to stay
    // private simply does not embed them (asset_classes selects what travels).
    const targetHome = bench.store?.home ?? "customer";
    const targetStore = await resolve(targetHome);
    if (!targetStore) {
      return { ...base, status: "awaiting-store-binding", reason: `no bench store is configured for the declared store '${targetHome}'` };
    }
    if (targetStore.conformance_status && targetStore.conformance_status !== "pass") {
      return { ...base, status: "conformance-failed", reason: `bench store '${targetStore.id}' has not passed conformance (${targetStore.conformance_status})` };
    }
    const targetToken = storeToken(targetStore, env);
    if (!targetToken) {
      return { ...base, status: "awaiting-store-binding", reason: `bench store '${targetStore.id}' names token env '${targetStore.token_env_ref}', which is unset` };
    }
    const envelopes = Array.isArray(bench.share?.envelopes) ? bench.share.envelopes : [];
    const results = [];
    for (const envelope of envelopes) {
      results.push(await importEnvelope(targetStore, targetToken, envelope, null));
    }
    const firstBad = results.find((r) => r.status !== "forked" && r.status !== "bound");
    if (firstBad) return { ...base, status: firstBad.status, reason: firstBad.reason };
    const created = results.some((r) => r.status === "forked");
    return {
      ...base,
      status: created ? "forked" : "bound",
      reason: created ? "shared assets landed in the declared store" : "shared assets were already present",
    };
  }

  const sourceHome = sourceHomeFor(bench.source?.tier);
  const sourceStore = await resolve(sourceHome);
  if (!sourceStore) {
    return {
      ...base,
      status: "awaiting-store-binding",
      reason: `no bench store is configured for '${sourceHome}' (source tier '${bench.source?.tier}') — the address is a deployment binding, never part of the pack`,
    };
  }
  if (sourceStore.conformance_status && sourceStore.conformance_status !== "pass") {
    return {
      ...base,
      status: "conformance-failed",
      reason: `bench store '${sourceStore.id}' has not passed conformance (${sourceStore.conformance_status})`,
    };
  }
  const sourceToken = storeToken(sourceStore, env);
  if (!sourceToken) {
    return {
      ...base,
      status: "awaiting-store-binding",
      reason: `bench store '${sourceStore.id}' names token env '${sourceStore.token_env_ref}', which is unset`,
    };
  }

  const asset = bench.assets?.[0] ?? "ontology";

  if (bench.mode === "use") {
    const probe = await probeSource(sourceStore, sourceToken, {
      asset,
      source: bench.source,
    });
    return { ...base, status: probe.status, reason: probe.reason };
  }

  if (bench.mode === "fork") {
    const targetHome = bench.store?.home ?? "customer";
    const targetStore = await resolve(targetHome);
    if (!targetStore) {
      return {
        ...base,
        status: "awaiting-store-binding",
        reason: `no bench store is configured for the declared store '${targetHome}'`,
      };
    }
    if (targetStore.conformance_status && targetStore.conformance_status !== "pass") {
      return {
        ...base,
        status: "conformance-failed",
        reason: `bench store '${targetStore.id}' has not passed conformance (${targetStore.conformance_status})`,
      };
    }
    const targetToken = storeToken(targetStore, env);
    if (!targetToken) {
      return {
        ...base,
        status: "awaiting-store-binding",
        reason: `bench store '${targetStore.id}' names token env '${targetStore.token_env_ref}', which is unset`,
      };
    }

    const exported = await fetchEnvelope(sourceStore, sourceToken, {
      asset,
      source: bench.source,
    });
    if (!exported.ok) {
      return { ...base, status: exported.status, reason: exported.reason };
    }
    const target =
      typeof hooks.benchTargetDomain === "function"
        ? hooks.benchTargetDomain({ manifest })
        : null;
    const imported = await importEnvelope(targetStore, targetToken, exported.body, target);
    return { ...base, status: imported.status, reason: imported.reason };
  }

  return { ...base, status: "declared", reason: `mode '${bench.mode}' has no install step` };
}
