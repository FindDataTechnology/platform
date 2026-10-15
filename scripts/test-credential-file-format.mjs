// Regression self-check for the child credentials file scalar format
// (dsh-profile.js → ensureCredentialsStore).
//
// Why this exists: a long credential was written as a folded block scalar
// (`git_pat: >-` with the value indented on the following line) because js-yaml
// folds past lineWidth. A skill doing line-oriented extraction (grep+sed) then
// read an empty string and, to debug, printed the file — leaking the full PAT
// into its transcript (2026-10-12). The invariant pinned here: every value is
// a single-line quoted scalar, so any line-oriented reader gets the full value
// without knowing YAML block syntax.
//
// Runs against a temp DSH_HOME/dirs so the developer's real ~/.dsh is never
// written. `lineWidth: -1` is the load-bearing part — 0 does NOT disable
// folding in js-yaml (it means "stay within zero columns"), the default 80 is
// what folded in the first place.
//
// Run: node scripts/test-credential-file-format.mjs

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";

// Shape taken from the live incident: a 93-char GitHub PAT and a 71-char sk-*
// key in the same file. The PAT folded at lineWidth 80, the sk-* did not.
const GH_PAT = `github_pat_${"A".repeat(70)}4h1H7zNX`;
const SK_KEY = `sk-${"b".repeat(69)}`;
const GH_ACTOR = "295187081+FindDataOfficial@users.noreply.github.com";

const root = mkdtempSync(path.join(tmpdir(), "credential-format-"));
const home = path.join(root, "home");
const profileDir = path.join(home, "custom-profile");

// Environment-independence (2026-10-14): the rewrite under test is gated on
// "some ref changed" — a developer's machine that happens to carry a populated
// llm-providers.json (a user provider key) flips that gate and makes this test
// pass for the wrong reason, while a clean CI checkout has no such ref and
// took the no-rewrite branch. Point the provider store at an empty file inside
// the temp root so the outcome never depends on the host's state — the case
// then exercises exactly what it claims: a FOLDED file must self-heal.
const emptyProviders = path.join(root, "llm-providers.json");
writeFileSync(emptyProviders, JSON.stringify({ providers: [] }));
process.env.LLM_PROVIDERS_STORE = emptyProviders;

let cases = 0;
const pass = (label) => { cases += 1; console.log(`ok - ${label}`); };

async function main() {
  const { ensureCredentialsStore } = await import("../dsh-profile.js");
  const credentialsPath = path.join(profileDir, ".credentials.yaml");  // matches targetPaths()

  const savedEnv = { ...process.env };
  process.env.DSH_HOME = profileDir;
  process.env.LLM_API_KEY = SK_KEY;
  delete process.env.gh_actor;
  delete process.env.git_pat;
  try {
    await ensureCredentialsStore({ dirs: { dshHome: profileDir } });
    assert.ok(existsSync(credentialsPath), "credentials file written");

    const text = readFileSync(credentialsPath, "utf8");
    const lines = text.split("\n");

    // 1. No folded/literal block scalars anywhere in the file.
    assert.ok(!/:\s*[>|][-+]?\s*$/m.test(text), "no block scalars in credentials file");
    pass("no block scalars written");

    // 2. Every ref value sits on the key's own line and round-trips byte-exact.
    const doc = yaml.load(text);
    assert.equal(doc.refs.LLM_API_KEY, SK_KEY, "short key round-trips");
    const keyLine = lines.find((l) => l.startsWith("  LLM_API_KEY:"));
    assert.ok(keyLine && keyLine.includes(SK_KEY), "short key value is on its own line");
    assert.ok(keyLine.trimStart().startsWith("LLM_API_KEY: '"), "value is quoted");
    pass("short key is single-line and quoted");

    // 3. The incident case: write a long PAT and assert it does NOT fold.
    writeFileSync(
      credentialsPath,
      yaml.dump({ version: 1, refs: { LLM_API_KEY: SK_KEY, gh_actor: GH_ACTOR, git_pat: GH_PAT } }),
    );
    await ensureCredentialsStore({ dirs: { dshHome: profileDir } });
    const longText = readFileSync(credentialsPath, "utf8");
    assert.ok(
      !/:\s*[>|][-+]?\s*$/m.test(longText),
      "long PAT did not produce a block scalar after rewrite",
    );
    const patLines = longText.split("\n").filter((l) => l.includes("git_pat") || /^ {4}/.test(l));
    assert.equal(patLines.length, 1, "git_pat occupies exactly one line");
    pass("93-char PAT stays on one line (incident case)");

    // 4. Line-oriented extraction gets the FULL value — the skill's failure mode.
    const sed = execFileSync("sh", ["-c", `sed -n 's/^  git_pat: *//p' "${credentialsPath}" | tr -d "'"`], { encoding: "utf8" }).trim();
    assert.equal(sed, GH_PAT, "grep+sed line extraction yields the complete PAT");
    pass("single-line grep+sed extraction returns the full value");

    // 5. Semantics unchanged: quoted scalar parses identically to the old folded form.
    const folded = yaml.dump({ version: 1, refs: { git_pat: GH_PAT } });
    const foldedLoaded = yaml.load(folded).refs.git_pat;
    const newLoaded = yaml.load(longText).refs.git_pat;
    assert.equal(newLoaded, GH_PAT, "new format parses to the original value");
    assert.equal(newLoaded, foldedLoaded, "new format is semantically identical to block scalar");
    pass("value semantics identical to the old folded format");

    // 6. Value with a trailing/leading edge and odd chars still survives intact.
    const oddActor = `${GH_ACTOR}`;
    assert.equal(yaml.load(longText).refs.gh_actor, oddActor, "actor round-trips");
    pass("gh_actor round-trips unchanged");
  } finally {
    process.env = savedEnv;
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`credential file format: ${cases}/${cases} cases pass`);
}

await main();
