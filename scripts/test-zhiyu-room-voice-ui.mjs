#!/usr/bin/env node
// Room voice UI wiring (openspec: add-room-voice-and-catalog, task 4.6).
//
// The auto-read TIMING and the queue/clear behaviour live inside components and
// effects with no DOM test runner, so they are pinned by source assertion — the
// same convention scripts/test-voice-entry-gating.mjs already uses. Each
// assertion is paired with the fact that the code READS the server endpoint it
// claims to, so a component cannot pass by hard-coding a default.
//
//   node --test scripts/test-zhiyu-room-voice-ui.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("the room page offers per-message 朗读 only for agent rows", () => {
  const page = read("web/src/pages/ZhiyuRoomPage.tsx");
  assert.match(page, /\/api\/zhiyu\/rooms\/\$\{roomId\}\/messages\/\$\{row\.seq\}\/speech/, "speech goes to the room endpoint");
  assert.match(page, /row\.kind === "agent" && String\(row\.content \?\? ""\)\.trim\(\)/, "the ▶ control is gated to agent rows WITH text");
  assert.match(page, /data-testid={`zy-speak-\$\{row\.seq\}`}/, "the control carries a per-seq test id");
});

test("auto-read starts OFF and persists the switch per room", () => {
  const page = read("web/src/pages/ZhiyuRoomPage.tsx");
  assert.match(page, /localStorage\.getItem\(VOICE_ON_KEY\) === "1"/, "voice starts off unless the room's key says on");
  assert.match(page, /const VOICE_ON_KEY = `zhiyu:voice-on:\$\{roomId\}`/, "the switch is scoped to this room");
  assert.match(page, /localStorage\.setItem\(VOICE_ON_KEY/, "toggling persists the choice");
});

test("auto-read only queues rows that arrive AFTER the switch was flipped", () => {
  const page = read("web/src/pages/ZhiyuRoomPage.tsx");
  // The effect must compare against a seen-cursor so a history backfill does not
  // read the whole window aloud; and it must only take agent rows.
  assert.match(page, /autoSeenRef\.current/, "a seen-cursor guards the window");
  assert.match(page, /r\.seq > autoSeenRef\.current && r\.kind === "agent"/, "only NEW agent rows auto-read");
  assert.match(page, /mode: "auto"/, "the auto path is tagged so the server can quota-gate it");
});

test("turning voice off clears the player queue", () => {
  const page = read("web/src/pages/ZhiyuRoomPage.tsx");
  assert.match(page, /if \(!next\) speechPlayer\.clear\(\)/, "off clears pending playback");
  const lib = read("web/src/lib/voice.ts");
  assert.match(lib, /clear\(\) \{\s*\n\s*queue = \[\];\s*\n\s*this\.stop\(\);/, "clear() empties the queue and stops playback");
  assert.match(lib, /enqueue\(id: string, blob: Blob\)/, "the player exposes a queue");
});
