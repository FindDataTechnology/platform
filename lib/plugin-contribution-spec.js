// ── Plugin contribution classes (openspec: harden-plugin-supply-gates) ──────
//
// What a supplied bundle is ALLOWED to contribute to the runtime, decided by the
// platform's whitelist rather than by the bundle's own claims.
//
// The v1 rule is a finding, not a preference: the platform's only tool gate is
// keyed by MCP server name (`capByOperatorFace(scope.mcpTools, Object.keys(servers))`,
// fed from mcp.json), and plugin-native tools carry no server key —
// `plugins/list` reports bundle-level name/version/enabled and never tool names.
// So a bundle that contributes tools would sit OUTSIDE every gate we have.
// `tool` is therefore forbidden alongside the three classes that would bypass
// billing or credentials, until a name-level gate exists (design D3').
//
// Zero dependencies: the gateway and the bake step both validate with this file.

/** Classes a bundle may declare today. */
export const ALLOWED_CONTRIBUTIONS = ["skill", "ui", "service"];

/**
 * Classes that are refused, with the reason each is refused. Keeping the reason
 * next to the value is what makes the gate defensible in review: a future
 * reader has to argue with the reason, not just flip a string.
 */
export const FORBIDDEN_CONTRIBUTIONS = {
  tool: "plugin-native tools have no MCP server key, so no tool-face gate can bound them (design D3')",
  llm: "only the platform may register model routes — 萬星词元 lane + turn metering (D1)",
  credential: "a bundle may never hold or establish a platform credential channel (D4)",
  channel: "outbound channel processes are operator infrastructure, not a bundle's to start",
};

const MAX_CONTRIBUTIONS = 4;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate one supply-whitelist entry's contribution declaration.
 *
 * @param {unknown} entry  { name|id, version?, contributes[] }
 * @param {string} [at]   field path used in error messages
 * @returns {{error: string, entry?: string}[]}
 */
export function validateContributionDeclaration(entry, at = "supply entry") {
  const errors = [];
  if (!isPlainObject(entry)) {
    errors.push({ error: "supply entry must be an object", entry: at });
    return errors;
  }
  const name = typeof entry.name === "string" ? entry.name : typeof entry.id === "string" ? entry.id : "";
  if (!name) errors.push({ error: "supply entry needs a name (bundle package name)", entry: at });

  const contributes = entry.contributes;
  if (!Array.isArray(contributes) || contributes.length === 0) {
    // Missing declaration is NOT "assume harmless": an undeclared bundle has
    // not been reviewed for what it adds, and the whitelist is an act of review.
    errors.push({ error: "contributes must be a non-empty array of contribution classes", entry: `${at}.contributes` });
    return errors;
  }
  if (contributes.length > MAX_CONTRIBUTIONS) {
    errors.push({ error: `contributes accepts at most ${MAX_CONTRIBUTIONS} classes`, entry: `${at}.contributes` });
  }

  const seen = new Set();
  for (const cls of contributes) {
    if (typeof cls !== "string" || !cls) {
      errors.push({ error: "contribution class must be a non-empty string", entry: `${at}.contributes` });
      continue;
    }
    if (seen.has(cls)) {
      errors.push({ error: `contribution class '${cls}' is declared twice`, entry: `${at}.contributes` });
      continue;
    }
    seen.add(cls);
    if (Object.hasOwn(FORBIDDEN_CONTRIBUTIONS, cls)) {
      errors.push({ error: `contribution class '${cls}' is not allowed: ${FORBIDDEN_CONTRIBUTIONS[cls]}`, entry: `${at}.contributes` });
    } else if (!ALLOWED_CONTRIBUTIONS.includes(cls)) {
      errors.push({
        error: `unknown contribution class '${cls}' (allowed: ${ALLOWED_CONTRIBUTIONS.join(", ")})`,
        entry: `${at}.contributes`,
      });
    }
  }
  return errors;
}

/**
 * Validate a whole supply list: { bundles: [ ... ] }.
 * A missing/absent list is an honest empty supply, not an error.
 */
export function validateSupplyManifest(doc) {
  if (doc === undefined || doc === null) return [];
  if (!isPlainObject(doc)) return [{ error: "supply manifest must be an object", entry: "" }];
  const bundles = doc.bundles;
  if (bundles === undefined || bundles === null) return [];
  if (!Array.isArray(bundles)) return [{ error: "bundles must be an array", entry: "bundles" }];
  const errors = [];
  const names = new Set();
  bundles.forEach((entry, i) => {
    const at = `bundles[${i}]`;
    errors.push(...validateContributionDeclaration(entry, at));
    const name = entry && (entry.name ?? entry.id);
    if (typeof name === "string" && name) {
      if (names.has(name)) errors.push({ error: `bundle '${name}' is listed twice`, entry: at });
      names.add(name);
    }
  });
  return errors;
}

/** The classes a bundle is permitted to exercise, or null when it declared none. */
export function allowedClassesOf(entry) {
  const declared = Array.isArray(entry?.contributes) ? entry.contributes : [];
  return declared.filter((cls) => ALLOWED_CONTRIBUTIONS.includes(cls));
}
