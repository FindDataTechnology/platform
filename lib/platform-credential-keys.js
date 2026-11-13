// ── Platform credential key names (openspec: harden-plugin-supply-gates) ─────
//
// ONE list, two readers — and that is the point:
//
//   · the build gate (`scripts/check-bundle-credentials.mjs`) refuses a supply
//     declaration that names any of these (runbook S6, machine-checked);
//   · the child-env scrubber (`dsh-profile.js` buildScrubbedEnv) removes them
//     from the environment handed to the dsh child, so a bundle running inside
//     that child cannot read them either.
//
// Two separate lists would drift, and the drift would be invisible: the build
// gate green while a runtime bundle reads a token that only one list knew about.
//
// Scope note: these are PLATFORM credentials (the platform's ability to act AS
// the platform). A user's own provider keys ride the per-user credentials store
// and are scrubbed by the existing CREDENTIAL_REFS mechanism.

/** Exact env key names the platform treats as its own credential material. */
export const PLATFORM_CREDENTIAL_KEY_NAMES = Object.freeze([
  "FACET_INTERNAL_TOKEN",
  "PACK_USAGE_TOKEN",
  "PACK_USAGE_URL",
  "SUB2API_ADMIN_KEY",
  "SUB2API_ADMIN_EMAIL",
  "SUB2API_ADMIN_PASSWORD",
  "MARKET_COOKIE",
  "E2E_FACET_TOKEN",
  "LLM_API_KEY",
]);

/** Key-name prefixes that are credential material in every variant. */
export const PLATFORM_CREDENTIAL_KEY_PREFIXES = Object.freeze(["LLM_PROVIDER_KEY"]);

/** True when an env/declaration key name is platform credential material. */
export function isPlatformCredentialKey(key) {
  const upper = String(key ?? "").toUpperCase();
  if (!upper) return false;
  return (
    PLATFORM_CREDENTIAL_KEY_NAMES.includes(upper) ||
    PLATFORM_CREDENTIAL_KEY_PREFIXES.some((prefix) => upper === prefix || upper.startsWith(`${prefix}_`))
  );
}

/** Every present env key that is platform credential material. */
export function platformCredentialKeysIn(env = process.env) {
  return Object.keys(env ?? {}).filter((key) => isPlatformCredentialKey(key));
}
