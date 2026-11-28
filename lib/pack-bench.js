// ── `bench` ability declaration (openspec: add-pack-bench-ability) ──────────
//
// A pack may declare how it uses 知验台 (ontology + rulers). Peer of `memory`:
// a manifest without `bench` is byte-identical to before, and the publish gate
// and the cell's install gate validate through THIS module so they can never
// disagree about what a declaration means.
//
// Two boundaries are not ordinary shape checks:
//
//   · `store.home` is an ENUM, never an address. A pack is a distributable
//     artifact; letting it name a DSN or a path would let it write into
//     someone else's database. Addresses get their own error so the refusal
//     reads as a boundary, not a typo (same rule as memory.store.home).
//   · `source` is pinned by name + version + digest. "Latest" would make the
//     same manifest resolve to different assets over time, and a digest is the
//     only thing that lets a copy answer "is this that version?".

export const BENCH_MODES = Object.freeze(["use", "fork", "share"]);
export const BENCH_ASSETS = Object.freeze(["ontology", "ruler", "gold", "eval-suite"]);
export const BENCH_STORES = Object.freeze(["platform", "customer"]);
export const BENCH_SOURCE_TIERS = Object.freeze(["official", "pack", "customer"]);
export const BENCH_VISIBILITIES = Object.freeze(["public", "tenant", "private"]);

/** Report states a `bench` entry may land in. Closed: a reader can switch on it. */
export const BENCH_REPORT_STATES = Object.freeze([
  "bound",
  "missing",
  "awaiting-store-binding",
  "unreachable",
  "conformance-failed",
  "forked",
  "published",
  "enrolled",
  "already-enrolled",
]);

//: Portable asset kind -> the declaration asset class it belongs to.
export const ENVELOPE_KIND_ASSET = Object.freeze({
  "ontology-template": "ontology",
  "vocabulary-release": "ontology",
  "ruler-set": "ruler",
  "gold-set": "gold",
  "eval-suite": "eval-suite",
});

//: A share pack embeds its selectable assets. Cap keeps a runaway manifest out
//: of the market (skills already have their own caps; this is a policy ceiling).
export const MAX_SHARED_ENVELOPES_CHARS = 512 * 1024;

const BLOCK_KEYS = ["mode", "assets", "source", "store", "domain", "fork", "share"];
const SOURCE_KEYS = ["tier", "name", "version", "digest"];
const STORE_KEYS = ["home"];
const FORK_KEYS = ["diff", "publish_as"];
const SHARE_KEYS = ["visibility", "asset_classes", "envelopes"];

// Shapes that mean "an address". Checked BEFORE the enum so the error explains
// the rule instead of merely listing two allowed words.
const ADDRESS_HINT = /(\/|\\|:\/\/|^[du]-|\.sqlite\b|\.db\b)/;
const DIGEST_RE = /^(?:sha256:)?[0-9a-f]{64}$/;

const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

const fail = (errors, error, path, code = "bench_invalid") => {
  errors.push({ error, path, code });
};

function checkSource(source, errors) {
  if (!isPlainObject(source)) {
    fail(errors, "source must be an object of { tier, name, version, digest }", "bench.source", "bench_source_invalid");
    return;
  }
  for (const key of Object.keys(source)) {
    if (!SOURCE_KEYS.includes(key)) {
      fail(errors, `source has unknown key '${key}' (only ${SOURCE_KEYS.join(", ")})`, `bench.source.${key}`, "bench_source_key_unknown");
    }
  }
  if (!BENCH_SOURCE_TIERS.includes(source.tier)) {
    fail(errors, `source.tier must be one of ${BENCH_SOURCE_TIERS.join(", ")}`, "bench.source.tier", "bench_source_tier_invalid");
  }
  if (typeof source.name !== "string" || !source.name.trim()) {
    fail(errors, "source.name must be a non-empty string", "bench.source.name", "bench_source_name_invalid");
  }
  if (!Number.isInteger(source.version) || source.version < 1) {
    fail(errors, "source.version must be a positive integer; a source is pinned, never 'latest'", "bench.source.version", "bench_source_version_invalid");
  }
  if (typeof source.digest !== "string" || !DIGEST_RE.test(source.digest)) {
    fail(errors, "source.digest must be 64 hex chars, optionally prefixed sha256: (a copy is only comparable by digest)", "bench.source.digest", "bench_source_digest_invalid");
  }
}

function checkStore(store, errors) {
  if (!isPlainObject(store)) {
    fail(errors, "store must be an object of { home }", "bench.store", "bench_store_invalid");
    return;
  }
  for (const key of Object.keys(store)) {
    if (!STORE_KEYS.includes(key)) {
      fail(errors, `store has unknown key '${key}' (only home)`, `bench.store.${key}`, "bench_store_key_unknown");
    }
  }
  const home = store.home;
  if (typeof home !== "string") {
    fail(errors, `store.home must be one of ${BENCH_STORES.join(", ")}`, "bench.store.home", "bench_store_home_invalid");
    return;
  }
  if (!BENCH_STORES.includes(home) && ADDRESS_HINT.test(home)) {
    fail(
      errors,
      `store.home = ${JSON.stringify(home)} looks like an address; a declaration may only name which store (${BENCH_STORES.join(", ")}). The address is resolved by the deployment from identity, because a distributable pack that can name a database can write into someone else's`,
      "bench.store.home",
      "bench_store_home_addressed",
    );
    return;
  }
  if (!BENCH_STORES.includes(home)) {
    fail(errors, `store.home must be one of ${BENCH_STORES.join(", ")} (got ${JSON.stringify(home)})`, "bench.store.home", "bench_store_home_invalid");
  }
}

/**
 * Validate one `bench` block. Returns [{error, path, code}] (empty = valid).
 *
 * Pure and dependency-free: imported by the gateway's publish prevalidation
 * and the cell's install check.
 */
export function validateBench(block, at = "bench") {
  const errors = [];
  if (!isPlainObject(block)) {
    return [{ error: `${at} must be an object (or omitted entirely)`, path: at, code: "bench_not_object" }];
  }
  for (const key of Object.keys(block)) {
    if (!BLOCK_KEYS.includes(key)) {
      fail(errors, `${at} has unknown key '${key}' (only ${BLOCK_KEYS.join(", ")})`, `${at}.${key}`, "bench_key_unknown");
    }
  }

  if (!BENCH_MODES.includes(block.mode)) {
    fail(errors, `mode must be one of ${BENCH_MODES.join(", ")}`, `${at}.mode`, "bench_mode_invalid");
  }

  const assets = block.assets;
  if (!Array.isArray(assets) || assets.length === 0) {
    fail(errors, "assets must be a non-empty array", `${at}.assets`, "bench_assets_invalid");
  } else {
    const seen = new Set();
    for (const asset of assets) {
      if (!BENCH_ASSETS.includes(asset)) {
        fail(errors, `assets entries must be one of ${BENCH_ASSETS.join(", ")} (got ${JSON.stringify(asset)})`, `${at}.assets`, "bench_asset_unknown");
      } else if (seen.has(asset)) {
        fail(errors, `assets declares '${asset}' twice`, `${at}.assets`, "bench_asset_duplicate");
      } else {
        seen.add(asset);
      }
    }
  }

  checkSource(block.source, errors);
  checkStore(block.store, errors);

  // Optional domain this team belongs to. It is a KEY, not an address: fleet
  // enrollment happens only inside domains the deployment credential was
  // approved for, so a pack naming a raw URL here would be meaningless.
  if (block.domain !== undefined) {
    if (typeof block.domain !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(block.domain)) {
      fail(errors, "domain must be a domain key (lowercase letters/digits/._-, 1-64 chars)", `${at}.domain`, "bench_domain_invalid");
    }
  }

  if (block.mode === "use" && (block.fork !== undefined || block.share !== undefined)) {
    fail(errors, "mode=use does not accept fork/share fields", at, "bench_mode_fields_mismatch");
  }

  if (block.mode === "fork") {
    if (!isPlainObject(block.fork)) {
      fail(errors, "mode=fork requires fork: { diff, publish_as? }", `${at}.fork`, "bench_fork_missing");
    } else {
      for (const key of Object.keys(block.fork)) {
        if (!FORK_KEYS.includes(key)) {
          fail(errors, `fork has unknown key '${key}' (only ${FORK_KEYS.join(", ")})`, `${at}.fork.${key}`, "bench_fork_key_unknown");
        }
      }
      const diff = block.fork.diff;
      const diffOk = (isPlainObject(diff) && Object.keys(diff).length > 0)
        || (typeof diff === "string" && diff.trim().length > 0);
      if (!diffOk) {
        fail(errors, "fork.diff is required and must say how the copy differs; a silent copy cannot be told apart from its source forever", `${at}.fork.diff`, "bench_fork_diff_missing");
      }
      if (block.fork.publish_as !== undefined && block.fork.publish_as !== null && block.fork.publish_as !== "pack") {
        fail(errors, 'fork.publish_as must be "pack" or omitted', `${at}.fork.publish_as`, "bench_fork_publish_invalid");
      }
    }
  } else if (block.fork !== undefined) {
    fail(errors, "fork is only legal when mode=fork", `${at}.fork`, "bench_fork_unexpected");
  }

  if (block.mode === "share") {
    if (!isPlainObject(block.share)) {
      fail(errors, "mode=share requires share: { visibility, asset_classes }", `${at}.share`, "bench_share_missing");
    } else {
      for (const key of Object.keys(block.share)) {
        if (!SHARE_KEYS.includes(key)) {
          fail(errors, `share has unknown key '${key}' (only ${SHARE_KEYS.join(", ")})`, `${at}.share.${key}`, "bench_share_key_unknown");
        }
      }
      if (!BENCH_VISIBILITIES.includes(block.share.visibility)) {
        fail(errors, `share.visibility must be one of ${BENCH_VISIBILITIES.join(", ")}`, `${at}.share.visibility`, "bench_share_visibility_invalid");
      }
      const classes = block.share.asset_classes;
      if (!Array.isArray(classes) || classes.length === 0) {
        fail(errors, "share.asset_classes must be a non-empty array (share per asset class, never implicitly everything)", `${at}.share.asset_classes`, "bench_share_classes_invalid");
      } else if (Array.isArray(assets)) {
        for (const cls of classes) {
          if (!BENCH_ASSETS.includes(cls)) {
            fail(errors, `share.asset_classes entries must be one of ${BENCH_ASSETS.join(", ")}`, `${at}.share.asset_classes`, "bench_share_class_unknown");
          } else if (!assets.includes(cls)) {
            fail(errors, `share.asset_classes names '${cls}', which the declaration does not list in assets`, `${at}.share.asset_classes`, "bench_share_class_not_declared");
          }
        }
      }

      // A share without its assets is a promise, not a share. Each envelope is
      // a portable asset version (root contract); the class must be one the
      // declaration selected, so publishing cannot leak a class the author
      // meant to keep private.
      const envelopes = block.share.envelopes;
      if (!Array.isArray(envelopes) || envelopes.length === 0) {
        fail(errors, "a share pack must embed at least one envelope (the asset being shared)", `${at}.share.envelopes`, "bench_share_envelopes_missing");
      } else {
        const seen = new Set();
        let totalChars = 0;
        envelopes.forEach((env, i) => {
          const p = `${at}.share.envelopes[${i}]`;
          if (!isPlainObject(env)) {
            fail(errors, "each shared envelope must be an object", p, "bench_share_envelope_invalid");
            return;
          }
          try {
            totalChars += JSON.stringify(env).length;
          } catch {
            fail(errors, "shared envelope is not JSON-serializable", p, "bench_share_envelope_invalid");
          }
          const asset = ENVELOPE_KIND_ASSET[env.kind];
          if (!asset) {
            fail(errors, `shared envelope kind must be one of ${Object.keys(ENVELOPE_KIND_ASSET).join(", ")}`, `${p}.kind`, "bench_share_envelope_kind");
          } else if (Array.isArray(classes) && !classes.includes(asset)) {
            fail(errors, `shared envelope kind '${env.kind}' belongs to asset '${asset}', which share.asset_classes does not select`, `${p}.kind`, "bench_share_envelope_class_not_shared");
          }
          if (typeof env.name !== "string" || !env.name.trim()) {
            fail(errors, "shared envelope needs a non-empty name", `${p}.name`, "bench_share_envelope_name");
          }
          if (!Number.isInteger(env.version) || env.version < 1) {
            fail(errors, "shared envelope version must be a positive integer", `${p}.version`, "bench_share_envelope_version");
          }
          if (typeof env.digest !== "string" || !DIGEST_RE.test(env.digest)) {
            fail(errors, "shared envelope digest must be 64 hex chars, optionally prefixed sha256:", `${p}.digest`, "bench_share_envelope_digest");
          }
          if (!isPlainObject(env.payload)) {
            fail(errors, "shared envelope payload must be an object", `${p}.payload`, "bench_share_envelope_payload");
          }
          const key = `${env.kind}:${env.name}:${env.version}`;
          if (seen.has(key)) {
            fail(errors, `shared envelope '${key}' is declared twice`, p, "bench_share_envelope_duplicate");
          } else {
            seen.add(key);
          }
        });
        if (totalChars > MAX_SHARED_ENVELOPES_CHARS) {
          fail(errors, `shared envelopes are ${totalChars} chars; the manifest ceiling is ${MAX_SHARED_ENVELOPES_CHARS}`, `${at}.share.envelopes`, "bench_share_envelopes_too_large");
        }
      }
    }
  } else if (block.share !== undefined) {
    fail(errors, "share is only legal when mode=share", `${at}.share`, "bench_share_unexpected");
  }

  return errors;
}

/** True when a declaration asks for a customer-managed store. */
export function needsCustomerStore(block) {
  return Boolean(block) && isPlainObject(block.store) && block.store.home === "customer";
}
