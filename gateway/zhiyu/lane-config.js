// ── IM lane configuration: the DATA layer, re-read so it can change without a build ──
//
// Why this exists (externalize-im-platform-adapters, 2026-11-19): changing three
// sentences of group copy and one timeout required snapshot → GHA → relay →
// GitOps → ArgoCD → pod roll. The user's words: "为什么还要重新出片…这个就应该做成
// 可配置的". The data was in code; the fix is not merely "move it to JSON" — it is
// "move it to JSON that does not ship inside the image".
//
// Two layers, deliberately:
//   • defaults  gateway/zhiyu/im-lanes.json   — ships in the image, always present
//   • overlay   <IM_LANES_DIR>/im-lanes.json  — whole-directory mount, optional
//
// With only one layer you must choose between "can never change it" (baked) and
// "cannot start without it" (external). Two layers make "unconfigured = defaults"
// a structural property rather than an operator's memory.
//
// Hot reload is a stat() on each read, not fs.watch: a ConfigMap update is an
// atomic symlink swap, and watcher behaviour differs by kubelet version and is
// dead under subPath. "Re-read on the next turn" is exactly the promise we make.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS_PATH = path.join(HERE, "im-lanes.json");

/** Fields whose shape we validate. A wrong type falls back for THAT FIELD ONLY. */
const SHAPES = {
  "echo.events": (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  "copy.default": (v) => typeof v === "string",
  "copy.seatsSeparator": (v) => typeof v === "string",
  "copy.seatsWrapper": (v) => typeof v === "string",
  "dispatch": (v) => v && typeof v === "object" && !Array.isArray(v),
  "timeouts": (v) => v && typeof v === "object" && !Array.isArray(v),
};

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

function readJson(file) {
  return stripComments(JSON.parse(readFileSync(file, "utf8")));
}

/** Render a copy template. Only known placeholders are substituted; an unknown
 *  one is left visible so a typo shows up in staging instead of vanishing. */
export function renderCopy(template, vars = {}) {
  if (template === null) return ""; // deliberate silence
  if (typeof template !== "string") return "";
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    Object.hasOwn(vars, key) ? String(vars[key]) : whole,
  );
}

/** The copy for one event row, or "" when this event must stay silent. */
export function copyForEvent(cfg, event, row) {
  const entry = cfg.copy.events[event];
  if (entry === undefined) {
    // An event we have no sentence for is better described generically than
    // shown by its internal name. The caller decides whether to send at all.
    return cfg.copy.default ? renderCopy(cfg.copy.default) : "";
  }
  if (entry === null) return ""; // explicitly silent
  if (typeof entry === "string") return renderCopy(entry);
  if (entry && typeof entry === "object") {
    // Phase-dependent copy (commander_receipt today).
    const phase = String(row?.meta?.phase ?? "dispatched");
    const text = entry[phase] ?? entry.dispatched ?? entry.default;
    if (!text) return "";
    const seats = Array.isArray(row?.meta?.seats) ? row.meta.seats.join(cfg.copy.seatsSeparator) : "";
    return renderCopy(text, { seats: seats ? renderCopy(cfg.copy.seatsWrapper, { seats }) : "" });
  }
  return "";
}

/**
 * Build the effective config: defaults, overlaid field by field with the mounted
 * copy. Partial overlay, never whole-file replacement — a file that changes one
 * sentence must not erase the other twenty.
 */
export function mergeLaneConfig(defaults, overlay, onWarn = () => {}) {
  const cfg = JSON.parse(JSON.stringify(defaults));
  if (!overlay || typeof overlay !== "object") return cfg;
  // copy.events merges PER EVENT and must run before the section-level pass:
  // a file that overrides one sentence has to leave its siblings alone, and the
  // generic section merge below would replace the whole map.
  const overlayCopy = overlay.copy?.events;
  if (overlayCopy && typeof overlayCopy === "object" && !Array.isArray(overlayCopy)) {
    cfg.copy.events = { ...cfg.copy.events, ...overlayCopy };
  }
  for (const [key, shape] of Object.entries(SHAPES)) {
    const [section, field] = key.split(".");
    const incoming = field === undefined ? overlay[section] : overlay[section]?.[field];
    if (incoming === undefined) continue;
    if (!shape(incoming)) {
      onWarn(`[im-lanes] "${key}" has the wrong shape in the overlay; keeping the default`);
      continue;
    }
    if (field === undefined) {
      // `copy.events` was merged per-event above; a section spread would replace
      // the whole map with the overlay's partial one.
      const { events: _ignoredEvents, ...rest } = incoming;
      cfg[section] = { ...cfg[section], ...rest };
    } else cfg[section] = { ...cfg[section], [field]: incoming };
  }
  return cfg;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dir]         overlay directory (default: $IM_LANES_DIR or /etc/im-lanes)
 * @param {object} [opts.defaults]    preloaded defaults (tests)
 * @param {(msg:string)=>void} [opts.onWarn]
 */
export function createLaneConfig({ dir, defaults, onWarn = (m) => console.warn(m) } = {}) {
  const defaultsPath = DEFAULTS_PATH;
  let baseDefaults = defaults ?? null;
  // Read the shipped defaults once: they cannot change while the process runs
  // (they are inside the image).
  const getDefaults = () => {
    if (!baseDefaults) baseDefaults = readJson(defaultsPath);
    return baseDefaults;
  };

  let cache = null; // { mtimeMs, size, value, source }
  let warnedBadFile = null;

  function overlayPath() {
    const d = dir ?? process.env.IM_LANES_DIR ?? "/etc/im-lanes";
    return d ? path.join(d, "im-lanes.json") : null;
  }

  return {
    /** The effective config. Cheap enough to call per turn (one stat). */
    get() {
      const file = overlayPath();
      if (!file) {
        if (!cache) cache = { mtimeMs: -1, size: -1, value: mergeLaneConfig(getDefaults(), null), source: "default" };
        return cache.value;
      }
      let st = null;
      try {
        // Follow symlinks: a ConfigMap swap replaces a symlink, and stat() gives
        // us the NEW file's identity. statSync follows by default.
        st = statSync(file);
      } catch {
        // No overlay mounted: the shipped defaults are the config, full stop.
        if (!cache || cache.source !== "default") {
          cache = { mtimeMs: -1, size: -1, value: mergeLaneConfig(getDefaults(), null), source: "default" };
        }
        return cache.value;
      }
      if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size && cache.source !== "default") {
        return cache.value;
      }
      let overlay = null;
      try {
        overlay = readJson(file);
      } catch (err) {
        // A broken file must never take the channel down. Say so once per file
        // version, not on every turn — a log flood is its own outage.
        const stamp = `${st.mtimeMs}:${st.size}`;
        if (warnedBadFile !== stamp) {
          warnedBadFile = stamp;
          onWarn(`[im-lanes] cannot parse ${file} (${err?.message || err}); using shipped defaults`);
        }
        cache = { mtimeMs: st.mtimeMs, size: st.size, value: mergeLaneConfig(getDefaults(), null), source: "default" };
        return cache.value;
      }
      cache = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        value: mergeLaneConfig(getDefaults(), overlay, onWarn),
        source: "merged",
      };
      return cache.value;
    },
    /** For the management face / health: "default" means nothing is mounted. */
    source() {
      this.get();
      return cache?.source ?? "default";
    },
    /** Test seam. */
    _reset() {
      cache = null;
      warnedBadFile = null;
      if (!defaults) baseDefaults = null;
    },
  };
}
