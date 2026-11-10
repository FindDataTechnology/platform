// Re-embed services/search-relay code into the deployment manifest's ConfigMap.
//
// The relay runs its code from a ConfigMap mounted with subPath (so a ConfigMap
// update needs a rollout restart to reach the pod). Two files are embedded:
// index.js and scoped-token.js. Everything else in the manifest (Deployment,
// Service, trailing comments) is preserved verbatim.
//
// Run: node scripts/embed-search-relay-configmap.mjs [manifest] [relayDir]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const manifest = process.argv[2] ?? (process.env.SEARCH_RELAY_MANIFEST || "all-services/prod/search-relay.yaml");
const relayDir = process.argv[3] ?? (process.env.SEARCH_RELAY_DIR || "services/search-relay");

const src = readFileSync(manifest, "utf8");

// A ConfigMap block scalar: "  <key>: |" followed by 4-space-indented lines up
// to the next line that starts at column 0 or a lower indent than 4.
function replaceBlock(text, key, content) {
  const startRe = new RegExp(`^  ${key}: \\|\\n`, "m");
  const m = startRe.exec(text);
  if (!m) throw new Error(`block ${key} not found in manifest`);
  const start = m.index + m[0].length;
  let end = start;
  const lines = text.slice(start).split("\n");
  let consumed = 0;
  for (const line of lines) {
    // Block body ends at the first non-blank line indented less than 4 spaces.
    if (line.trim() !== "" && !/^ {4}/.test(line)) break;
    consumed += line.length + 1;
    end = start + consumed;
  }
  const body = content
    .split("\n")
    .map((l) => (l.trim() === "" ? "" : `    ${l}`))
    .join("\n");
  return text.slice(0, start) + body + "\n" + text.slice(end);
}

let out = src;
for (const file of ["index.js", "scoped-token.js"]) {
  const content = readFileSync(join(relayDir, file), "utf8").replace(/\n+$/, "\n");
  out = replaceBlock(out, file, content);
}
writeFileSync(manifest, out);
console.log(`re-embedded ${manifest} ← ${relayDir} (index.js, scoped-token.js)`);
