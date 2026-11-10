// ── 在架条目 en 副轨覆盖核算 (overhaul-market-catalog-presentation 4.6/5.1/4.11) ──
//
// THE denominator is the 组织面 (the display surface an author declared on the
// zh main track), never a character count — a faithful translation of any
// length counts as covered. Fields that carry no runtime meaning (skill
// bodies, personas, promptTemplate) are deliberately OUTSIDE the surface:
// localization stops at the display layer (design D11).
//
// One module answers three faces with the SAME rule:
//   · the publish gate for roster-official authors (gateway/packs.js, 4.6)
//   · the in-repo / live-catalog coverage audit (scripts/audit-official-locale-coverage.mjs, 5.1)
//   · the honest-coverage marker on the detail face (4.11)
//
// A zero-dependency leaf by design (same law as pack-taxonomy/pack-locale):
// it imports nothing outside node builtins, so any side can consume it.

const DISPLAY_SCALARS = ["name", "description", "notes"];

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function blockFor(manifest, locale) {
  const i18n = manifest && typeof manifest === "object" ? manifest.i18n : null;
  const block = i18n && typeof i18n === "object" ? i18n[locale] : null;
  return block && typeof block === "object" && !Array.isArray(block) ? block : null;
}

// The org surface of one manifest as ordered field paths — each path is
// machine-greppable (it names the entity by its declared key/id, exactly the
// overlay reference form the i18n block uses) so a missing item is locatable
// in the author workbench, not just countable.
export function orgSurface(manifest) {
  const paths = [];
  if (!manifest || typeof manifest !== "object") return paths;

  for (const key of DISPLAY_SCALARS) {
    if (nonEmpty(manifest[key])) paths.push(key);
  }

  // guide: the whole group or nothing (overlay rule) — every step's title+body.
  if (manifest.guide && typeof manifest.guide === "object" && Array.isArray(manifest.guide.steps)) {
    manifest.guide.steps.forEach((st, i) => {
      if (st && typeof st === "object") {
        if (nonEmpty(st.title)) paths.push(`guide.steps[${i}].title`);
        if (nonEmpty(st.body)) paths.push(`guide.steps[${i}].body`);
      }
    });
  }

  if (Array.isArray(manifest.skills)) {
    manifest.skills.forEach((s, i) => {
      if (s && typeof s === "object" && nonEmpty(s.description)) {
        paths.push(`skills['${s.name ?? i}'].description`);
      }
      // add-skill-supply-annotations: a declared base title obliges the
      // localized display name in every locale block (pathCovered already
      // reads `name` for skills via the named-path regex).
      if (s && typeof s === "object" && nonEmpty(s.title)) {
        paths.push(`skills['${s.name ?? i}'].name`);
      }
    });
  }

  if (Array.isArray(manifest.agents)) {
    manifest.agents.forEach((a, i) => {
      if (a && typeof a === "object" && nonEmpty(a.name)) {
        paths.push(`agents['${a.id ?? i}'].name`);
      }
    });
  }

  if (Array.isArray(manifest.bots)) {
    manifest.bots.forEach((b, i) => {
      if (b && typeof b === "object" && nonEmpty(b.name)) {
        paths.push(`bots['${b.id ?? i}'].name`);
      }
    });
  }

  // v2 display fields (pack-display-format): declared presence defines the ask.
  if (nonEmpty(manifest.promise)) paths.push("promise");

  if (Array.isArray(manifest.tags) && manifest.tags.length > 0) paths.push("tags");

  if (Array.isArray(manifest.outcomes)) {
    manifest.outcomes.forEach((o, i) => {
      if (o && typeof o === "object" && nonEmpty(o.title)) paths.push(`outcomes[${i}].title`);
      if (o && typeof o === "object" && nonEmpty(o.detail)) paths.push(`outcomes[${i}].detail`);
    });
  }

  if (Array.isArray(manifest.examples)) {
    manifest.examples.forEach((e, i) => {
      if (e && typeof e === "object" && nonEmpty(e.title)) paths.push(`examples[${i}].title`);
      if (e && typeof e === "object" && nonEmpty(e.prompt)) paths.push(`examples[${i}].prompt`);
    });
  }

  return paths;
}

// Covered ⟺ the locale overlay carries a non-empty counterpart for that path
// (guide items: per-step; skills/agents/bots: keyed by the declared name/id;
// tags: the whole aligned array; outcomes/examples: per item per subfield).
function pathCovered(path, block, manifest) {
  if (!block) return false;
  if (DISPLAY_SCALARS.includes(path) || path === "promise") return nonEmpty(block[path]);
  if (path === "tags") return Array.isArray(block.tags) && block.tags.length === manifest.tags.length;

  const guide = /^guide\.steps\[(\d+)\]\.(title|body)$/.exec(path);
  if (guide) {
    const steps = block.guide && typeof block.guide === "object" ? block.guide.steps : null;
    const st = Array.isArray(steps) ? steps[Number(guide[1])] : null;
    return !!st && typeof st === "object" && nonEmpty(st[guide[2]]);
  }

  const named = /^(skills|agents|bots)\['([^']+)'\]\.(description|name)$/.exec(path);
  if (named) {
    const map = block[named[1]];
    const ov = map && typeof map === "object" ? map[named[2]] : null;
    return !!ov && typeof ov === "object" && nonEmpty(ov[named[3]]);
  }

  const item = /^(outcomes|examples)\[(\d+)\]\.(title|detail|prompt)$/.exec(path);
  if (item) {
    const arr = Array.isArray(block[item[1]]) ? block[item[1]] : null;
    const ov = arr ? arr[Number(item[2])] : null;
    return !!ov && typeof ov === "object" && nonEmpty(ov[item[3]]);
  }

  return false;
}

export function localeCoverage(manifest, locale = "en") {
  const block = blockFor(manifest, locale);
  const paths = orgSurface(manifest);
  const missing = [];
  for (const path of paths) {
    if (!pathCovered(path, block, manifest)) missing.push(path);
  }
  return {
    locale,
    total: paths.length,
    covered: paths.length - missing.length,
    missing,
  };
}

// The publish gate's verdict shape (4.6): null when the manifest passes the
// coverage ask, else the structured 422 body — itemized paths, not a
// percentage, so the workbench can jump straight to each gap.
export function officialEnGateBody(manifest) {
  const cov = localeCoverage(manifest, "en");
  if (cov.missing.length === 0) return null;
  return {
    error: `official publishes must carry full en coverage on the display surface (${cov.covered}/${cov.total} covered)`,
    code: "official_en_coverage_incomplete",
    coverage: { locale: "en", total: cov.total, covered: cov.covered, missing: cov.missing },
  };
}

// The gate opens ONLY when the deployment says so (design risk row: P4 first
// fills the catalog's coverage, then the door closes — in-flight publishes are
// never cut off mid-flight).
export function officialEnGateEnabled(env = process.env) {
  return env.PACK_OFFICIAL_EN_GATE === "1";
}
