import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { applyDeploymentSecrets } from "../compose.js";

// Regression guard for the 2026-10-12 credential-leak incident: a long secret
// written as a YAML block scalar (`git_pat: >-` + value on the next line) is
// invisible to the shell one-liners skills use to read it — the reader returns
// an empty string and (as happened) the skill falls back to printing the raw
// file. The credentials store MUST therefore keep every scalar on one line.
const LONG_SECRET = "github_pat_" + "A".repeat(80);

function seedHome() {
  const home = mkdtempSync(path.join(tmpdir(), "cred-home-"));
  writeFileSync(
    path.join(home, ".credentials.yaml"),
    "version: 1\nrefs:\n  gh_actor: someone@example.com\n",
    { mode: 0o600 },
  );
  return home;
}

test("deployment secrets are written as single-line scalars (no block scalar)", () => {
  const home = seedHome();
  applyDeploymentSecrets(home, { git_pat: LONG_SECRET });

  const raw = readFileSync(path.join(home, ".credentials.yaml"), "utf8");
  assert.doesNotMatch(raw, /git_pat:\s*>-/, "git_pat must not be a folded block scalar");
  assert.doesNotMatch(raw, /git_pat:\s*\|/, "git_pat must not be a literal block scalar");
  assert.match(raw, /git_pat:\s*\S/, "git_pat value must sit on the key's own line");
});

test("a shell one-liner can read the secret back (the property skills rely on)", () => {
  const home = seedHome();
  applyDeploymentSecrets(home, { git_pat: LONG_SECRET });

  const raw = readFileSync(path.join(home, ".credentials.yaml"), "utf8");
  // The shape a skill actually uses: single-line grep+sed, no YAML parser.
  const line = raw.split("\n").find((l) => /^\s*git_pat:/.test(l));
  assert.ok(line, "git_pat line must exist");
  const value = line.replace(/^\s*git_pat:\s*/, "").trim().replace(/^["']|["']$/g, "");
  assert.equal(value, LONG_SECRET, "single-line reader must recover the full value");
});

test("existing refs survive and short values are unaffected", () => {
  const home = seedHome();
  applyDeploymentSecrets(home, { git_pat: LONG_SECRET, gh_actor: "bot@example.com" });

  const raw = readFileSync(path.join(home, ".credentials.yaml"), "utf8");
  // Values may be quoted (the platform writes them quoted so both writers of
  // this file agree on the shape); the invariant asserted here is ONE LINE.
  const line = raw.split("\n").find((l) => /^\s*gh_actor:/.test(l));
  assert.ok(line, "gh_actor line must exist");
  assert.equal(
    line.replace(/^\s*gh_actor:\s*/, "").trim().replace(/^["']|["']$/g, ""),
    "bot@example.com",
    "ref update lands on one line",
  );
});
