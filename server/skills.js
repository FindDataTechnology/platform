// Slash-command parsing + skill-file helpers shared by the WS prompt
// dispatcher (server/ws.js) and the extensions routes. Pure functions except
// expandDocRefs, which reads the documents service through ctx.

import path from "node:path";
import { repoRoot } from "../paths.js";
import { readFile } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";

// Parse a leading slash-command from a prompt. Returns one of:
//   { command: "skill", name, args }   - /skill:<name> [args]
//   { command: "model", args }          - /model [id]
//   { command: "new" | "clear" | "help", args: "" }
//   { command: null }                   - a "/…" token that is NOT a recognised
//                                         command (caller lets it fall through to
//                                         the agent as a normal prompt)
//   null                                - not a slash-command at all
// `/clear` and `/help` are client-handled (the UI should not forward them); if
// they reach the server they are treated as no-ops.
export function parseCommand(text) {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const skillMatch = t.match(/^\/skill:([^\s]+)(?:[\s]+([\s\S]*))?$/);
  if (skillMatch) {
    return { command: "skill", name: skillMatch[1], args: (skillMatch[2] || "").trim() };
  }
  const modelMatch = t.match(/^\/model(?:[\s]+([\s\S]*))?$/i);
  if (modelMatch) {
    return { command: "model", args: (modelMatch[1] || "").trim() };
  }
  const simpleMatch = t.match(/^\/(new|clear|help)\b/i);
  if (simpleMatch) {
    return { command: simpleMatch[1].toLowerCase(), args: "" };
  }
  return { command: null };
}

// Read a SKILL.md file, strip YAML frontmatter, and combine with the user's args.
export async function expandSkillContent(skill, args) {
  const raw = await readFile(skill.filePath, "utf8");
  const body = raw.replace(/^---[\s\S]*?---\s*/, "").trim();
  const argSection = args ? `\n\n## Arguments\n${args}` : "";
  return `${body}${argSection}`;
}

// Expand @doc:<id> / @collection:<id> reference tokens into LIGHT context for
// the agent: name + bounded summary + pointers to the library MCP tools
// (mcp__library__read_document / mcp__library__search_library). The full
// source text is deliberately NOT injected — the agent pulls what it needs on
// demand, which keeps prompts small regardless of document size. Mirrors how
// /skill: tokens are expanded before session.prompt(). Unknown/missing ids
// become a short note so the prompt stays coherent.
export async function expandDocRefs(ctx, text) {
  if (!text.includes("@doc:") && !text.includes("@collection:")) return text;
  let out = text;

  for (const m of [...text.matchAll(/@doc:([A-Za-z0-9_-]+)/g)]) {
    const id = m[1];
    let card;
    try {
      card = ctx.db.getDocumentCard(id);
    } catch (e) {
      console.warn(`[doc] @doc:${id} lookup failed: ${e.message}`);
    }
    let body;
    if (!card) {
      body = `[attached document ${id} is unavailable or empty]`;
    } else if (card.status !== "ready" || !card.summary?.trim()) {
      body = `[attached document "${card.name}" (${id}) is not ready — status: ${card.status}. Ask the user to re-add it.]`;
    } else {
      const summary = card.summary.trim().replace(/\s+/g, " ");
      body =
        `[attached document "${card.name}" (id: ${id}) — summary: ${summary}\n` +
        `Full content: call the mcp__library__read_document tool with doc_id "${id}", ` +
        `or mcp__library__search_library to locate relevant passages.]`;
    }
    out = out.replaceAll(m[0], `\n\n${body}\n`);
  }

  for (const m of [...text.matchAll(/@collection:([A-Za-z0-9_-]+)/g)]) {
    const id = m[1];
    let body = null;
    try {
      const col = ctx.db.getCollection(id);
      if (col) {
        const members = ctx.db.listCollectionDocuments(id);
        const names = members.map((d) => `"${d.name}" (${d.id})`).join(", ");
        body =
          `[collection "${col.name}" (id: ${id}) — ${members.length} document(s): ${names || "(empty)"}.\n` +
          `Retrieve member content on demand with the mcp__library__read_document and ` +
          `mcp__library__search_library tools (search_library accepts a collection filter).]`;
      }
    } catch (e) {
      console.warn(`[doc] @collection:${id} lookup failed: ${e.message}`);
    }
    out = out.replaceAll(m[0], `\n\n${body ?? `[collection ${id} is unavailable]`}\n`);
  }

  return out;
}

// Scan the project skills/ dir (dir bundles `<name>/SKILL.md` + flat `<name>.md`)
// for [{name, description, filePath}]. list_skills + /skill: expansion source
// the same dir the skill-filesystem plugin's customSkillDirs points at (Task 5.3).
// ponytail: regex frontmatter parse + no caching (4 files, called rarely); a
// multi-line/quoted description or a hot list_skills path needs a real parser + cache.
export function getFileSkills(dir = repoRoot("skills")) {
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  const skills = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    const filePath = st.isDirectory() ? path.join(full, "SKILL.md") : (entry.endsWith(".md") ? full : null);
    if (!filePath) continue;
    let raw;
    try { raw = readFileSync(filePath, "utf8"); } catch { continue; }
    const block = raw.match(/^---[\s\S]*?---/)?.[0];
    if (!block) continue;
    const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const desc = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (!name) continue;
    skills.push({ name, description: desc || "", filePath });
  }
  return skills;
}
