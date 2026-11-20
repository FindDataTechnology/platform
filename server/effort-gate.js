// ── Thinking-level capability gate ───────────────────────────────────────────
//
// A thinking level is a property of ONE model, not of a provider. Both facts
// below used to be violated, and together they produced the live failure
// `pi-ai provider "volces" model "cohere/north-mini-code:free" does not support
// reasoning effort "high"` (cell 2b043ce050ca134c, the `standard` post, every
// daily fire on 2026-11-10/11/13):
//
//   1. `llm.effort.<provider>` persisted the level for the whole route, so the
//      level chosen for `deepseek-v4.1-flash` was the default for every other
//      model on `volces` — including the non-reasoning ones.
//   2. The write path validated a member's `effort` against the UNION of all
//      models on the deployment (`effortUnionFrom`), so a legal declaration
//      ("somewhere there is a model with `high`") could land on a model that
//      declares nothing.
//
// The gate below is the single answer to "may this level be sent to this
// model?". Everything that is about to dispatch a selection goes through it, so
// the rule lives in exactly one place and cannot drift between call sites the
// way the two previous guards did (agent-session's switch AND its model-carry
// leg each had their own copy, and the cron path had none).
//
// `reasoningEfforts` shapes (pi-ai contract, dsh-llm-pi-ai/lib/types/catalog):
//   • absent            — inherits the installed catalog entry;
//   • `false`           — declares a NON-reasoning model (the sanctioned way to
//                         strip reasoning from a catalog model);
//   • non-empty dict    — the offered levels (keys) and their wire spellings.
export function declaredLevels(model) {
  const declared = model?.reasoningEfforts;
  // Two shapes describe the same capability:
  //   • pi-ai profile:   { low: "low", high: "high" }  (dict of wire spellings)
  //   • host catalog:    ["low", "medium", "high"]     (the offered names)
  // Accepting only the dict is how a caller with a list silently lost its
  // levels (caught by this change's own test before it shipped).
  if (Array.isArray(declared)) return declared.slice();
  if (!declared || typeof declared !== "object") return [];
  return Object.keys(declared);
}

// The effective level for a dispatch: `desired` when the model declares it,
// `null` otherwise. Never invents a level, never silently keeps a stale one.
export function effectiveEffort(desired, model) {
  if (!desired) return null;
  const levels = declaredLevels(model);
  return levels.includes(desired) ? desired : null;
}

// True when the desired level had to be dropped — the caller logs/persists a
// clear instead of sending a level the endpoint will refuse. Separated from
// `effectiveEffort` so the reason is nameable in telemetry and in tests.
export function effortWasDropped(desired, model) {
  return Boolean(desired) && effectiveEffort(desired, model) === null;
}

// ── Persistence addressing ───────────────────────────────────────────────────
// A level is stored FOR a model. The old key (`llm.effort.<provider>`) is
// legacy: it is still read once so an operator's existing choice survives the
// upgrade, but it is migrated to the per-model key and cleared. Keeping the old
// key WRITABLE is what let one model's level become a route default.
export function modelEffortKey(provider, model) {
  if (!provider || !model) return null;
  return `llm.effort.${provider}.${model}`;
}

export function legacyEffortKey(provider) {
  return provider ? `llm.effort.${provider}` : null;
}

// Resolve the persisted level for a LANDED model, self-healing as it goes.
//   • the per-model key wins; a value the model no longer declares is cleared
//     (the catalog changed under it — keeping it would drop the level every
//     turn and never say why);
//   • otherwise the legacy provider key is read ONCE, migrated when the model
//     declares the level, and cleared either way.
// `get`/`set` are the preference store's accessors; `declaredEfforts` is the
// landed model's capability in either shape `declaredLevels()` accepts.
export function resolvePersistedEffort({ provider, model, declaredEfforts = null, get, set }) {
  const read = typeof get === "function" ? (k) => (k ? get(k) : undefined) : () => undefined;
  const clear = typeof set === "function" ? (k) => { if (k) set(k, ""); } : () => {};
  const capability = { reasoningEfforts: declaredEfforts };
  const own = modelEffortKey(provider, model);
  const legacy = legacyEffortKey(provider);
  const ownRaw = own ? String(read(own) || "") : "";
  const legacyRaw = legacy ? String(read(legacy) || "") : "";

  if (ownRaw) {
    const level = effectiveEffort(ownRaw, capability);
    if (level) {
      // A leftover legacy row is superseded by the per-model one.
      if (legacyRaw) clear(legacy);
      return { level, migrated: false, cleared: legacyRaw ? [legacy] : [] };
    }
    clear(own);
    return { level: null, migrated: false, cleared: [own] };
  }

  if (!legacyRaw) return { level: null, migrated: false, cleared: [] };

  const level = effectiveEffort(legacyRaw, capability);
  if (level && own) {
    set(own, level);
    clear(legacy);
    return { level, migrated: true, cleared: [legacy] };
  }
  // The landed model does not declare the old provider-wide value: drop it now
  // rather than re-dropping it every turn (the spec's self-heal scenario).
  clear(legacy);
  return { level: null, migrated: false, cleared: [legacy] };
}
