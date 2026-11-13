// ── State witness (diagnostic reporter, 2026-11-13) ──────────────────────────
//
// The fast e2e lane shares ONE server, one dsh home and one SQLite store across
// every spec file, so a spec that mutates extension/profile state leaks it into
// whatever runs next. That coupling is real and documented (websearch:223
// receives an empty patch after some other file ran), but WHICH file drops it
// has only ever been guessed by reading the 15 specs that touch
// /api/extensions/mcp.
//
// This reporter answers it with evidence: before and after every test file it
// snapshots (a) the MCP extension rows from the running server and (b) the
// composed patch's serverName set, then prints the transition with the file
// name. Use it on a subset:
//
//   npx playwright test e2e/a.spec.js e2e/b.spec.js --reporter=line,./e2e/state-witness.js
//
// It never fails a run and never asserts — it is an observability tool, so it
// is safe to leave in the reporter chain while chasing a flake. Turn the
// output into a fix, then delete the file from KNOWN_FLAKY.

import fs from "node:fs";
import path from "node:path";
import { baseURL, tempStoreDirs } from "./helpers.js";

const PATCH = path.join(
  tempStoreDirs().dshHome,
  "profiles",
  process.env.DSH_PROFILE || "platform",
  "mcp.patch.yml",
);

// serverName set out of the composed patch — regex, not a YAML parse: the
// patch is written by a fire-and-forget writer, so it is read mid-write often
// enough that a strict parse would throw exactly when the state is interesting.
function patchServers() {
  try {
    const text = fs.readFileSync(PATCH, "utf8");
    return [...text.matchAll(/serverName:\s*([A-Za-z0-9._-]+)/g)].map((m) => m[1]).sort();
  } catch {
    return null; // no patch yet (first write) or wiped store
  }
}

async function extensionRows() {
  try {
    const res = await fetch(`${baseURL}/api/extensions/mcp`);
    if (!res.ok) return `HTTP ${res.status}`;
    const { servers } = await res.json();
    return (servers ?? [])
      .map((s) => `${s.name}:${s.origin}:${s.enabled ? "on" : "off"}`)
      .sort()
      .join(",");
  } catch (err) {
    return `unreachable (${err.message})`;
  }
}

class StateWitness {
  constructor() {
    this.before = null;
    this.current = null;
  }

  onBegin() {
    this.snapshot = null;
  }

  async onTestBegin(test) {
    // First test of a file: take the "before" reading once, keyed by file.
    const file = test.location?.file ?? "(unknown)";
    if (this.current !== file) {
      this.current = file;
      this.before = { rows: await extensionRows(), patch: patchServers() };
    }
  }

  async onTestEnd(test, result) {
    const file = test.location?.file ?? "(unknown)";
    const after = { rows: await extensionRows(), patch: patchServers() };
    const changed = [];
    if (this.before.rows !== after.rows) changed.push(`rows ${this.before.rows} → ${after.rows}`);
    if (JSON.stringify(this.before.patch) !== JSON.stringify(after.patch)) {
      changed.push(`patch [${(this.before.patch ?? []).join(",")}] → [${(after.patch ?? []).join(",")}]`);
    }
    const tag = result.status === "passed" ? " " : "✗";
    if (changed.length) console.log(`${tag} STATE ${file} · ${test.title}\n    ${changed.join("\n    ")}`);
    this.before = after; // next test in the same file compares from here
  }

  onEnd() {
    console.log("state-witness: done (no assertions — this reporter only reports)");
  }
}

export default StateWitness;
