// Validator-purity guard (add-mixed-fleet-packs, task 1.1 / design D3).
//
// server/fleet-orchestration.js must stay a PURE leaf module — no imports at
// all, no task-engine module anywhere in its (empty) dependency graph. The
// whole template-orchestration design hangs on this: gateway/packs.js imports
// fleet-template.js, which imports the validator; one impure edge and the
// gateway process drags the task engine in. Two pins:
//   1. static — the source itself carries ZERO import statements (and
//      fleet-template.js's import face stays within the gateway-safe
//      whitelist: cron-parser + the pure validator)
//   2. dynamic — the module imports and runs STANDALONE in a bare subprocess
//      (no engine env, no init), proving "pure validation + read-time
//      expansion" is not just a static accident
//
// Run: node --test scripts/test-fleet-orchestration-purity.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const orchestrationSrc = fs.readFileSync(path.join(repoRoot, "server/fleet-orchestration.js"), "utf8");
const templateSrc = fs.readFileSync(path.join(repoRoot, "server/fleet-template.js"), "utf8");

// Every import form an ESM file can carry, line-bounded so a stray word in a
// comment or a multi-line export can never masquerade as one.
const IMPORT_RE = /^\s*(import\s|import\(|export\s+[^\n;]*\bfrom\s)/m;

test("purity: server/fleet-orchestration.js imports NOTHING (pure leaf module)", () => {
  assert.equal(
    IMPORT_RE.test(orchestrationSrc),
    false,
    "server/fleet-orchestration.js grew an import — the validator must stay a zero-import pure module; " +
      "move side-effecting code elsewhere and re-export, never import the engine (design D3)",
  );
});

test("purity: fleet-template.js's import face stays gateway-safe (no task-engine graph)", () => {
  const imports = [...templateSrc.matchAll(/^\s*import\s+(?:[\s\S]*?from\s+)?["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0, "sanity: the parser does import something (cron-parser at least)");
  const ALLOWED = new Set(["cron-parser", "./fleet-orchestration.js"]);
  for (const spec of imports) {
    assert.ok(
      ALLOWED.has(spec),
      `fleet-template.js imports '${spec}' — it is loaded by the GATEWAY process; only ${[...ALLOWED].join(", ")} are safe`,
    );
  }
});

test("purity: the validator loads and runs STANDALONE in a bare subprocess", () => {
  // No DB_PATH, no engine init, no cron storage — a module with hidden
  // side-effect imports cannot survive this.
  const probe = `
    const m = await import(${JSON.stringify(path.join(repoRoot, "server/fleet-orchestration.js"))});
    const out = m.validateOrchestration({
      members: [{ id: "a", targetKind: "persona" }, { id: "b", targetKind: "persona" }],
      orchestration: { mode: "pipeline", edges: [
        { kind: "trigger", to: "a", cron: "0 9 * * *" },
        { kind: "handoff", from: "a", to: "b" },
      ] },
    });
    if (!out.ok || out.edges.length !== 2) throw new Error("validator misbehaved: " + JSON.stringify(out));
  `;
  const stdout = execFileSync(
    process.execPath,
    ["--no-warnings", "--input-type=module", "-e", probe],
    { encoding: "utf8", env: { ...process.env, DB_PATH: "", CRON_STORAGE_PATH: "" } },
  );
  assert.equal(stdout, "", "a pure module must print nothing on import");
});
