#!/usr/bin/env node
// ── Fleet dispatch entries must resolve their target ─────────────────────────
//
// Why this file exists (openspec change: fix-fleet-handoff-injection):
//
// `agent-fleet-orchestration` requires that every entry which can turn a post
// into a turn resolves that post's runnability first. Four entries exist:
// handoff edges (`igniteFleetEdges`), event wake (`triggerFleetEventWake` /
// `deliverFleetEventWake`), decision execute-now, and delegation. On
// 2026-11-17 a rewrite of server.js dropped `resolveTarget` from the handoff
// call; the seam throws a loud TypeError at entry, but the call site wraps it
// in a try/catch that logs one warning line — so handoff edges silently
// stopped igniting for seven days and no test noticed, because every existing
// test constructs its own ctx and passes `resolveTarget` itself.
//
// The defect lived in the CALL SITE, so the check must read the call site.
// This scans server.js for the three dispatch seams and asserts each call's
// argument object names a resolver. It cannot prove the resolver is correct;
// it proves the wiring exists, which is exactly what was missing.
//
// Run: node scripts/check-fleet-dispatch-resolvers.mjs [--json]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Dispatch seams whose call site must inject a resolver. */
export const SEAMS = ["igniteFleetEdges", "triggerFleetEventWake", "deliverFleetEventWake"];

/** The argument name that satisfies the requirement. */
export const RESOLVER_PARAM = "resolveTarget";

/**
 * Call sites that legitimately do NOT need a resolver.
 *
 * Empty today: all three seams require one (each throws or degrades otherwise).
 * Each entry must carry a one-line reason; "because it is red" is not a reason.
 */
export const ALLOWLIST = [
  // { seam: "…", file: "…", lineContains: "…", reason: "…" }
];

/**
 * Extract every call to `name(` in `src`, returning { start, end } spans of the
 * balanced argument list. One pass, with a mode machine over the WHOLE source:
 * a call named inside a comment or a string literal is text, not a call, and
 * the scanner refusing to tell them apart would be a gate that reports noise.
 */
export function callSpans(src, name) {
  const spans = [];
  const isIdent = (c) => /[A-Za-z0-9_$]/.test(c);
  let mode = "code"; // code | line | block | single | double | template
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (mode === "line") { if (c === "\n") mode = "code"; continue; }
    if (mode === "block") { if (c === "*" && next === "/") { mode = "code"; i++; } continue; }
    if (mode === "single") { if (c === "\\") i++; else if (c === "'") mode = "code"; continue; }
    if (mode === "double") { if (c === "\\") i++; else if (c === '"') mode = "code"; continue; }
    if (mode === "template") { if (c === "\\") i++; else if (c === "`") mode = "code"; continue; }
    // mode === "code"
    if (c === "/" && next === "/") { mode = "line"; i++; continue; }
    if (c === "/" && next === "*") { mode = "block"; i++; continue; }
    if (c === "'") { mode = "single"; continue; }
    if (c === '"') { mode = "double"; continue; }
    if (c === "`") { mode = "template"; continue; }
    if (!src.startsWith(name, i) || isIdent(src[i - 1] ?? "") || isIdent(src[i + name.length] ?? "")) continue;
    let j = i + name.length;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] !== "(") continue;
    // Walk the argument list with its own mode machine.
    const open = j;
    let depth = 0;
    let inner = "code";
    for (; j < src.length; j++) {
      const d = src[j];
      const dn = src[j + 1];
      if (inner === "line") { if (d === "\n") inner = "code"; continue; }
      if (inner === "block") { if (d === "*" && dn === "/") { inner = "code"; j++; } continue; }
      if (inner === "single") { if (d === "\\") j++; else if (d === "'") inner = "code"; continue; }
      if (inner === "double") { if (d === "\\") j++; else if (d === '"') inner = "code"; continue; }
      if (inner === "template") { if (d === "\\") j++; else if (d === "`") inner = "code"; continue; }
      if (d === "/" && dn === "/") { inner = "line"; j++; continue; }
      if (d === "/" && dn === "*") { inner = "block"; j++; continue; }
      if (d === "'") { inner = "single"; continue; }
      if (d === '"') { inner = "double"; continue; }
      if (d === "`") { inner = "template"; continue; }
      if (d === "(") depth++;
      else if (d === ")") {
        depth--;
        if (depth === 0) { spans.push({ start: open, end: j + 1 }); break; }
      }
    }
    i = j; // resume after the argument list
  }
  return spans;
}

const lineAt = (src, idx) => src.slice(0, idx).split("\n").length;

/**
 * Judge one source text. Returns findings; empty means every seam call names a
 * resolver. `file` is only used for reporting.
 */
export function checkSource(src, { file = "server.js", seams = SEAMS, allowlist = ALLOWLIST } = {}) {
  const findings = [];
  const lines = src.split("\n");
  for (const seam of seams) {
    for (const { start, end } of callSpans(src, seam)) {
      const line = lineAt(src, start);
      const lineText = lines[line - 1] ?? "";
      if (allowlist.some((a) => a.seam === seam && a.file === file && lineText.includes(a.lineContains))) continue;
      const args = src.slice(start, end);
      if (new RegExp(`\\b${RESOLVER_PARAM}\\b`).test(args)) continue;
      findings.push({
        file,
        line,
        seam,
        message: `${seam}(…) at ${file}:${line} does not pass \`${RESOLVER_PARAM}\` — this entry can create a turn for a post that cannot run`,
      });
    }
  }
  return findings;
}

/** Self-test: the scanner must be seen refusing a known-bad sample and passing good ones. */
export function selfTest() {
  const cases = {
    badIsRed: [`igniteFleetEdges({ db, engine, job })`, 1],
    goodIsGreen: [`igniteFleetEdges({ db, resolveTarget: r })`, 0],
    stringIsIgnored: [`const doc = "igniteFleetEdges({ db })";`, 0],
    lineCommentIsIgnored: [`// igniteFleetEdges({ db, engine })\nconst x = 1;`, 0],
    blockCommentIsIgnored: [`/* igniteFleetEdges({ db }) */\nconst x = 1;`, 0],
    multilineCallIsRed: [`igniteFleetEdges({\n  db,\n  engine,\n  job,\n})`, 1],
    multilineCallIsGreen: [`igniteFleetEdges({\n  db,\n  resolveTarget: r,\n})`, 0],
    nestedParensResolve: [`igniteFleetEdges({ db: f(a, (b)) })`, 1],
  };
  const out = {};
  for (const [name, [sample, expected]] of Object.entries(cases)) {
    out[name] = checkSource(sample, { file: "sample.js" }).length === expected;
  }
  return out;
}

function main() {
  const wantJson = process.argv.includes("--json");
  const st = selfTest();
  const selfFailures = Object.entries(st).filter(([, ok]) => !ok).map(([k]) => k);

  const file = path.join(REPO, "server.js");
  const src = fs.readFileSync(file, "utf8");
  const findings = checkSource(src, { file: "server.js" });

  if (wantJson) {
    console.log(JSON.stringify({ findings, selfTest: st, selfFailures }, null, 2));
  } else if (findings.length === 0 && selfFailures.length === 0) {
    // Silent on success — this runs in the unit lane.
  } else {
    for (const f of selfFailures) console.error(`[fleet-dispatch] SCANNER SELF-TEST FAILED: ${f} — the scanner is broken, not the code`);
    for (const f of findings) {
      console.error(`[fleet-dispatch] ${f.message}`);
      console.error(`  fix: pass \`${RESOLVER_PARAM}: resolveFleetTarget\` in that call's argument object.`);
      console.error(`  why: fleet-handoffs.js throws at entry without it, and the caller's try/catch hides it as one warning line.`);
    }
  }
  process.exit(findings.length === 0 && selfFailures.length === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
