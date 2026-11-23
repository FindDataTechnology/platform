// ── Voice catalog: the DATA layer of "which voice may be selected" ──────────
//
// openspec: add-room-voice-and-catalog (voice-catalog). See design.md D1.
//
// Why a file and not a table: the catalog is a DEPLOYMENT FACT (which voices
// exist), not user data (which voice this deployment picked — that lives in the
// stored `voice` block). Two layers, the same discipline im-lanes.json already
// uses: the shipped file is always present, and a deployment may replace it
// with a whole-directory mount, re-read on each call so a ConfigMap swap needs
// no image and no restart.
//
// The reason this module is load-bearing rather than a convenience: the 词元
// audio lane SILENTLY falls back to a default voice for a voice it does not
// recognise and still answers 200 (sub2api audio_tencent.go:355,
// audio_doubao.go:95-97). Without a write-side allowance list, "configurable"
// means "configured wrongly and nobody can tell".
//
// A bad entry FAILS the read and names itself. It is not dropped: a catalog
// that quietly loses an entry would send users to a voice the deployment thinks
// it still offers.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS_PATH = path.join(HERE, "voice-catalog.json");

/** The closed set of upstream protocols. A new protocol is a code change, not data. */
export const PROTOCOLS = Object.freeze(["tencent", "doubao"]);

const stripComments = (obj) => {
  if (Array.isArray(obj)) return obj.map(stripComments);
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "$comment") continue;
    out[k] = stripComments(v);
  }
  return out;
};

const keyOf = (protocol, model, voice) => `${protocol}|${model}|${voice}`;

/** `{ok: true, entry}` | `{ok: false, error}` — one entry, fully checked. */
export function validateEntry(raw, index = 0) {
  const where = (raw && typeof raw === "object" && typeof raw.label === "string" && raw.label) || `entries[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `${where} is not an object` };
  const protocol = typeof raw.protocol === "string" ? raw.protocol.trim() : "";
  if (!PROTOCOLS.includes(protocol)) {
    return { ok: false, error: `${where}: protocol must be one of ${PROTOCOLS.join(", ")} (got "${protocol}")` };
  }
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!model) return { ok: false, error: `${where}: model is required` };
  const voice = typeof raw.voice === "string" ? raw.voice.trim() : "";
  if (!voice) return { ok: false, error: `${where}: voice is required` };
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : `${model}:${voice}`;
  return { ok: true, entry: { protocol, model, voice, label } };
}

/** Validate a whole catalog document. Returns `{ok, catalog}` or `{ok:false, error}`. */
export function validateCatalog(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "catalog must be an object" };
  const list = Array.isArray(raw.entries) ? raw.entries : null;
  if (!list) return { ok: false, error: "catalog.entries must be an array" };
  const entries = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const r = validateEntry(list[i], i);
    if (!r.ok) return { ok: false, error: r.error };
    const k = keyOf(r.entry.protocol, r.entry.model, r.entry.voice);
    if (seen.has(k)) return { ok: false, error: `duplicate catalog entry: ${r.entry.protocol}/${r.entry.model}/${r.entry.voice}` };
    seen.add(k);
    entries.push(r.entry);
  }
  // The default must name an entry that exists, or a deployment with no
  // selection would point at nothing.
  let fallback = null;
  if (raw.default !== undefined && raw.default !== null) {
    const d = validateEntry(raw.default, 0);
    if (!d.ok) return { ok: false, error: `default: ${d.error}` };
    if (!seen.has(keyOf(d.entry.protocol, d.entry.model, d.entry.voice))) {
      return { ok: false, error: "default must name one of the catalog entries" };
    }
    fallback = d.entry;
  }
  if (!fallback && entries.length) fallback = entries[0];
  return { ok: true, catalog: { entries, default: fallback } };
}

/**
 * A catalog reader with the same two-layer, stat-on-read shape as lane-config:
 * shipped defaults always load; an optional mounted directory replaces them.
 *
 * @param {{dir?: string, onWarn?: (msg: string) => void}} [opts]
 */
export function createVoiceCatalog({ dir, onWarn = (m) => console.warn(m), defaultsPath = DEFAULTS_PATH } = {}) {
  let cache = null;
  let warnedBad = null;

  const overlayPath = () => {
    const d = dir ?? process.env.VOICE_CATALOG_DIR ?? "/etc/voice-catalog";
    return d ? path.join(d, "voice-catalog.json") : null;
  };

  const read = (file) => {
    let raw;
    try {
      raw = stripComments(JSON.parse(readFileSync(file, "utf8")));
    } catch (err) {
      return { ok: false, error: `cannot parse ${file}: ${err?.message || err}` };
    }
    return validateCatalog(raw);
  };

  function loadFile(file, kind) {
    const r = read(file);
    if (!r.ok) {
      // A broken catalog must not silently become an empty one — every caller
      // would then say "unknown voice" and the surface would look configurable
      // while nothing is selectable. Warn once per bad file, not per read: a
      // log flood is its own outage.
      const stamp = `${kind}:${file}:${r.error}`;
      if (warnedBad !== stamp) {
        warnedBad = stamp;
        onWarn(`[voice-catalog] ${kind} ${file} is invalid: ${r.error}`);
      }
      return null;
    }
    return r.catalog;
  }

  return {
    /** The effective catalog `{entries, default}`. One stat per call. */
    get() {
      const file = overlayPath();
      let st = null;
      if (file) {
        try {
          st = statSync(file);
        } catch {
          st = null; // nothing mounted: shipped defaults are the catalog
        }
      }
      const stamp = st ? `${st.mtimeMs}:${st.size}` : "default";
      if (cache && cache.stamp === stamp) return cache.catalog;
      let catalog = st ? loadFile(file, "overlay") : null;
      const source = catalog ? "overlay" : "default";
      if (!catalog) catalog = loadFile(defaultsPath, "defaults");
      if (!catalog) catalog = { entries: [], default: null };
      cache = { stamp, catalog, source };
      return catalog;
    },
    /** `entry` for an exact `{model, voice}` pair, or null. */
    entryFor({ model, voice } = {}) {
      const m = typeof model === "string" ? model.trim() : "";
      const v = typeof voice === "string" ? voice.trim() : "";
      if (!m || !v) return null;
      for (const e of this.get().entries) if (e.model === m && e.voice === v) return e;
      return null;
    },
    /** Is this exact pair a legal selection? */
    isAllowed({ model, voice } = {}) {
      return this.entryFor({ model, voice }) !== null;
    },
    /** The deployment fallback entry (may be null on an empty catalog). */
    fallback() {
      return this.get().default;
    },
    /** For diagnostics / the management face: which file actually supplied it. */
    source() {
      this.get();
      return cache?.source ?? "default";
    },
    /** Test seam. */
    _reset() {
      cache = null;
      warnedBad = null;
    },
  };
}

/** One process-wide reader; routes and the gateway both use it. */
export const voiceCatalog = createVoiceCatalog();

/**
 * Three-layer resolution (zhiyu-room / D4): the most specific layer wins.
 * Seat (this room's choice for this seat) → post (the fleet member's declared
 * voice) → deployment (the stored `voice` block, else the catalog default).
 *
 * A layer whose value is not in the catalog is SKIPPED, not fatal: the catalog
 * changes over time and an old declaration is expected to go stale. The skip is
 * reported so the caller can say why — silently falling to the default is the
 * exact failure this change exists to remove.
 *
 * @param {{seat?: any, post?: any, deployment?: any}} layers each `{model, voice}` or null
 * @param {{catalog?: {entryFor: Function, fallback: Function}}} [opts]
 * @returns {{entry: object|null, source: "seat"|"post"|"deployment"|"catalog-default"|null, skipped: Array<{layer:string,reason:string}>}}
 */
export function resolveVoice(layers = {}, { catalog = voiceCatalog } = {}) {
  const skipped = [];
  const order = ["seat", "post", "deployment"];
  for (const name of order) {
    const raw = layers[name];
    if (!raw) continue;
    const model = typeof raw?.model === "string" ? raw.model.trim() : "";
    const voice = typeof raw?.voice === "string" ? raw.voice.trim() : "";
    if (!model && !voice) continue;
    const entry = catalog.entryFor({ model, voice });
    if (!entry) {
      skipped.push({ layer: name, reason: "voice not in catalog" });
      continue;
    }
    return { entry, source: name, skipped };
  }
  // Nothing declared (or every declaration stale): the catalog's own default is
  // the last line, never a hard-coded voice.
  const entry = catalog.fallback();
  return { entry: entry ?? null, source: entry ? "catalog-default" : null, skipped };
}

