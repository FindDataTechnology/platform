#!/usr/bin/env node
// Voice entry gating across the three clients (openspec: add-voice-input-mobile,
// task 4.3).
//
// The entry must follow the SERVER's answer, not the client's guess: a
// deployment with the lane disabled or unconfigured renders nothing, everywhere.
//
// The render conditions live inside components, so this pins them by source
// assertion — the same convention the repo already uses for web components
// ("web has no DOM test runner; e2e anchors the rendered surface", see
// scripts/test-agent-spec-sheet.mjs). Each assertion is paired with the check
// that the client actually READS /api/voice/status, so a client cannot pass by
// hard-coding `available = true`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("web gates both entries on /api/voice/status", () => {
  const hook = read("web/src/hooks/useVoice.ts");
  assert.match(hook, /\/api\/voice\/status/, "the hook must read the server status");
  assert.match(hook, /available:\s*!deploymentOff\s*&&\s*s\.status\?\.available === true/, "available comes from the status, never a default true");

  const composer = read("web/src/components/Composer.tsx");
  assert.match(composer, /const canRecord = voice\.available && browserRecordingSupported\(\)/, "mic is gated on availability AND the recorder");
  assert.match(composer, /onVoiceFile=\{voice\.available \?/, "the audio-file entry is gated on availability alone");
});

test("mini-program gates the mic on the server answer", () => {
  const page = read("miniapp/src/pages/chat/index.tsx");
  assert.match(page, /\/api\/voice\/status/, "the page must read the server status");
  assert.match(page, /const canRecord = voiceAvailable && voice\.canRecord\(\)/, "mic is gated on availability AND the recorder");
  // A running long-recording owns the recorder (one RecorderManager per mini
  // program), so the hold-to-talk mic must also stand down while it is active
  // (openspec: add-voice-capture-lane). The gate may only ever be NARROWER.
  assert.match(page, /\{canRecord && !captureActive \?/, "the mic renders only under that gate");
});

test("app gates the mic on the server answer", () => {
  const page = read("app/src/app/(tabs)/index.tsx");
  assert.match(page, /http\("\/api\/voice\/status"\)/, "the screen must read the server status");
  assert.match(
    page,
    /\{voiceAvailable && voice\.canRecord\(\) && !captureActive \?/,
    "mic is gated on availability, the recorder, and no running capture",
  );
});

test("no client invents availability: an unreadable status means no entry", () => {
  // Both mobile clients start from false and only ever set true from the body —
  // so a 500 / timeout / offline hides the entry instead of offering an action
  // that will fail on first tap.
  assert.match(read("miniapp/src/pages/chat/index.tsx"), /useState\(false\);\s*\n\s*useEffect\(\(\) => \{\s*\n\s*let alive = true;/, "starts false");
  assert.match(read("app/src/app/(tabs)/index.tsx"), /const \[voiceAvailable, setVoiceAvailable\] = useState\(false\)/, "starts false");
});
