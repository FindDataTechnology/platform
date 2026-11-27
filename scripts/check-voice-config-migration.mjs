#!/usr/bin/env node
// Voice config migration check (openspec: add-room-voice-and-catalog, task 5.1).
//
// The new pair rule refuses a `ttsModel`/`ttsVoice` value that is not a catalog
// entry, and refuses a half pair outright. A deployment that saved one side
// before this change still RUNS (read-side leniency degrades the layer), but its
// admin's next save will be rejected. This script prints what that next save
// would need, so the operator is not stuck guessing.
//
//   node scripts/check-voice-config-migration.mjs            # local .env / stored
//   VOICE_CONFIG='{"ttsVoice":"101001"}' node scripts/...    # inspect a value

import { validateVoiceConfig, VOICE_DEFAULTS } from "../server/routes/voice.js";
import { voiceCatalog } from "../server/voice-catalog.js";

const raw = process.env.VOICE_CONFIG ?? "";
let current = null;
try {
  current = raw ? JSON.parse(raw) : null;
} catch (err) {
  console.error(`VOICE_CONFIG is not valid JSON: ${err?.message || err}`);
  process.exit(2);
}

const resolved = validateVoiceConfig(current ?? {}, VOICE_DEFAULTS);
const catalog = voiceCatalog.get();
const entries = catalog.entries;

function nearest(model, voice) {
  // Same model first (the voice is the half that usually drifts), then any.
  const sameModel = entries.filter((e) => e.model === model);
  const pool = sameModel.length ? sameModel : entries;
  if (!pool.length) return null;
  const prefix = (voice ?? "").slice(0, 3);
  return pool.find((e) => e.voice.startsWith(prefix)) ?? pool[0];
}

console.log("voice config migration check (add-room-voice-and-catalog)\n");
console.log(`catalog source : ${voiceCatalog.source()}  (${entries.length} entries)`);
console.log(`current block  : ${raw || "(unset — env seed empty)"}`);
console.log(`validates now  : ${resolved.ok ? "yes" : `NO — ${resolved.error}`}\n`);

if (resolved.ok) {
  const model = String(resolved.normalized.ttsModel ?? "").trim();
  const voice = String(resolved.normalized.ttsVoice ?? "").trim();
  if (!model && !voice) {
    console.log("Nothing to migrate: both blank = the upstream default.");
    process.exit(0);
  }
  console.log("This block satisfies the pair rule; save will be accepted.");
  process.exit(0);
}

const model = String(current?.ttsModel ?? "").trim();
const voice = String(current?.ttsVoice ?? "").trim();
const pick = nearest(model, voice);
console.log("This block will be REJECTED by PUT /api/config/voice. Suggested fix:\n");
if (!pick) {
  console.log("  the catalog is empty — mount a voice-catalog.json first");
  process.exit(1);
}
console.log(`  ttsModel: "${pick.model}",  ttsVoice: "${pick.voice}"   (${pick.label})`);
if (!model || !voice) {
  console.log(`\n  reason: a half pair ("${model}/${voice}") cannot work — set both sides together,`);
  console.log("  or clear both to fall back to the upstream default.");
} else {
  console.log(`\n  reason: "${model}/${voice}" is not in the catalog. An upstream voice that is not`);
  console.log("  catalogued is silently swapped for the default while still answering 200 — pick a listed entry.");
}
console.log("\nSelectable entries:");
for (const e of entries) console.log(`  · ${e.model}/${e.voice}  ${e.label}  [${e.protocol}]`);
process.exit(1);
