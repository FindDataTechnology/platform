// ── LLM route exclusivity (openspec: harden-plugin-supply-gates) ────────────
//
// The platform owns model routing: `dsh-profile.js` writes exactly one
// `llm-pi-ai` row (plus the `spill-policy` row it also owns) into the profile's
// patch layer, and every model id the product serves comes from that generator.
// Two product rules depend on that being the ONLY writer:
//
//   · "模型必须走萬星词元" — an external provider registered by a bundle would
//     bypass the ruling outright;
//   · metering — a route that never passes the platform's lane never lands a
//     priced turn, so the ledger would under-report while the bill is real.
//
// Today nothing enforces it. `writeLlmProfile` de-dupes its OWN two rows and
// deliberately preserves every other row ("the scaffold's inserts"), so a
// supplied bundle that contributes `{ id: "vendor-llm", name: "@acme/dsh-llm-router" }`
// survives composition and registers a second provider. This module is the
// assertion that closes that: pure, no I/O, one implementation shared by the
// write path and the boot path.
//
// Matching is by SHAPE, not by an id allowlist. An id is whatever the author
// typed; the `name` and the config tell you what the row will actually do. So a
// row is "a model route" when its name looks like a model/provider package, or
// its config carries a provider table / base URL — and it is allowed only when
// its id AND name are the platform's own pair (an id alone can be spoofed).

// The pair the platform owns. `spill-policy` is not a model route, but it is
// composed by the same generator and must stay singular for the same reason
// (one inline-budget authority), so it rides the same assertion.
export const PLATFORM_ROUTE_ROWS = [
  { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai" },
  { id: "spill-policy", name: "@deepseek-ai/dsh-spill-policy" },
];

// Name shapes that mean "this package registers or proxies model providers".
// Deliberately broad: a false positive costs an operator one explicit exception
// (with an expiry), while a false negative costs a bypassed billing lane.
const ROUTE_NAME_PATTERNS = [
  // dsh-llm, @scope/dsh-llm-pi-ai, dsh-llm-router, dsh-provider-*
  /\bdsh-llm\b/i,
  /\bdsh-llm[-/@]/i,
  /[-/@]llm[-/@]/i,
  /\bllm-provider\b/i,
  /\bprovider-(router|gateway|proxy)\b/i,
];

// Config shapes that mean "this row configures providers", independent of name.
// `baseURL`/`baseUrl`/`apiBase` are how an OpenAI-compatible client is pointed
// somewhere — the concrete bypass a bundle would use.
const ROUTE_CONFIG_KEYS = ["providers", "baseURL", "baseUrl", "apiBase", "openaiBase", "route"];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nameLooksLikeRoute(name) {
  if (typeof name !== "string" || !name) return false;
  return ROUTE_NAME_PATTERNS.some((re) => re.test(name));
}

function configLooksLikeRoute(config) {
  if (!isPlainObject(config)) return false;
  return ROUTE_CONFIG_KEYS.some((key) => Object.hasOwn(config, key));
}

function platformRowMatches(row) {
  return PLATFORM_ROUTE_ROWS.some((own) => row.id === own.id && row.name === own.name);
}

// Patch entries may nest: `{ insert: [ {...}, { insert: [...] } ] }`. Walk
// everything so a nested insert cannot hide a provider row.
function flattenRows(rows, out = [], depth = 0) {
  if (depth > 8) return out; // malformed/adversarial nesting: stop, still inspect what we saw
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isPlainObject(row)) continue;
    out.push(row);
    if (Array.isArray(row.insert)) flattenRows(row.insert, out, depth + 1);
  }
  return out;
}

/**
 * Assert that only the platform's own rows can register model routes.
 *
 * @param {unknown} rows the composed patch rows (any nesting of `insert`)
 * @returns {{id: string|null, name: string|null, reason: string}[]} violations
 */
export function findRouteExclusivityViolations(rows) {
  const violations = [];
  for (const row of flattenRows(rows)) {
    const name = typeof row.name === "string" ? row.name : null;
    const id = typeof row.id === "string" ? row.id : null;
    const routeLike = nameLooksLikeRoute(name) || configLooksLikeRoute(row.config);
    if (!routeLike) continue;
    if (platformRowMatches(row)) continue;
    // Name the reason precisely: an operator reading the crash needs to know
    // whether it is an impostor id, a foreign provider, or a config-only route.
    let reason;
    if (id === "llm-pi-ai" || id === "spill-policy") {
      reason = `row id '${id}' is reserved for the platform's own package (name was '${name ?? "missing"}')`;
    } else if (configLooksLikeRoute(row.config)) {
      reason = `row '${id ?? "(no id)"}' configures model providers (keys: ${ROUTE_CONFIG_KEYS.filter((k) => Object.hasOwn(row.config ?? {}, k)).join(", ")})`;
    } else {
      reason = `row '${id ?? "(no id)"}' is '${name}' — a model route not written by the platform`;
    }
    violations.push({ id, name, reason });
  }
  return violations;
}

// ── Operator exceptions (task 4.3) ──────────────────────────────────────────
//
// A gate with no escape hatch gets switched off the first time it blocks a
// legitimate deployment. So there IS an exception list — but it is a list of
// decisions with an expiry, not a quiet allowlist:
//
//   · matched by PACKAGE NAME, never by row id (an id is whatever the author
//     typed; the name is the thing that actually runs);
//   · every entry needs `expiresAt`, `approvedBy` and `reason` — an undocumented
//     exception is exactly the "先例" this gate exists to prevent;
//   · an EXPIRED entry stops working and is reported separately, so a forgotten
//     exception cannot become permanent by inattention.
//
// Entries are validated here (pure) so both the write path and the boot path
// apply the same rules to the same file.

export function validateRouteException(entry) {
  const errors = [];
  if (!isPlainObject(entry)) return ["exception entry must be an object"];
  if (typeof entry.name !== "string" || !entry.name) errors.push("exception needs the bundle package name");
  if (typeof entry.reason !== "string" || !entry.reason.trim()) errors.push("exception needs a reason");
  if (typeof entry.approvedBy !== "string" || !entry.approvedBy.trim()) errors.push("exception needs approvedBy");
  if (!Number.isFinite(entry.expiresAt)) errors.push("exception needs a numeric expiresAt (epoch ms)");
  return errors;
}

/**
 * Partition violations into still-violating and excepted.
 *
 * @param {{id: string|null, name: string|null, reason: string}[]} violations
 * @param {{name: string, reason?: string, approvedBy?: string, expiresAt?: number}[]} exceptions
 * @param {{now?: number}} [opts]
 */
export function applyRouteExceptions(violations, exceptions = [], { now = Date.now() } = {}) {
  const usable = [];
  const expired = [];
  for (const entry of Array.isArray(exceptions) ? exceptions : []) {
    if (validateRouteException(entry).length > 0) continue; // invalid entries grant nothing
    if (entry.expiresAt <= now) expired.push(entry);
    else usable.push(entry);
  }
  const remaining = [];
  const allowed = [];
  for (const violation of violations) {
    const hit = usable.find((entry) => entry.name === violation.name);
    if (hit) allowed.push({ violation, exception: hit });
    else remaining.push(violation);
  }
  return { violations: remaining, allowed, expired };
}

/**
 * Throwing form used by the write path and the boot path.
 * Fail closed: a violation stops the caller, it never degrades to "ignore the row".
 */
export function assertRouteExclusivity(rows) {
  throwRouteViolations(findRouteExclusivityViolations(rows));
}

/** Throw path shared by the generator and the boot guard, which filter first. */
export function throwRouteViolations(violations) {
  if (!Array.isArray(violations) || violations.length === 0) return;
  const detail = violations.map((v) => `· ${v.reason}`).join("\n");
  const err = new Error(
    `model route exclusivity violated — only the platform may register model routes:\n${detail}`,
  );
  err.code = "dsh_route_exclusivity_violation";
  err.violations = violations;
  throw err;
}
