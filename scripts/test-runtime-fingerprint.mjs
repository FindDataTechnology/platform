// Unit tests for the runtime fingerprint (harden-agent-runtime-spine,
// runtime-fingerprint). Pure: no filesystem, no clock.
//
// The two directions are BOTH pinned here, because only having one is how a
// fingerprint silently fails in the other:
//   STABILITY  — comments / key order / whitespace / line endings / path /
//                iteration order must NOT move the digest (false-split noise)
//   SENSITIVITY — skill body / MCP endpoint / allowlist / persona / model must
//                move it (false-merge, the direction that invalidates a
//                comparison)
// Plus: the bundle moves iff a part moves, and diffFingerprintParts names the
// minimal changed part.
//
// Run: node --test scripts/test-runtime-fingerprint.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { computeRuntimeFingerprint, diffFingerprintParts } = await import("../lib/runtime-fingerprint.js");

const base = () => ({
  persona: "You are a careful analyst.\n\nReport findings.",
  skills: [
    { name: "alpha", body: "# Alpha\n\nDo alpha things.\n" },
    { name: "beta", body: "# Beta\n\nDo beta things.\n" },
  ],
  mcpServers: [
    { name: "fd-open-data", url: "https://mcp.example.com/open-data" },
    { name: "playwright", url: "http://127.0.0.1:8931" },
  ],
  toolAllowlist: { "fd-open-data": ["read", "query"], playwright: ["navigate"] },
  model: "deepseek-v4-pro",
  provider: "volces",
  effort: "high",
  matrixVersion: "dsh-0.2.1-rc.3",
});

test("stability: the same configuration twice produces the same bundle", () => {
  const a = computeRuntimeFingerprint(base());
  const b = computeRuntimeFingerprint(base());
  assert.equal(a.bundle, b.bundle);
  assert.deepEqual(a.parts, b.parts);
});

test("stability: line endings, trailing space and iteration order do NOT move it", () => {
  const a = computeRuntimeFingerprint(base());
  const shuffled = base();
  shuffled.skills = [...shuffled.skills].reverse();
  shuffled.mcpServers = [...shuffled.mcpServers].reverse();
  // CRLF + trailing spaces (a Windows checkout, or an editor that added them)
  shuffled.skills = shuffled.skills.map((s) => ({ ...s, body: s.body.replace(/\n/g, "   \r\n") }));
  const b = computeRuntimeFingerprint(shuffled);
  assert.equal(b.bundle, a.bundle, "neither order nor line endings are behaviour");
});

test("stability: reordering KEYS inside the allowlist does NOT move it", () => {
  const a = computeRuntimeFingerprint(base());
  const shuffled = base();
  shuffled.toolAllowlist = { playwright: ["navigate"], "fd-open-data": ["read", "query"] };
  assert.equal(computeRuntimeFingerprint(shuffled).bundle, a.bundle);
});

test("stability: an absent matrix version is a distinct, stable value (not a crash)", () => {
  const cfg = base();
  cfg.matrixVersion = null;
  const a = computeRuntimeFingerprint(cfg);
  const b = computeRuntimeFingerprint(cfg);
  assert.equal(a.bundle, b.bundle);
  assert.equal(a.parts.matrix, null);
  // And it differs from a stated one — "unknown matrix" is not "dsh 0.2.1".
  assert.notEqual(a.bundle, computeRuntimeFingerprint(base()).bundle);
});

test("sensitivity: changing ONE skill body moves the bundle and names exactly that skill", () => {
  const a = computeRuntimeFingerprint(base());
  const cfg = base();
  cfg.skills[1].body = "# Beta\n\nDo beta things DIFFERENTLY.\n";
  const b = computeRuntimeFingerprint(cfg);
  assert.notEqual(b.bundle, a.bundle);
  assert.deepEqual(diffFingerprintParts(a.parts, b.parts), ["skills"]);
  // And the per-skill breakdown says WHICH one (the compare face needs this).
  const changed = a.parts.skills.filter((s, i) => s.sha !== b.parts.skills[i].sha).map((s) => s.name);
  assert.deepEqual(changed, ["beta"]);
});

test("sensitivity: adding a skill moves it; renaming one moves it", () => {
  const a = computeRuntimeFingerprint(base());
  const added = base();
  added.skills.push({ name: "gamma", body: "# Gamma\n" });
  assert.notEqual(computeRuntimeFingerprint(added).bundle, a.bundle);

  const renamed = base();
  renamed.skills[0] = { name: "alpha-2", body: renamed.skills[0].body };
  assert.notEqual(computeRuntimeFingerprint(renamed).bundle, a.bundle);
});

test("sensitivity: an MCP endpoint change moves it even when the name is stable", () => {
  const a = computeRuntimeFingerprint(base());
  const cfg = base();
  cfg.mcpServers[1] = { name: "playwright", url: "http://127.0.0.1:9999" };
  const b = computeRuntimeFingerprint(cfg);
  assert.notEqual(b.bundle, a.bundle);
  assert.deepEqual(diffFingerprintParts(a.parts, b.parts), ["mcp"]);
});

test("sensitivity: narrowing the tool allowlist moves it (behaviour, not formatting)", () => {
  const a = computeRuntimeFingerprint(base());
  const cfg = base();
  cfg.toolAllowlist = { "fd-open-data": ["read"], playwright: ["navigate"] };
  assert.notEqual(computeRuntimeFingerprint(cfg).bundle, a.bundle);
});

test("sensitivity: model / provider / effort / persona / matrix each move it", () => {
  const a = computeRuntimeFingerprint(base());
  for (const [key, value] of [
    ["model", "glm-5.3"],
    ["provider", "ark"],
    ["effort", "low"],
    ["persona", "You are a different analyst."],
    ["matrixVersion", "dsh-0.2.2"],
  ]) {
    const cfg = base();
    cfg[key] = value;
    assert.notEqual(computeRuntimeFingerprint(cfg).bundle, a.bundle, `${key} must move the fingerprint`);
  }
});

test("bundle moves iff a part moves", () => {
  const a = computeRuntimeFingerprint(base());
  const same = computeRuntimeFingerprint(base());
  assert.equal(diffFingerprintParts(a.parts, same.parts).length, 0);
  const cfg = base();
  cfg.matrixVersion = null;
  assert.equal(diffFingerprintParts(a.parts, computeRuntimeFingerprint(cfg).parts).length, 1);
});
