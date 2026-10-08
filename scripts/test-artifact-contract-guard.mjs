// Structural guard for the artifact contract's always-present surfaces
// (openspec: add-artifact-delivery, tasks 1.2 / 1.3 / 1.4 / 5.3).
//
// The contract's acceptance is STRUCTURAL by design (ADR-0009 / design D1):
// prompt teaching is probabilistic at the model layer, so what we assert is
// that the teaching actually exists where the runtime will read it —
//
//   - the baseline skill ships with a description line that names all three
//     hard rules (the catalog line is the only part of a skill the model sees
//     before invoking it; 500-char truncation is the upstream limit)
//   - the remote-fork system message carries the contract line
//   - the sample pack skills no longer steer toward Mermaid
//   - the image build actually copies the baseline skills directory (the
//     add-chart-data-binding incident: a Dockerfile COPY glob silently
//     dropped a static file type)

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("baseline skill description names every hard rule (the catalog line)", () => {
  const skillPath = path.join(repo, "skills", "platform-output-contract", "SKILL.md");
  const text = readFileSync(skillPath, "utf8");
  const m = /^description:\s*(.+)$/m.exec(text);
  assert.ok(m, "frontmatter description line must exist");
  const description = m[1];
  assert.ok(description.length <= 500, `description must fit the 500-char catalog limit (got ${description.length})`);
  for (const keyword of ["echarts", "相对路径", "data:"]) {
    assert.ok(description.includes(keyword), `description must mention "${keyword}"`);
  }
  assert.ok(/资源库/.test(description), "description must name the resource library");
});

test("remote-fork system message carries the contract line", () => {
  const source = readFileSync(path.join(repo, "server", "agent-session.js"), "utf8");
  // The message is one template-literal line; the contract keywords ride the
  // same line as the identity message (escaped backticks would defeat a
  // backtick-delimited capture, so match by line).
  const line = source.split("\n").find((l) => l.includes("平台产物契约"));
  assert.ok(line, "fork system message must carry the contract line");
  assert.ok(line.includes('role: "system"'), "the contract must ride the fork's system message");
  for (const keyword of ["echarts", "相对路径", "data:"]) {
    assert.ok(line.includes(keyword), `fork system message must mention "${keyword}"`);
  }
});

test("sample pack skills no longer steer toward Mermaid", (t) => {
  // The open-source snapshot omits the internal demo packs — the guard is a
  // no-op there (explicit skip, not a vacuous pass).
  const packsRoot = path.join(repo, "docs", "vertical-packs", "skills");
  if (!existsSync(packsRoot)) return t.skip("vertical-packs demo material not present (open-source snapshot)");
  for (const skill of ["china-macro-brief-workflow", "legal-case-workflow"]) {
    const p = path.join(packsRoot, skill, "SKILL.md");
    const text = readFileSync(p, "utf8");
    assert.ok(!/[Mm]ermaid/.test(text), `${skill} must not mention Mermaid`);
    assert.ok(text.includes("echarts"), `${skill} must reference the echarts contract`);
  }
});

test("the image build copies the baseline skills directory", () => {
  const f = path.join(repo, "Dockerfile");
  const text = readFileSync(f, "utf8");
  // The runtime stage must copy skills/ as a DIRECTORY — the whole tree, so a
  // new SKILL.md ships without touching the Dockerfile. A file-type glob
  // (`skills/*.js`) is exactly the add-chart-data-binding incident shape.
  assert.match(text, /COPY[^\n]*\/app\/skills\s+\.\/skills/, "runtime stage must COPY the skills/ directory");
  assert.doesNotMatch(text, /COPY[^\n]*skills\/\*\.[\w]+/, "skills must not be copied via an extension glob");
  // And nothing may silently exclude it from the build context.
  const ignore = readFileSync(path.join(repo, ".dockerignore"), "utf8");
  assert.ok(
    !ignore.split("\n").some((line) => line.trim() === "skills" || line.trim().startsWith("skills/")),
    ".dockerignore must not exclude the skills tree",
  );
});

test("the platform-output-contract skill file would ship in the image context", () => {
  // The guard runs in the repo; the COPY assertion above proves the directory
  // rides along, and this pins the file's presence + parseable frontmatter.
  const skillPath = path.join(repo, "skills", "platform-output-contract", "SKILL.md");
  const text = readFileSync(skillPath, "utf8");
  assert.ok(/^---\n/.test(text), "frontmatter must open the file");
  assert.ok(/^name: platform-output-contract$/m.test(text), "skill name must be stable");
});
