// lib/skill-files.js — shared skill-package file rules (add-packaged-skills D3).
//
// One definition of "which files a skill package may carry", consumed by every
// surface that must agree: the external-market package parser
// (external-sources.js, 刀二), the pack-manifest validator (both the facet
// publish gate and the cell install gate), the zip upload endpoint, and the
// CLI packager. Living in lib/ (no jszip/js-yaml imports) keeps the validator's
// import graph light — heavyweight adapters depend on this module, never the
// reverse.

// Text extensions stored alongside SKILL.md. Everything else is omitted from
// storage but MUST be listed in whatever preview the entry surface shows
// (omission is visible, not silent).
export const TEXT_EXTENSIONS = new Set([
  "md", "txt", "json", "yaml", "yml", "toml", "csv", "tsv",
  "py", "sh", "bash", "zsh", "js", "mjs", "cjs", "ts", "rb", "pl", "ps1", "bat", "cmd",
  "sql", "html", "css", "ini", "cfg", "conf", "env", "gitignore", "dockerfile", "xml",
]);

// Well-known text filenames without a recognized extension.
const TEXT_FILENAMES = new Set(["Dockerfile", "Makefile"]);

// Script extensions — files the platform treats as executable-when-run. Used
// for the inventory's script highlight, the pack-install confirm gate, and the
// install report's scriptFiles disclosure (one set, three consumers).
const SCRIPT_EXTENSIONS = new Set([
  "py", "sh", "bash", "zsh", "js", "mjs", "cjs", "ts", "rb", "pl", "ps1", "bat", "cmd",
]);

// Does this relative path name a text file the platform stores? `head` is the
// first ~64 bytes of content: an extensionless file starting with a shebang is
// a script and counts as text (the same sniff 刀二's parser applies).
export function isTextFilePath(relPath, head = null) {
  const name = relPath.split("/").pop() || relPath;
  if (TEXT_FILENAMES.has(name)) return true;
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (!ext && typeof head === "string" && head.startsWith("#!")) return true;
  return false;
}

export function isScriptFilePath(relPath) {
  const name = relPath.split("/").pop() || relPath;
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return SCRIPT_EXTENSIONS.has(ext);
}

// A package/skill entry path is accepted only when it stays inside the package
// root: no absolute paths, no drive letters, no NUL, no backslash tricks, no
// `..` segments. Returns the normalized relative path or null.
export function safePackagePath(rawPath) {
  if (typeof rawPath !== "string" || !rawPath) return null;
  if (rawPath.includes("\0") || rawPath.includes("\\")) return null;
  if (/^[A-Za-z]:/.test(rawPath)) return null;
  if (rawPath.startsWith("/")) return null;
  const parts = rawPath.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  if (parts.length === 0) return null;
  return parts.join("/");
}

// The rendered SKILL.md is GENERATED from the entry's content/name/description
// (skill-materialize.renderSkillMd) — a files key whose basename is SKILL.md in
// any casing would clobber it on case-insensitive filesystems (the materializer
// writes the rendered doc first, then the auxiliary tree).
export function isSkillMdCollision(relPath) {
  return /(^|\/)skill\.md$/i.test(relPath);
}
