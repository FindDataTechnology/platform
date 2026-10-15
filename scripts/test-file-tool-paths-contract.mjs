// Contract test: the server-side mirror of the produced-file rule
// (server/file-tool-paths-server.js) MUST agree with the single-home TS rule
// (packages/core/src/lib/file-tool-paths.ts) on every corpus vector.
//
// openspec: wire-produced-files-to-outputs — design decision (b): the server
// ships without the packages tree, so the capture path runs a mirrored copy;
// this corpus is the gate that keeps the mirror honest. Adding a case here
// without updating both implementations fails; changing the core rule without
// the mirror fails. Node ≥23.6 strips the TS import natively.

import assert from "node:assert/strict";
import { test } from "node:test";

const { producedFilePaths: coreRule } = await import(
  "../packages/core/src/lib/file-tool-paths.ts"
);
const { producedFilePaths: serverRule } = await import("../server/file-tool-paths-server.js");

// The corpus: every behavior class the rule owns — writer shapes, reader
// shapes, shell verbs, redirects, multi-line, heredocs (complete, unterminated,
// quoted/plain delimiters, multiple), script runners, prefixes, dedupe, cap.
const CORPUS = [
  ["write", { file_path: "docs/a.md", content: "hi" }],
  ["write", { file_path: "docs/a.md" }],
  ["edit", { file_path: "docs/a.md", old_string: "a", new_string: "b" }],
  ["read", { file_path: "docs/a.md" }],
  ["glob", { pattern: "**/*.md" }],
  ["grep", { pattern: "x", path: "docs" }],
  ["bash", { command: "ls -la" }],
  ["bash", { command: "zip -r bundle.zip src/" }],
  ["bash", { command: "tar -czf release.tar.gz dist/" }],
  ["bash", { command: "echo hi > result.md" }],
  ["bash", { command: "cmd > /dev/null 2>&1" }],
  ["bash", { command: "find . | sort > /tmp/doclist.txt\ntar -czf workspace-docs.tar.gz -T /tmp/doclist.txt" }],
  ["bash", { command: "python3 - <<'EOF'\nout = 'markdown-docs.zip'\nprint('x -> y', out)\nEOF\nls" }],
  ["bash", { command: "python3 - <<'EOF\nprint('a.zip')" }],
  ["bash", { command: "python3 - <<EOF\nx = 'a.zip'" }],
  ["bash", { command: "python3 - <<\"EOF\"\nout = 'b.tar.gz'\nEOF" }],
  ["bash", { command: "python3 - <<'A'\nv='x.zip'\nA\npython3 - <<'B'\nw='y.tar.gz'\nB" }],
  ["bash", { command: "python3 - <<'EOF'\nprint('no archives here')\nEOF" }],
  ["bash", { command: "python3 -c \"open('data.csv').read()\"" }],
  ["bash", { command: "python3 -c \"import zipfile;z=zipfile.ZipFile('a.zip','w');z.writestr('h.txt','x');z.close()\"" }],
  ["bash", { command: "python3 -c \"print('nothing; here')\"" }],
  ["bash", { command: "echo \"a;b\" > out.txt" }],
  ["bash", { command: "grep -c \"a > b\" file.txt" }],
  ["bash", { command: "tar -czf 'my archive.tar.gz' docs/" }],
  ["bash", { command: "echo \"unterminated > out.txt" }],
  ["bash", { command: "node -e \"write('bundle.zip')\"" }],
  ["bash", { command: "sudo python3 makezip.py output.tar.gz" }],
  ["bash", { command: "cd out && zip -q ../bundle.zip *" }],
  ["bash", { command: "git status && git diff" }],
  ["bash", { command: "curl -s https://x.example/data.json" }],
  ["str_replace_editor", { command: "create", path: "a.md", file_text: "x" }],
  ["str_replace_editor", { command: "view", path: "a.md" }],
  ["Write", { file_path: "x.txt", content: "1" }],
  ["write_file", { path: "y.txt", contents: "1" }],
  ["bash", { command: "mkdir -p p && echo a > p/f.txt && cp p/f.txt g.txt" }],
  ["bash", { command: Array.from({ length: 25 }, (_, i) => `f${i}.zip`).join(" ") + " | zip all.zip -@" }],
];

test("server mirror agrees with the core rule on the whole corpus", () => {
  for (const [name, args] of CORPUS) {
    const fromCore = coreRule(name, args);
    const fromServer = serverRule(name, args);
    assert.deepEqual(
      fromServer,
      fromCore,
      `mirror drift on ${name} ${JSON.stringify(args).slice(0, 80)}: core=${JSON.stringify(fromCore)} server=${JSON.stringify(fromServer)}`
    );
  }
});
