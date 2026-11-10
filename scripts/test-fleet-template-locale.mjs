#!/usr/bin/env node
// ── Fleet template display-locale overlay (add-pack-locale-tracks, 3.1/3.2) ─
//
// fleet.i18n carries secondary-language DISPLAY text only — template name,
// member titles, KPI slot labels. parseFleetTemplate must refuse structural
// or content-shaped overrides (ghost refs, ghost slot keys, zh blocks,
// promptTemplate/persona riding in), and the parse output stays byte-
// identical when the block is absent. projectManifestForLocale applies the
// overlay for display, leaving every structural field untouched.
//
//   node --test scripts/test-fleet-template-locale.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFleetTemplate } from "../server/fleet-template.js";
import { projectManifestForLocale } from "../lib/pack-locale.js";

const fleet = (extra = {}) => ({
  name: "政心盯梢集群",
  members: [
    {
      ref: "watch",
      title: "监视岗",
      target: { kind: "existing-a2a", id: "a2a-watch" },
      kpiSlots: [{ key: "alerts", label: "告警数" }],
      cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", promptTemplate: "盯住今日政策变化" },
    },
    { ref: "lead", title: "负责人", parentRef: "watch", target: { kind: "existing-persona", id: "p-lead" } },
  ],
  ...extra,
});

const manifest = (fleetSection = fleet()) => ({ name: fleetSection.name, fleet: fleetSection });

const ERR = (mf) => {
  const result = parseFleetTemplate(mf);
  assert.equal(result.ok, false, "expected a refusal, got ok");
  return result.error;
};

test("a template without fleet.i18n parses to the same template (compat)", () => {
  const plain = parseFleetTemplate(manifest());
  assert.equal(plain.ok, true);
  const withI18n = parseFleetTemplate(
    manifest(fleet({ i18n: { en: { name: "Policy Sentinel Cluster" } } })),
  );
  assert.equal(withI18n.ok, true);
  assert.deepEqual(withI18n.template, plain.template);
});

test("a well-formed overlay passes validation", () => {
  const result = parseFleetTemplate(
    manifest(fleet({
      i18n: {
        en: {
          name: "Policy Sentinel Cluster",
          members: {
            watch: { title: "Watch Post", kpiSlots: { alerts: { label: "Alerts" } } },
            lead: { title: "Owner" },
          },
        },
      },
    })),
  );
  assert.equal(result.ok, true, result.error);
});

test("an overlay referencing an unknown member ref is refused", () => {
  assert.match(ERR(manifest(fleet({ i18n: { en: { members: { ghost: { title: "X" } } } } }))), /ghost/);
});

test("an overlay referencing an unknown slot key is refused", () => {
  const err = ERR(manifest(fleet({ i18n: { en: { members: { watch: { kpiSlots: { ghost: { label: "X" } } } } } } })));
  assert.match(err, /ghost/);
});

test("a zh block inside fleet.i18n is refused", () => {
  assert.match(ERR(manifest(fleet({ i18n: { zh: { name: "X" } } }))), /main track/);
});

test("content keys (promptTemplate/persona) inside the overlay are refused", () => {
  const err = ERR(manifest(fleet({ i18n: { en: { members: { watch: { promptTemplate: "x" } } } } })));
  assert.match(err, /not localizable/);
});

test("malformed shapes are refused", () => {
  assert.match(ERR(manifest(fleet({ i18n: "en" }))), /must be an object/);
  assert.match(ERR(manifest(fleet({ i18n: {} }))), /at least one locale/);
  assert.match(ERR(manifest(fleet({ i18n: { EN: { name: "x" } } }))), /BCP-47/);
  assert.match(ERR(manifest(fleet({ i18n: { en: { unknown: "x" } } }))), /unknown key/);
  assert.match(ERR(manifest(fleet({ i18n: { en: { name: "" } } }))), /non-empty string/);
});

test("projection renders the overlay, per member and per slot, leaving structure alone", () => {
  const mf = manifest(fleet({
    i18n: {
      en: {
        name: "Policy Sentinel Cluster",
        members: { watch: { title: "Watch Post", kpiSlots: { alerts: { label: "Alerts" } } } },
      },
    },
  }));
  const out = projectManifestForLocale(mf, "en");
  assert.equal(out.fleet.name, "Policy Sentinel Cluster");
  assert.equal(out.fleet.members[0].title, "Watch Post");
  assert.equal(out.fleet.members[0].kpiSlots[0].label, "Alerts");
  // Uncovered member falls back to zh, structure is identical.
  assert.equal(out.fleet.members[1].title, "负责人");
  assert.deepEqual(out.fleet.members[0].target, mf.fleet.members[0].target);
  assert.deepEqual(out.fleet.members[0].cadence, mf.fleet.members[0].cadence);
  assert.equal(out.fleet.members[1].parentRef, "watch");
  // The overlay block rides along; the input is never mutated.
  assert.deepEqual(out.fleet.i18n, mf.fleet.i18n);
  assert.equal(mf.fleet.members[0].title, "监视岗");
});

test("uncovered locales fall back to zh (same object)", () => {
  const mf = manifest(fleet({ i18n: { en: { name: "X" } } }));
  assert.equal(projectManifestForLocale(mf, "ja"), mf);
  assert.equal(projectManifestForLocale(mf, "zh"), mf);
});

test("a fleet-only overlay projects without a top-level i18n block", () => {
  const out = projectManifestForLocale(manifest(fleet({ i18n: { en: { name: "X" } } })), "en");
  assert.equal(out.fleet.name, "X");
});