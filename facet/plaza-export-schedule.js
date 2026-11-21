// ── In-service plaza export scheduler (unify-supply-spine-lineage D2) ────────
//
// The plaza's machine surfaces used to be refreshed by a cron on a different
// host (cheap1) that shelled into a one-shot node container. That chain failed
// silently twice — a lost exec bit drifted the surfaces 7 days, and a scheduler
// that only logged to /tmp drifted them 13 days before anyone noticed. So the
// exporter now runs HERE, in the process that owns the catalog, and the write
// is staged then swapped atomically:
//
//   export into <siteRoot>/.staging-<ts>/  →  all-or-nothing rename into place
//
// A failed run leaves the previous generation serving unchanged, which is the
// honest degrade; a partially written family of surfaces (new llms.txt + old
// catalog.json) must never be visible, because the two would disagree about
// the inventory and nothing would say so.
//
// The export is the same `scripts/plaza-export.mjs` the cron used — this module
// schedules and swaps, it does not restate a single admission or gate rule.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function readCounts(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

/** How many materials a counts.json describes, straight from byCategory. */
function totalMaterials(counts) {
  return (counts?.byCategory ?? []).reduce((n, c) => n + (Number(c.count) || 0), 0);
}

/**
 * Run one export into a staging directory, then swap the generated family into
 * `siteRoot/generated/`.
 *
 * @param {object} opts
 * @param {string} opts.siteRoot      the front hall's root (FACET_SITE_ROOT)
 * @param {string} [opts.base]        catalog base URL (defaults to the process's own loopback)
 * @param {string} [opts.siteBase]    public base used inside generated copy
 * @param {string} [opts.exportScript] path to plaza-export.mjs
 * @param {boolean} [opts.allowStale] pass --allow-stale (replay the last snapshot on network failure)
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ok: boolean, generatedAt?: string, stale?: boolean, error?: string}>}
 */
export async function runExportOnce({
  siteRoot,
  base,
  siteBase,
  exportScript,
  allowStale = true,
  log = () => {},
  spawnImpl = spawn,
} = {}) {
  if (!siteRoot) return { ok: false, error: "FACET_SITE_ROOT is not set" };
  const generatedDir = path.join(siteRoot, "generated");
  const staging = path.join(siteRoot, `.staging-${Date.now()}`);

  fs.mkdirSync(staging, { recursive: true });

  const args = [exportScript, "--out", staging];
  if (base) args.push("--base", base);
  if (siteBase) args.push("--site-base", siteBase);
  // `--allow-stale` replays the previous snapshot from `<outDir>/catalog.json`,
  // and outDir here is the EMPTY staging dir — so name the live snapshot
  // explicitly. Without this a network failure always fails hard instead of
  // replaying the last generation with an honest stale marker.
  const liveCat = path.join(generatedDir, "catalog.json");
  if (allowStale && fs.existsSync(liveCat)) args.push("--previous", liveCat);
  if (allowStale) args.push("--allow-stale");

  const result = await new Promise((resolve) => {
    const child = spawnImpl(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (d) => {
      out += d;
    });
    child.stderr?.on("data", (d) => {
      out += d;
    });
    child.on("error", (err) => resolve({ code: -1, out: `${out}\n${err.message}` }));
    child.on("close", (code) => resolve({ code, out }));
  });

  if (result.code !== 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    log(`[plaza-export] run failed (code ${result.code}); previous surfaces kept`);
    return { ok: false, error: result.out.trim().slice(-2000) };
  }

  // A run that produced no catalog is not a successful export, even with exit 0
  // (an --allow-stale replay with no previous snapshot would land here).
  const stagedCatalog = path.join(staging, "catalog.json");
  if (!fs.existsSync(stagedCatalog)) {
    fs.rmSync(staging, { recursive: true, force: true });
    log("[plaza-export] run produced no catalog.json; previous surfaces kept");
    return { ok: false, error: "staging produced no catalog.json" };
  }

  let counts = {};
  try {
    counts = JSON.parse(fs.readFileSync(path.join(staging, "counts.json"), "utf8"));
  } catch {
    counts = {};
  }

  // A run that produced zero materials is refused when the previous generation
  // was non-empty. This is not paranoia: with no catalog source configured the
  // exporter happily reports success with packs=0, and swapping that in would
  // wipe a real inventory off every machine surface while all gates stayed
  // green (a zero-count family reconciles perfectly against zero sources).
  const prevCounts = readCounts(path.join(generatedDir, "counts.json"));
  const prevTotal = totalMaterials(prevCounts);
  const nextTotal = totalMaterials(counts);
  if (nextTotal === 0 && prevTotal > 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    log(
      `[plaza-export] refused: run produced 0 materials while the live generation has ${prevTotal}; ` +
        "previous surfaces kept (is a catalog source configured?)",
    );
    return { ok: false, error: "empty export refused; previous generation kept" };
  }

  // Swap: the whole generated family moves at once. Rename is atomic on one
  // filesystem, so no reader observes a mixed generation.
  const previous = path.join(siteRoot, `.previous-${Date.now()}`);
  if (fs.existsSync(generatedDir)) fs.renameSync(generatedDir, previous);
  try {
    fs.renameSync(staging, generatedDir);
  } catch (err) {
    // Put the old generation back if the swap failed — better an old complete
    // set than none.
    if (fs.existsSync(previous) && !fs.existsSync(generatedDir)) {
      fs.renameSync(previous, generatedDir);
    }
    fs.rmSync(staging, { recursive: true, force: true });
    log(`[plaza-export] swap failed (${err.message}); previous surfaces restored`);
    return { ok: false, error: err.message };
  }
  fs.rmSync(previous, { recursive: true, force: true });

  // The plaza host historically also served the surfaces at the site root (the
  // deploy script copied them up); keep that true for the compatibility door.
  for (const f of ["llms.txt", "llms-full.txt", "catalog.json"]) {
    const src = path.join(generatedDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(siteRoot, f));
  }
  // robots.txt is owned here too. It was always generated by the deploy script,
  // which made "the front door owns its machine surfaces" false for one of the
  // four: a process that owns three and 503s the fourth is a partial owner.
  fs.writeFileSync(
    path.join(siteRoot, "robots.txt"),
    "User-agent: *\nAllow: /\n# AI agents: start at /llms.txt — the self-contained site index\n",
  );

  log(
    `[plaza-export] ok generatedAt=${counts.generatedAt ?? "?"} packs=${counts.packs ?? "?"} ` +
      `skills=${counts.skills ?? "?"} mcp=${counts.mcpServers ?? "?"} stale=${Boolean(counts.stale)}`,
  );
  return { ok: true, generatedAt: counts.generatedAt, stale: Boolean(counts.stale), counts };
}

/**
 * Seed the front hall's own static assets into the site root.
 *
 * unify-supply-spine-lineage D2 的另一半（2026-11-21）：机器面由导出产出，
 * 但**门厅首页**是随镜像走的代码（index.html/style.css/script.js/locales），
 * 它不该由导出器生成——导出器只产数据。缺了它，facet 根路径会落到 SPA 兜底，
 * 访客看到的是「谦面介绍页」而不是素材广场，于是「把 agent. 跳过来」就成了退步。
 *
 * 幂等：每次都覆盖，因为它们是镜像的一部分（换镜像=换门厅），不是运行时状态。
 *
 * @returns {string[]} the asset names that were copied
 */
export function seedFrontHall({ siteRoot, from, log = () => {} } = {}) {
  if (!siteRoot || !from || !fs.existsSync(from)) return [];
  const copied = [];
  for (const name of ["index.html", "style.css", "script.js", "favicon.svg", "og.png"]) {
    const src = path.join(from, name);
    if (!fs.existsSync(src)) continue;
    try {
      fs.copyFileSync(src, path.join(siteRoot, name));
      copied.push(name);
    } catch (err) {
      log(`[plaza-export] could not seed ${name}: ${err?.message ?? err}`);
    }
  }
  const localesSrc = path.join(from, "locales");
  if (fs.existsSync(localesSrc)) {
    const dest = path.join(siteRoot, "locales");
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(localesSrc)) {
      if (!f.endsWith(".json")) continue;
      try {
        fs.copyFileSync(path.join(localesSrc, f), path.join(dest, f));
        copied.push(`locales/${f}`);
      } catch (err) {
        log(`[plaza-export] could not seed locales/${f}: ${err?.message ?? err}`);
      }
    }
  }
  if (copied.length) log(`[plaza-export] front hall seeded (${copied.length} assets)`);
  return copied;
}

/** Last observed export outcome, read by the export-owner probe. */
export const plazaExportState = { lastResult: null };

/**
 * Start the in-service schedule: once shortly after boot, then every
 * `intervalSecs`, plus a debounced publish-triggered run.
 *
 * @param {object} opts
 * @param {string} opts.siteRoot
 * @param {number} [opts.intervalSecs]  0 disables the periodic run
 * @param {number} [opts.bootDelayMs]   delay the first run so it never races boot
 * @param {number} [opts.debounceMs]    collapse a burst of publish events into one run
 * @param {(msg: string) => void} [opts.log]
 * @param {typeof runExportOnce} [opts.runOnce] test seam
 */
export function startExportSchedule({
  siteRoot,
  base,
  siteBase,
  exportScript,
  frontHallSource = "", // 门厅静态物在镜像里的目录（site-plaza/），随镜像走
  intervalSecs = 86400,
  bootDelayMs = 30_000,
  debounceMs = 60_000,
  log = (m) => console.log(m),
  runOnce = runExportOnce,
} = {}) {
  if (!siteRoot) {
    log("[plaza-export] FACET_SITE_ROOT unset — machine surfaces fall back to the image seed");
    return { trigger() {}, stop() {} };
  }

  // 门厅静态物先铺（幂等，随镜像走）。它与导出无关，所以不等导出成功。
  if (frontHallSource) seedFrontHall({ siteRoot, from: frontHallSource, log });

  // robots.txt is static and does not depend on the export succeeding, so it is
  // written once here rather than inside the swap. Its content used to be the
  // deploy script's job, which made the front door a partial owner of its four
  // machine surfaces.
  try {
    fs.writeFileSync(
      path.join(siteRoot, "robots.txt"),
      "User-agent: *\nAllow: /\n# AI agents: start at /llms.txt — the self-contained site index\n",
    );
  } catch (err) {
    log(`[plaza-export] could not write robots.txt: ${err?.message ?? err}`);
  }

  let running = false;
  let pending = false;
  let timer = null;
  let debounce = null;
  // Last observed outcome, for the export-owner probe. Process memory is the
  // right home for it: it describes THIS process's last run, and after a
  // restart "no run yet" is the honest answer.
  plazaExportState.lastResult = null;

  const run = async (why) => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      log(`[plaza-export] started (${why})`);
      const res = await runOnce({ siteRoot, base, siteBase, exportScript, log });
      plazaExportState.lastResult = {
        why,
        ok: res.ok,
        generatedAt: res.generatedAt ?? null,
        stale: Boolean(res.stale),
        at: new Date().toISOString(),
      };
      if (!res.ok) log(`[plaza-export] failed (${why}): ${res.error ?? "unknown"}`);
    } catch (err) {
      plazaExportState.lastResult = { why, ok: false, error: String(err?.message ?? err), at: new Date().toISOString() };
      log(`[plaza-export] threw (${why}): ${err?.message ?? err}`);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        void run("queued");
      }
    }
  };

  const boot = setTimeout(() => void run("boot"), bootDelayMs);
  boot.unref?.();
  if (intervalSecs > 0) {
    timer = setInterval(() => void run("periodic"), intervalSecs * 1000);
    timer.unref?.();
  }

  return {
    /** Publish events call this; bursts collapse into one run. */
    trigger() {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void run("publish"), debounceMs);
      debounce.unref?.();
    },
    stop() {
      clearTimeout(boot);
      if (timer) clearInterval(timer);
      if (debounce) clearTimeout(debounce);
    },
  };
}
