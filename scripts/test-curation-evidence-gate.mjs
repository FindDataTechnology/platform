// Unit tests — the curation-evidence gate (change add-curation-evidence-gate,
// tasks 3.1 / 3.2 / 3.3).
// Run: node --test scripts/test-curation-evidence-gate.mjs
//
// The gate is the last thing between an unreviewed plugin and a shipped image,
// so each case is a way it must be able to say NO:
//   · a supplied entry missing one field → exit 1, entry and field both named;
//   · an expired entry → exit 1 asking for re-review, not "probably fine";
//   · blocking is the default (predist, Dockerfile, CI all run without a flag);
//     `--warn` survives only as a deliberate escapement and still prints;
//   · an absent catalogue → exit 0 (honest empty, not a failure to build);
//   · `--candidate` → validates a PROPOSED file and never writes it (this is the
//     "上架" act for a file-based catalogue).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { suppliedBundleIds, judgeCatalogue } from "../scripts/check-curation-evidence.mjs";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = mkdtempSync(path.join(tmpdir(), "curation-gate-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function evidence(over = {}) {
  return {
    axes: {
      security: { verdict: "pass", reason: "只读" },
      licence: { verdict: "pass", reason: "MIT-0" },
      quality: { verdict: "pass", reason: "有用例" },
      P1: { verdict: "pass", reason: "供给面只读" },
      P2: { verdict: "pass", reason: "无运行期下载" },
    },
    pin: { repo: "github.com/acme/x", tag: "v1.0.0" },
    licence: "MIT-0",
    egress: "none",
    reviewedBy: "ops@acme",
    reviewedAt: "2026-11-01",
    ...over,
  };
}

/** A fixture root with the two files the gate reads. */
function root({ plugins, supplied = ["pdf-kit"] }) {
  const dir = mkdtempSync(path.join(tmp, "root-"));
  mkdirSync(path.join(dir, "packs"), { recursive: true });
  mkdirSync(path.join(dir, "dsh-matrix"), { recursive: true });
  mkdirSync(path.join(dir, "dsh-profile-template"), { recursive: true });
  writeFileSync(path.join(dir, "packs", "plugin-catalog.json"), `${JSON.stringify({ version: 2, plugins }, null, 2)}\n`);
  writeFileSync(
    path.join(dir, "dsh-matrix", "plugin-supply.json"),
    `${JSON.stringify({ bundles: supplied.map((name) => ({ name, contributes: ["service"] })) }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(dir, "dsh-profile-template", "package.json"),
    `${JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }, null, 2)}\n`,
  );
  return dir;
}

function gate(dir, ...args) {
  return spawnSync(process.execPath, [path.join(REPO, "scripts/check-curation-evidence.mjs"), "--root", dir, ...args], {
    encoding: "utf8",
  });
}

test("a complete supplied entry passes", () => {
  const dir = root({ plugins: [{ id: "pdf-kit", species: "plugin", evidence: evidence() }] });
  const res = gate(dir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /clean — 1 supplied entry\(ies\)/);
});

test("a supplied entry missing egress fails and names the field (3.1)", () => {
  const { egress, ...withoutEgress } = evidence();
  const dir = root({ plugins: [{ id: "pdf-kit", species: "plugin", evidence: withoutEgress }] });
  const res = gate(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /pdf-kit \(missing\)/);
  assert.match(res.stderr, /evidence\.egress/);
  assert.match(res.stderr, /fix: add the missing evidence fields/);
});

test("an expired entry asks for re-review instead of passing (3.1)", () => {
  const dir = root({ plugins: [{ id: "pdf-kit", species: "plugin", evidence: evidence({ reviewValidUntil: "2020-01-01" }) }] });
  const res = gate(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /pdf-kit \(stale\)/);
  assert.match(res.stderr, /re-review/);
});

test("blocking is the default and --warn remains an explicit escapement", () => {
  const dir = root({ plugins: [{ id: "pdf-kit", species: "plugin" }] });
  const blocked = gate(dir);
  assert.equal(blocked.status, 1, "blocking mode is the default — every call site runs without the flag");
  const warned = gate(dir, "--warn");
  assert.equal(warned.status, 0);
  assert.match(warned.stderr, /WARN \(--warn escapement, not blocking\)/);
  assert.match(warned.stderr, /pdf-kit/);
});

test("an unsupplied entry is not judged unless --all", () => {
  const dir = root({
    plugins: [{ id: "unreviewed-extra", species: "plugin" }],
    supplied: ["pdf-kit"],
  });
  assert.equal(gate(dir).status, 0, "not supplied ⇒ not our concern this round");
  const all = gate(dir, "--all");
  assert.equal(all.status, 1);
  assert.match(all.stderr, /unreviewed-extra/);
});

test("an absent catalogue is an honest empty tree, not a failure", () => {
  const dir = root({ plugins: [] });
  rmSync(path.join(dir, "packs", "plugin-catalog.json"));
  const res = gate(dir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /no plugin catalogue in this tree/);
});

test("--candidate validates a proposed file and leaves it byte-identical (3.3)", () => {
  const dir = root({ plugins: [{ id: "pdf-kit", species: "plugin", evidence: evidence() }] });
  const candidate = path.join(dir, "proposed.json");
  const text = `${JSON.stringify({ version: 2, plugins: [{ id: "pdf-kit", species: "plugin" }] }, null, 2)}\n`;
  writeFileSync(candidate, text);
  const res = gate(dir, "--candidate", candidate);
  assert.equal(res.status, 1, "an unreviewed candidate must not be accepted");
  assert.match(res.stderr, /pdf-kit/);
  assert.equal(readFileSync(candidate, "utf8"), text, "the gate never writes");
});

test("the supplied set is the non-upstream union of both declarations", () => {
  const dir = root({ plugins: [], supplied: ["@acme/a", "@deepseek-ai/dsh-base"] });
  const ids = suppliedBundleIds(dir);
  assert.deepEqual([...ids].sort(), ["@acme/a"], "upstream runtime bundles are not curation subjects");
});

test("the judge reports the state alongside the problems", () => {
  const problems = judgeCatalogue({
    plugins: [
      { id: "ok", species: "plugin", evidence: evidence() },
      { id: "bare", species: "plugin" },
    ],
    supplied: new Set(["ok", "bare"]),
    today: "2026-11-12",
  });
  assert.deepEqual(problems.map((p) => `${p.entry}:${p.state}`), ["bare:missing"]);
});
