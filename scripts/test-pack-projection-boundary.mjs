// Unit tests — projection IR and the outbound boundary (change
// add-pack-bundle-projection, tasks 1.1–1.3).
// Run: node --test scripts/test-pack-projection-boundary.mjs
//
// The boundary is the whole point of the change, so both directions are pinned:
//   · a legal pack projects to EXACTLY the five IR keys, with capability copied;
//   · control surface (fleet / console), the endpoint-ish keys and billing are
//     refused with their field path, at any depth;
//   · deployment supply decisions (bots / plugins) are dropped, not refused —
//     a pack may declare them and still be legal, it just cannot ship them.
// Plus the compatibility assertion: a range that excludes the baked matrix
// version must refuse, not silently pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IR_KEYS,
  DEFAULT_DSH_COMPAT,
  validateProjectionBoundary,
  projectManifestToIR,
  droppedSections,
  checkDshCompat,
  compareVersions,
} from "../server/pack-projection.js";

function pack(over = {}) {
  return {
    name: "Acme Desk",
    version: 3,
    description: "接收、转派、结案",
    tags: ["crm", "desk"],
    licence: "MIT-0",
    skills: [
      { name: "intake", description: "收单", content: "把客户需求登记到台账" },
      { name: "close", description: "结案", content: "归档并回访" },
    ],
    agents: [
      { id: "lead", name: "主管", persona: "你先分诊，再派单。" },
      { id: "clerk", name: "专员", persona: "按清单核对。", resources: { skills: ["intake"] } },
    ],
    mcpServers: [
      { registryName: "crm", allowTools: ["search", "create"] },
      { registryName: "calendar" },
    ],
    ...over,
  };
}

test("a legal pack projects to exactly the IR keys", () => {
  const ir = projectManifestToIR(pack());
  assert.deepEqual(Object.keys(ir).sort(), [...IR_KEYS].sort(), "no extra key may ride inside the IR");
});

test("capability is copied faithfully and deterministically ordered", () => {
  const ir = projectManifestToIR(pack());
  assert.deepEqual(ir.skills.map((s) => s.name), ["close", "intake"], "skills sorted by name");
  assert.deepEqual(ir.personas.map((p) => p.id), ["clerk", "lead"], "personas sorted by id");
  assert.deepEqual(ir.mcpRefs.map((m) => m.registryName), ["calendar", "crm"]);
  assert.deepEqual(ir.mcpRefs[1].allowTools, ["create", "search"], "tool lists sorted too");
  assert.deepEqual(ir.personas[0].resources, { skills: ["intake"] });
  assert.equal(ir.displayMeta.licence, "MIT-0");
  assert.deepEqual(ir.displayMeta.tags, ["crm", "desk"]);
});

test("CRLF is normalised so a checkout style cannot change the digest", () => {
  const a = projectManifestToIR(pack({ skills: [{ name: "s", content: "line1\nline2" }] }));
  const b = projectManifestToIR(pack({ skills: [{ name: "s", content: "line1\r\nline2" }] }));
  assert.deepEqual(a, b);
});

test("fleet and console are refused with their field path", () => {
  for (const section of ["fleet", "console"]) {
    const errors = validateProjectionBoundary(pack({ [section]: { anything: true } }));
    assert.equal(errors.length, 1, `${section} must be refused`);
    assert.equal(errors[0].code, "projection_forbidden_section");
    assert.equal(errors[0].path, section);
    assert.match(errors[0].error, /never leaves the platform/);
  }
});

test("endpoints and credentials are refused at any depth", () => {
  const cases = [
    { agents: [{ id: "a", name: "A", persona: "p", baseUrl: "https://evil.test" }] },
    { mcpServers: [{ registryName: "crm", headers: { Authorization: "x" } }] },
    { skills: [{ name: "s", content: "c", files: { "run.sh": "x" }, extra: { token: "t" } }] },
  ];
  for (const over of cases) {
    const errors = validateProjectionBoundary(pack(over));
    assert.equal(errors.length, 1, JSON.stringify(over));
    assert.equal(errors[0].code, "projection_forbidden_key");
    assert.ok(/\./.test(errors[0].path), `path should be qualified, got ${errors[0].path}`);
  }
});

test("billing and pricing are refused, bots and plugins are only dropped", () => {
  assert.equal(validateProjectionBoundary(pack({ pricing: { usd: 9 } }))[0].code, "projection_forbidden_section");
  assert.equal(validateProjectionBoundary(pack({ billingKey: "k" }))[0].code, "projection_forbidden_section");

  const manifest = pack({ bots: [{ id: "b1", generic: "wecom" }], plugins: [{ id: "pdf-kit" }] });
  assert.deepEqual(validateProjectionBoundary(manifest), [], "supply declarations are legal packs");
  const ir = projectManifestToIR(manifest);
  assert.deepEqual(droppedSections(manifest).sort(), ["bots", "plugins"], "reported separately, not shipped");
  assert.equal("bots" in ir, false);
  assert.equal("plugins" in ir, false);
});

test("a non-object manifest is refused rather than projected", () => {
  assert.equal(validateProjectionBoundary(null)[0].code, "projection_needs_manifest");
  assert.equal(validateProjectionBoundary([])[0].code, "projection_needs_manifest");
});

test("the compatibility range must contain the baked matrix version", () => {
  assert.deepEqual(checkDshCompat({ matrixVersion: "0.2.0-rc.2" }), { ok: true });
  assert.deepEqual(checkDshCompat({ matrixVersion: "0.2.9" }), { ok: true });

  const below = checkDshCompat({ matrixVersion: "0.1.9" });
  assert.equal(below.ok, false);
  assert.match(below.reason, /below dshCompat/);

  const above = checkDshCompat({ matrixVersion: "0.3.0" });
  assert.equal(above.ok, false);
  assert.match(above.reason, /at or above/);

  // A range we cannot parse, or a missing version, is a refusal — never a pass.
  assert.equal(checkDshCompat({ range: "0.2.x", matrixVersion: "0.2.0-rc.2" }).ok, false);
  assert.equal(checkDshCompat({ matrixVersion: "" }).ok, false);
});

test("prerelease ordering follows semver (rc sorts before the release)", () => {
  assert.equal(compareVersions("0.2.0-rc.2", "0.2.0"), -1);
  assert.equal(compareVersions("0.2.0", "0.2.0-rc.2"), 1);
  assert.equal(compareVersions("0.2.0-rc.2", "0.2.0-rc.2"), 0);
  assert.equal(compareVersions("0.2.0-rc.10", "0.2.0-rc.2"), 1, "numeric-aware compare is not required; string order is documented");
  assert.equal(compareVersions("nope", "0.2.0"), null);
});

test("the repository's matrix version sits inside the default range", () => {
  // Guards the constant: bumping dsh without widening DEFAULT_DSH_COMPAT would
  // make every projection refuse, which is the failure this assertion names.
  assert.equal(checkDshCompat({ range: DEFAULT_DSH_COMPAT, matrixVersion: "0.2.0-rc.2" }).ok, true);
});
