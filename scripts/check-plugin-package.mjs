#!/usr/bin/env node
// scripts/check-plugin-package.mjs — does this directory satisfy the package
// contract? (openspec: add-pack-raven-export, task 4.1/4.2)
//
// Deliberately NOT sharing code with the exporter. If the self-check reused the
// generator's own predicates, a mistake in the generator would be blessed by the
// checker that is supposed to catch it — "verify the broken thing itself, not its
// neighbour". This file re-derives everything from the directory on disk:
//
//   · plugin.json exists, parses, and carries name/version/skills;
//   · every skill entry has a matching skills/<name>/SKILL.md, and nothing else
//     lives under skills/;
//   · no executable entry (script extension, shebang, or an executable bit);
//   · mcp.json parses, and every server it names is `<package>__<something>`;
//   · NOT-PROJECTED.md exists and names every entry plugin.json claims.
//
//   node scripts/check-plugin-package.mjs <dir>
//   exit 0 = pass, 1 = at least one violation, 2 = usage / unreadable input.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SCRIPT_EXTENSIONS = new Set([
  "py", "sh", "bash", "zsh", "js", "mjs", "cjs", "ts", "rb", "pl", "ps1", "bat", "cmd",
]);

const problems = [];
const note = (message) => problems.push(message);

const target = process.argv[2];
if (!target) {
  process.stderr.write("usage: check-plugin-package.mjs <dir>\n");
  process.exit(2);
}
const root = path.resolve(target);

function readJson(file) {
  try {
    return JSON.parse(readFileSync(path.join(root, file), "utf8"));
  } catch (err) {
    note(`${file}: cannot read or parse (${err.message})`);
    return null;
  }
}

function walk(dir, rel = "") {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    note(`${rel || "."}: cannot list (${err.message})`);
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), childRel));
    else out.push(childRel);
  }
  return out;
}

const plugin = readJson("plugin.json");
const files = walk(root);

// ── shape ────────────────────────────────────────────────────────────────
if (plugin) {
  // `skills` is conditionally required: a package may legitimately carry none, and
  // declaring a path to a directory that does not exist is worse than omitting it
  // ("only declare real resources"). What must always hold is that the declaration
  // and the disk agree — checked below in both directions.
  for (const field of ["name", "version"]) {
    if (plugin[field] === undefined) note(`plugin.json: missing required field '${field}'`);
  }
  if (plugin.name !== undefined && (typeof plugin.name !== "string" || !plugin.name.trim())) {
    note("plugin.json: name must be a non-empty string");
  }
  // The path form, asserted rather than assumed: a manifest that declared skills
  // as an inline array would be rejected by any schema-validated loader, and this
  // is the only place that would notice before a host does.
  if (plugin.skills !== undefined && typeof plugin.skills !== "string") {
    note("plugin.json: skills must be a path string (e.g. \"./skills\"), not an array");
  }
  if (typeof plugin.skills === "string" && !files.some((f) => f.startsWith("skills/"))) {
    note(`plugin.json: declares skills at '${plugin.skills}' but no skills/ directory exists`);
  }
}

// ── skill directories ↔ declared skills ──────────────────────────────────
// The inventory lives in the extension block, because the path form does not spell
// it out. Without it this check would have to trust the directory listing alone and
// could no longer tell "a skill went missing" from "a skill was never declared".
const declared = Array.isArray(plugin?.["x-finddata"]?.skills) ? plugin["x-finddata"].skills : [];
const declaredNames = declared.map((s) => s?.name).filter((n) => typeof n === "string");
if (declaredNames.length === 0 && files.some((f) => f.startsWith("skills/"))) {
  note("x-finddata.skills: empty, but skills/ contains entries — the inventory must describe them");
}
const onDisk = files
  .filter((f) => f.startsWith("skills/") && f.endsWith("/SKILL.md"))
  .map((f) => f.slice("skills/".length, -"/SKILL.md".length));

for (const name of declaredNames) {
  if (!onDisk.includes(name)) note(`skills/${name}/SKILL.md: declared in x-finddata.skills but missing on disk`);
}
for (const name of onDisk) {
  if (!declaredNames.includes(name)) note(`skills/${name}/SKILL.md: on disk but not declared in x-finddata.skills`);
}
for (const stray of files.filter(
  (f) => f.startsWith("skills/") && !f.includes("/SKILL.md") && f.split("/").length === 2,
)) {
  note(`${stray}: a file directly under skills/ belongs to no skill`);
}

// ── no package-level executable entry ────────────────────────────────────
// A script under `skills/<name>/` is a skill asset: the platform's own script set
// exists for the install report's DISCLOSURE, not for rejection, and refusing it
// would refuse legal packs. Everywhere else a script file has no meaning in a
// data-only package — there it is an entry point by position.
const skillScripts = [];
for (const rel of files) {
  const ext = rel.includes(".") ? rel.split(".").pop().toLowerCase() : "";
  if (SCRIPT_EXTENSIONS.has(ext)) {
    if (rel.startsWith("skills/")) skillScripts.push(rel);
    else note(`${rel}: executable entry ('.${ext}') outside skills/ — the format is data-only`);
    continue;
  }
  const absolute = path.join(root, rel);
  try {
    if (statSync(absolute).mode & 0o111) note(`${rel}: file carries an executable bit`);
  } catch (err) {
    note(`${rel}: cannot stat (${err.message})`);
  }
  if (!ext) {
    try {
      if (readFileSync(absolute, "utf8").slice(0, 2) === "#!") {
        note(`${rel}: starts with a shebang — treated as a script`);
      }
    } catch {
      /* binary or unreadable as text: nothing to sniff */
    }
  }
}

// Disclosure both ways: every script asset is listed, and the list names nothing
// that is not there. A list that only grew would stop describing the package.
const disclosed = plugin?.["x-finddata"]?.scriptFiles ?? [];
for (const rel of skillScripts) {
  if (!disclosed.includes(rel)) note(`${rel}: script asset not disclosed in x-finddata.scriptFiles`);
}
for (const rel of disclosed) {
  if (!skillScripts.includes(rel)) note(`x-finddata.scriptFiles: '${rel}' is listed but not present`);
}

// ── mcp.json naming ──────────────────────────────────────────────────────
// Optional, but the pointer and the file must agree: a package that declares
// `mcpServers: "./mcp.json"` and does not carry it is a load failure, and a file
// nothing declares would never be read.
const declaresMcp = typeof plugin?.mcpServers === "string";
const hasMcpFile = files.includes("mcp.json");
if (declaresMcp && !hasMcpFile) note(`plugin.json points at '${plugin.mcpServers}' but the file is absent`);
if (!declaresMcp && hasMcpFile) note("mcp.json is present but plugin.json does not declare mcpServers");
const mcp = hasMcpFile ? readJson("mcp.json") : null;
// The package's own id, re-derived from the directory rather than trusted from
// the extension block: `plugin.json.name` is what a loader sees.
const packageId = typeof plugin?.name === "string" ? plugin.name : "";
// 2026-11-15: the extension block also records the id. Two places, one fact —
// so they must agree. They did agree by construction until the exporter was
// changed to take an explicit `--pack-id`, and "by construction" is exactly the
// state that stops being true the moment a second writer appears.
if (plugin) {
  const recordedId = plugin["x-finddata"]?.packageName;
  if (recordedId !== undefined && recordedId !== packageId) {
    note(
      `x-finddata.packageName '${recordedId}' disagrees with plugin.json name '${packageId}'` +
        " — the artifact names itself twice and says two different things",
    );
  }
}
if (mcp) {
  const servers = mcp.mcpServers ?? {};
  if (typeof servers !== "object" || Array.isArray(servers)) {
    note("mcp.json: mcpServers must be an object");
  } else {
    for (const [name, entry] of Object.entries(servers)) {
      if (!name.includes("__")) {
        note(`mcp.json: server '${name}' is not '<package>__<registryName>'`);
        continue;
      }
      // The prefix must be THIS package's id, not merely something non-empty.
      // Before this check a package could rename every key to another pack's id
      // and still pass: `registryName` only pinned the suffix.
      if (packageId && !name.startsWith(`${packageId}__`)) {
        note(
          `mcp.json: server '${name}' is prefixed with another package's id — expected '${packageId}__<registryName>'`,
        );
      }
      const original = entry?.registryName;
      if (typeof original !== "string") {
        note(`mcp.json: server '${name}' does not record its registryName`);
      } else if (!name.endsWith(`__${original}`)) {
        note(`mcp.json: server '${name}' prefix does not match its registryName '${original}'`);
      }
    }
  }
}

// ── not-projected note ───────────────────────────────────────────────────
if (!files.includes("NOT-PROJECTED.md")) {
  note("NOT-PROJECTED.md: missing — fields this target cannot express must be stated, not dropped");
} else if (plugin) {
  let text = "";
  try {
    text = readFileSync(path.join(root, "NOT-PROJECTED.md"), "utf8");
  } catch (err) {
    note(`NOT-PROJECTED.md: cannot read (${err.message})`);
  }
  const claimed = plugin?.["x-finddata"]?.notProjected ?? [];
  for (const entry of claimed) {
    if (entry?.field && !text.includes(entry.field)) {
      note(`NOT-PROJECTED.md: does not mention '${entry.field}', which plugin.json claims is not projected`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stdout.write(`✗ ${problem}\n`);
  process.stdout.write(`\n${problems.length} problem(s) in ${root}\n`);
  process.exit(1);
}
process.stdout.write(`ok  plugin package: ${files.length} files, ${declaredNames.length} skill(s), ${root}\n`);
