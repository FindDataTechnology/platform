// CI mount for scripts/check-memory-vocabulary-parity.mjs.
//
// `npm run test:unit` globs `scripts/test-*.mjs`, so a gate named `check-*.mjs`
// runs for nobody: it would be the eighth instance of "declared, never mounted"
// in this workspace. This file is the mount — a divergence between the three
// implementations now fails the unit lane, not just an operator who remembers to
// type the right command.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

test("the three memory-declaration implementations agree", (t) => {
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [join(HERE, "check-memory-vocabulary-parity.mjs")], {
      encoding: "utf8",
    });
  } catch (e) {
    const report = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    // "The sibling repo is not on this machine" is not a divergence, and a red
    // that claims otherwise costs a CI round every time. A single-repo CI
    // checkout cannot import fd-agent-graph at all — the first sharded run
    // reported `ModuleNotFoundError: No module named 'fd_agent_graph'` while a
    // dev machine where it IS importable passed. Skip on EXACTLY that cause;
    // every other failure stays red, because then the implementations really do
    // disagree.
    if (/No module named ['"]fd_agent_graph['"]/.test(report)) {
      t.skip("fd-agent-graph not importable here — nothing to compare against");
      return;
    }
    // Print the gate's own report: "it failed" without the divergences is the
    // error message that wastes the next person's hour.
    assert.fail(`parity gate failed:\n${report}`);
  }
  assert.match(stdout, /three implementations agree/);
});
