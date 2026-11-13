#!/usr/bin/env node
// ── Generate the curation ledger from the catalogue (change
//    add-curation-evidence-gate, tasks 4.1 / 4.2)
//
// The hand-written ledger and the catalogue entries used to be two lists a human
// kept in sync — the structural drift this change removes. But the ledger is not
// ONLY a table: today's file also carries the first-batch rationale, the three
// hard exclusions and the authoring template, and blowing those away to
// "generate the whole document" would destroy the record we are trying to keep
// honest.
//
// So the generator owns a MARKED BLOCK and nothing else:
//
//     <!-- BEGIN GENERATED: curation-ledger -->
//     …table generated from the catalogue…
//     <!-- END GENERATED: curation-ledger -->
//
// Everything outside the markers is human prose and is never touched. `--check`
// compares the block's digest, which is what CI runs: hand-editing the table
// (inside the markers) fails, editing the prose around it does not.
//
// Field whitelist (spec: 生成物 SHALL 含 pin / SPDX / egress / 各轴结论 / 复审期限):
// reviewer is included because this document is internal; nothing else personal is.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPluginCatalog } from "../server/plugin-catalog.js";
import { axesForSpecies, evidenceState } from "../lib/curation-evidence.js";

export const BEGIN_MARK = "<!-- BEGIN GENERATED: curation-ledger -->";
export const END_MARK = "<!-- END GENERATED: curation-ledger -->";

const LEDGER = path.join("docs", "ecosystem-curation-ledger.md");

function cell(value) {
  const text = value === undefined || value === null || value === "" ? "—" : String(value);
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function pinOf(evidence) {
  const pin = evidence?.pin;
  if (!pin || typeof pin !== "object") return "—";
  const ref = pin.commit ? `@${String(pin.commit).slice(0, 12)}` : pin.tag ? `@${pin.tag}` : "@?";
  return `${pin.repo ?? "—"}${ref}`;
}

/** The generated block (deterministic: entries sorted by id, fixed columns). */
export function renderLedgerBlock({ plugins = [], today = new Date() } = {}) {
  const rows = [...(Array.isArray(plugins) ? plugins : [])].sort((a, b) => String(a?.id).localeCompare(String(b?.id)));
  const lines = [BEGIN_MARK, ""];
  lines.push("> 本段由 `node scripts/gen-curation-ledger.mjs` 从 `packs/plugin-catalog.json` 生成，请勿手改；改条目后重新生成。");
  lines.push("");
  if (rows.length === 0) {
    lines.push("_目录中还没有条目。_");
    lines.push("");
    lines.push(END_MARK);
    return `${lines.join("\n")}\n`;
  }
  lines.push("| 条目 | species | 上游钉点 | SPDX | 出网 | 轴结论 | 复审期限 | 证据态 | 审校人 |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const entry of rows) {
    const evidence = entry?.evidence ?? null;
    const species = entry?.species ?? "plugin";
    const axes = evidence?.axes && typeof evidence.axes === "object" ? evidence.axes : null;
    const verdicts = axes
      ? axesForSpecies(species)
          .map((axis) => `${axis}:${axes[axis]?.verdict ?? "—"}`)
          .join(" ")
      : "—";
    const { state } = evidenceState({ evidence, species }, { today });
    const cells = [
      entry.id,
      species,
      pinOf(evidence),
      evidence?.licence,
      typeof evidence?.egress === "string" ? evidence.egress : evidence?.egress?.kind,
      verdicts,
      evidence?.reviewValidUntil ?? "永久",
      state,
      evidence?.reviewedBy,
    ].map(cell);
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push(END_MARK);
  return `${lines.join("\n")}\n`;
}

/** Replace (or append) the marked block, leaving every other byte alone. */
export function spliceBlock(existing, block) {
  const text = String(existing ?? "");
  const begin = text.indexOf(BEGIN_MARK);
  const end = text.indexOf(END_MARK);
  if (begin >= 0 && end > begin) {
    const tail = text.slice(end + END_MARK.length).replace(/^\n?/, "");
    return `${text.slice(0, begin)}${block}${tail ? `${tail}` : ""}`;
  }
  const sep = text.endsWith("\n") || text === "" ? "" : "\n";
  return `${text}${sep}\n${block}`;
}

function main(argv) {
  const arg = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] != null ? argv[i + 1] : fallback;
  };
  const check = argv.includes("--check");
  const root = path.resolve(arg("root") ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const ledgerPath = path.join(root, LEDGER);
  const catalogPath = path.join(root, "packs", "plugin-catalog.json");

  const { plugins } = existsSync(catalogPath)
    ? loadPluginCatalog({ env: { PLUGIN_CATALOG_FILE: catalogPath } })
    : { plugins: [] };
  const block = renderLedgerBlock({ plugins });
  const existing = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
  const next = spliceBlock(existing, block);

  if (check) {
    if (existing === next) {
      console.log(`[curation-ledger] clean — generated block matches the catalogue (${plugins.length} entry(ies))`);
      return 0;
    }
    console.error("[curation-ledger] ledger drifted from the catalogue:");
    console.error(`  · ${LEDGER}: run \`node scripts/gen-curation-ledger.mjs\` and commit the result`);
    console.error("  · the generated block is the marked region only; prose outside it is never touched");
    return 1;
  }

  writeFileSync(ledgerPath, next);
  console.log(`[curation-ledger] wrote ${LEDGER} (${plugins.length} entry(ies))`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
