// ── Console block spec (openspec: add-pack-console) ─────────────────────────
//
// The single definition of WHICH console blocks a pack may declare and what
// parameters each accepts, shared by the three places that must agree: the
// manifest validator (`lib/pack-manifest.js`), the server-side builders
// (`server/console-blocks/`), and the shared renderer package
// (`packages/console-blocks`).
//
// ZERO DEPENDENCIES ON PURPOSE — the gateway process imports the validator, so
// nothing reachable from here may pull in express, a DB handle or server code.
// Same posture as `lib/generic-bot-types.js`.
//
// Why a spec file rather than a registry: a registry would put the parameter
// allowlist behind a builder import, which the gateway cannot load. Adding a
// block means adding it HERE (ids + params) and adding a builder; the validator
// never needs a second edit, which is what keeps "new block = one place" true.
//
// The declaration is exposure, not configuration: no block takes a URL, a
// query, an endpoint or a credential. `FORBIDDEN_DECLARATION_KEYS` is the
// machine reading of that sentence — it is checked at EVERY level of the
// section, not just at the top.

export const CONSOLE_LIMITS = {
  // Ops-policy ceiling like PACK_LIMITS.maxAgents — a console that declares
  // more than this is a dashboard nobody reads, and every block costs a
  // builder call per open.
  maxBlocks: 8,
  maxHeadlineChars: 64,
  maxParamsPerBlock: 4,
};

export const CONSOLE_SURFACES = ["platform", "share"];

// Duration windows the KPI/spend readers understand. Values are literals, not
// a free-form duration string: the reader maps them to a fixed SQL window, so
// an unknown value would silently become "no rows".
const WINDOWS = ["24h", "7d", "30d"];

// Per-block parameter whitelist. An undeclared key is REJECTED (not ignored):
// a pack that asks for a parameter we do not honour would otherwise render a
// block that silently ignores its own heading.
export const CONSOLE_BLOCK_SPECS = {
  team: {},
  stream: { limit: { kind: "int", min: 1, max: 20 } },
  kpi: { window: { kind: "enum", values: WINDOWS } },
  decisions: { limit: { kind: "int", min: 1, max: 20 }, severity: { kind: "enum", values: ["all", "high"] } },
  spend: { window: { kind: "enum", values: WINDOWS } },
  orchestration: {},
};

export const CONSOLE_BLOCK_IDS = Object.keys(CONSOLE_BLOCK_SPECS);

// Keys that turn a declaration into configuration. Checked structurally at
// every depth so a nested `params.meta.url` cannot smuggle an endpoint in.
export const FORBIDDEN_DECLARATION_KEYS = [
  "url",
  "uri",
  "endpoint",
  "baseUrl",
  "query",
  "sql",
  "script",
  "command",
  "secret",
  "token",
  "credential",
  "apiKey",
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Walk a value looking for a forbidden key at any depth. Returns the path of
// the first offender, or null.
function findForbiddenKey(value, path) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findForbiddenKey(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_DECLARATION_KEYS.includes(key)) return childPath;
    const hit = findForbiddenKey(child, childPath);
    if (hit) return hit;
  }
  return null;
}

function checkParams(blockId, params, entry, errors) {
  if (params === undefined || params === null) return;
  if (!isPlainObject(params)) {
    errors.push({ error: "params must be an object when present", entry });
    return;
  }
  const spec = CONSOLE_BLOCK_SPECS[blockId];
  const keys = Object.keys(params);
  if (keys.length > CONSOLE_LIMITS.maxParamsPerBlock) {
    errors.push({ error: `params accepts at most ${CONSOLE_LIMITS.maxParamsPerBlock} keys`, entry });
    return;
  }
  for (const key of keys) {
    const rule = spec[key];
    const kentry = `${entry}.params.${key}`;
    if (!rule) {
      const allowed = Object.keys(spec);
      errors.push({
        error: allowed.length
          ? `params has unknown key '${key}' (only ${allowed.join(", ")})`
          : `params has unknown key '${key}' (this block accepts no parameters)`,
        entry: kentry,
      });
      continue;
    }
    const value = params[key];
    if (rule.kind === "int") {
      if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
        errors.push({ error: `must be an integer between ${rule.min} and ${rule.max}`, entry: kentry });
      }
      continue;
    }
    if (rule.kind === "enum" && !rule.values.includes(value)) {
      errors.push({ error: `must be one of ${rule.values.join(" / ")}`, entry: kentry });
    }
  }
}

// `headline` names a field inside a DECLARED block ("kpi.deliverables"). The
// block half must be declared in this console (a headline pointing at a block
// the pack did not include would render nothing); the field half is checked by
// the builder at read time, which is the only place that knows the shape.
function checkHeadline(headline, declaredIds, errors) {
  if (headline === undefined || headline === null) return;
  if (typeof headline !== "string" || !headline.trim()) {
    errors.push({ error: "headline must be a non-empty string when present", entry: "console.headline" });
    return;
  }
  if (headline.length > CONSOLE_LIMITS.maxHeadlineChars) {
    errors.push({
      error: `headline must be at most ${CONSOLE_LIMITS.maxHeadlineChars} characters`,
      entry: "console.headline",
    });
    return;
  }
  const dot = headline.indexOf(".");
  if (dot <= 0 || dot === headline.length - 1) {
    errors.push({ error: "headline must be '<block>.<field>' (e.g. kpi.deliverables)", entry: "console.headline" });
    return;
  }
  const blockId = headline.slice(0, dot);
  if (!declaredIds.includes(blockId)) {
    errors.push({ error: `headline references block '${blockId}', which this console does not declare`, entry: "console.headline" });
  }
}

/**
 * Validate a manifest `console` section. Pure; returns [] when absent.
 * Returns errors in the same shape the manifest validator uses
 * ({ error, entry?, code? }) so callers can concat directly.
 */
export function validateConsoleSection(section) {
  const errors = [];
  if (section === undefined || section === null) return errors;
  if (!isPlainObject(section)) {
    errors.push({ error: "console must be an object", entry: "console" });
    return errors;
  }

  for (const key of Object.keys(section)) {
    if (key !== "headline" && key !== "blocks") {
      errors.push({ error: `console has unknown key '${key}' (only headline, blocks)`, entry: "console" });
    }
  }

  const forbidden = findForbiddenKey(section, "console");
  if (forbidden) {
    errors.push({ error: `console must not carry a data-access key (found '${forbidden}')`, entry: forbidden });
  }

  const blocks = section.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    errors.push({ error: "console.blocks must be a non-empty array", entry: "console.blocks" });
    return errors;
  }
  if (blocks.length > CONSOLE_LIMITS.maxBlocks) {
    errors.push({
      error: `console.blocks accepts at most ${CONSOLE_LIMITS.maxBlocks} entries`,
      entry: "console.blocks",
    });
  }

  const declaredIds = [];
  const seen = new Set();
  blocks.forEach((entry, index) => {
    const at = `console.blocks[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push({ error: "block entry must be an object", entry: at });
      return;
    }
    for (const key of Object.keys(entry)) {
      if (key !== "block" && key !== "params" && key !== "surfaces") {
        errors.push({ error: `has unknown key '${key}' (only block, params, surfaces)`, entry: at });
      }
    }
    const blockId = entry.block;
    if (typeof blockId !== "string" || !blockId) {
      errors.push({ error: "block must be a non-empty string", entry: `${at}.block` });
      return;
    }
    if (!CONSOLE_BLOCK_SPECS[blockId]) {
      errors.push({
        error: `block '${blockId}' is not a registered console block (registered: ${CONSOLE_BLOCK_IDS.join(", ")})`,
        entry: `${at}.block`,
      });
      return;
    }
    if (seen.has(blockId)) {
      errors.push({ error: `block '${blockId}' is declared twice`, entry: `${at}.block` });
      return;
    }
    seen.add(blockId);
    declaredIds.push(blockId);

    if (entry.surfaces !== undefined) {
      if (!Array.isArray(entry.surfaces) || entry.surfaces.length === 0) {
        errors.push({ error: `surfaces must be a non-empty array of ${CONSOLE_SURFACES.join(" / ")}`, entry: `${at}.surfaces` });
      } else {
        for (const surface of entry.surfaces) {
          if (!CONSOLE_SURFACES.includes(surface)) {
            errors.push({
              error: `unknown surface '${surface}' (only ${CONSOLE_SURFACES.join(", ")})`,
              entry: `${at}.surfaces`,
            });
          }
        }
      }
    }

    checkParams(blockId, entry.params, at, errors);
  });

  // Headline is checked after blocks so "declared block" is answerable.
  checkHeadline(section.headline, declaredIds, errors);

  return errors;
}

/** The surfaces a declared block is exposed on. Absent ⇒ both. */
export function surfacesOf(blockEntry) {
  const declared = blockEntry?.surfaces;
  if (!Array.isArray(declared) || declared.length === 0) return [...CONSOLE_SURFACES];
  return declared.filter((s) => CONSOLE_SURFACES.includes(s));
}
