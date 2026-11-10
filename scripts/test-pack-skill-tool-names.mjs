// Content guard for the four vertical-pack entry skills: primary workflow
// instructions must name EXACT callable tool names (add-tool-discovery-layer).
// Run: node --test scripts/test-pack-skill-tool-names.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The sample pack skills live in docs/vertical-packs/skills/ — operator-side
// content that ships with the private deployment, not the open-source tree.
// Skip whole-file when the directory is absent (public-repo CI).
const SKILLS_DIR = join(root, "docs", "vertical-packs", "skills");
if (!existsSync(SKILLS_DIR)) {
  console.warn("[skip] docs/vertical-packs/skills absent — pack-skill content guard skipped");
  process.exit(0);
}
const skills = [
  "china-macro-brief-workflow",
  "legal-case-workflow",
  "legal-contract-workflow",
  "stock-research-workflow",
];

// The full callable names each skill's primary workflow must reference.
const REQUIRED = {
  "china-macro-brief-workflow": [
    "mcp__fd-open-data-mcp__ai_search",
    "mcp__fd-open-data-mcp__read",
  ],
  "legal-case-workflow": [
    "mcp__fd-find-data-business-mcp__law_search",
    "mcp__fd-find-data-business-mcp__law_read",
  ],
  "legal-contract-workflow": [
    "mcp__law-bench__law_info",
    "mcp__law-bench__search_clauses",
  ],
  "stock-research-workflow": [
    "mcp__fd-cn-report__search_reports",
    "mcp__fd-open-data-mcp__get_entity",
  ],
};

test("every pack skill names its primary tools with full callable names", () => {
  for (const name of skills) {
    const text = readFileSync(
      join(root, "docs", "vertical-packs", "skills", name, "SKILL.md"),
      "utf8",
    );
    for (const required of REQUIRED[name]) {
      assert.ok(
        text.includes(required),
        `${name} is missing exact tool name ${required}`,
      );
    }
  }
});

test("no pack skill relies on wildcard-only tool patterns", () => {
  for (const name of skills) {
    const text = readFileSync(
      join(root, "docs", "vertical-packs", "skills", name, "SKILL.md"),
      "utf8",
    );
    assert.doesNotMatch(text, /mcp__[a-z0-9-]+__\*/, `${name} still contains a wildcard tool pattern`);
    // A malformed server segment (hyphen/underscore corruption of the real
    // server names) is the live failure shape — never acceptable in guidance.
    assert.doesNotMatch(
      text,
      /mcp__(?!fd-open-data-mcp__|fd-cn-report__|law-bench__|fd-find-data-business-mcp__|fd-legal-search-mcp__)[a-z0-9_-]+__/,
      `${name} references an unknown/malformed MCP server name`,
    );
  }
});

test("skills instruct honest fallback and tool_search verification", () => {
  for (const name of skills) {
    const text = readFileSync(
      join(root, "docs", "vertical-packs", "skills", name, "SKILL.md"),
      "utf8",
    );
    assert.match(text, /tool_search/, `${name} does not mention tool_search for roster verification`);
  }
});
