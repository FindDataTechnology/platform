// The three clients must share ONE state machine (openspec:
// add-zhiyu-mobile-clients, 4.2 / 7.1).
//
// The parity suite proves the three TRANSPORTS agree. It cannot prove the three
// SCREENS actually use them — a page can keep its own `EventSource` + `setRows`
// loop and still pass every parity test, because the parity test never looks at
// the page. And that is how the divergence starts: not by a transport changing,
// but by one screen quietly growing a second cursor.
//
// So this is a wiring gate over the three room screens: each must import the
// shared machine and the shared transitions, and none may open a stream or page
// a window by hand. Proven red against a hand-rolled screen below.
//
//   node --test scripts/test-zhiyu-clients-share-the-machine.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const SCREENS = [
  { name: "web", file: "web/src/pages/ZhiyuRoomPage.tsx" },
  { name: "miniapp", file: "miniapp/src/pages/zhiyu/room/index.tsx" },
  { name: "app", file: "app/src/app/(tabs)/zhiyu/[roomId].tsx" },
];

/** Things only a TRANSPORT may do; a screen doing them owns a second cursor. */
const TRANSPORT_ONLY = [
  { re: /new\s+EventSource\s*\(/, why: "opening a stream is the adapter's job (web/src/lib/zhiyu-room-transport.ts)" },
  { re: /new\s+WebSocket\s*\(/, why: "the room reads over HTTP transports, not a second socket protocol" },
  { re: /setInterval\s*\(/, why: "re-asking on a timer is the poll driver's ladder, not a page's" },
  { re: /\?after=|after=\$\{/, why: "building an increment query by hand bypasses the shared cursor rule" },
];

/**
 * `screen` = "web" renders the client's own state; the two mobile screens keep a
 * UI state of their own and therefore use the shared transitions too. That is
 * the one legitimate asymmetry, so it is a parameter rather than a rule.
 */
function inspect(file, { usesModel }) {
  const src = fs.readFileSync(file, "utf8");
  const problems = [];
  if (!/ZhiyuRoomClient/.test(src)) problems.push("does not import/use ZhiyuRoomClient");
  if (!/createPollingTransport|createEventSourceTransport|transportFor/.test(src)) {
    problems.push("does not use a shared transport factory");
  }
  if (usesModel && (!/applyIncoming/.test(src) || !/applyOlder/.test(src))) {
    problems.push("does not use the shared transitions (applyIncoming / applyOlder)");
  }
  // Strip comments first: these files DISCUSS the rule they follow.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const { re, why } of TRANSPORT_ONLY) {
    for (const line of code.split("\n")) {
      if (!re.test(line)) continue;
      // Constructing the browser's EventSource is the page's ONE transport-ish
      // job: it hands the global to the adapter as a factory. Anywhere else it
      // is a hand-rolled stream.
      if (/new\s+EventSource\s*\(/.test(line) && /eventSource\s*:/.test(line)) continue;
      problems.push(`does transport work: ${why}`);
    }
  }
  return problems;
}

test("the gate catches a hand-rolled room screen (proven red before trusting green)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "machine-gate-"));
  const file = path.join(tmp, "RoomPage.tsx");
  fs.writeFileSync(
    file,
    `import { useEffect, useState } from "react";
export default function Room() {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    const es = new EventSource("/api/zhiyu/rooms/r1/events?after=0");
    es.onmessage = (ev) => setRows((prev) => [...prev, JSON.parse(ev.data)]);
    const t = setInterval(() => {}, 1000);
    return () => { es.close(); clearInterval(t); };
  }, []);
  return null;
}
`,
  );
  const problems = inspect(file, { usesModel: true });
  assert.ok(problems.length >= 3, `the gate must flag a second cursor loop, got ${JSON.stringify(problems)}`);
  assert.ok(problems.some((p) => p.includes("ZhiyuRoomClient")));
  assert.ok(problems.some((p) => p.includes("opening a stream")));
  // The gate reports WHY, not the matched token — assert on the prose.
  assert.ok(problems.some((p) => p.includes("timer")));
});

test("4.2 all three room screens drive the shared machine", () => {
  for (const { name, file } of SCREENS) {
    const full = path.join(ROOT, file);
    assert.ok(fs.existsSync(full), `${name}: ${file} must exist`);
    // Web renders the client's state directly; both mobile screens keep a UI
    // state and therefore also use the shared transitions.
    assert.deepEqual(inspect(full, { usesModel: name !== "web" }), [], `${name} (${file})`);
  }
});

test("the three screens differ only in transport factory and rendering", () => {
  const src = Object.fromEntries(SCREENS.map(({ name, file }) => [name, fs.readFileSync(path.join(ROOT, file), "utf8")]));
  // Web is the only one with a stream; both mobile clients poll.
  assert.match(src.web, /createEventSourceTransport/);
  assert.equal(/createPollingTransport/.test(src.web), false, "web does not poll");
  for (const mobile of ["miniapp", "app"]) {
    assert.match(src[mobile], /createPollingTransport/, `${mobile} polls`);
    assert.equal(/createEventSourceTransport/.test(src[mobile]), false, `${mobile} has no EventSource`);
  }
  // Nobody keeps the transport's hold decision locally.
  for (const [name, code] of Object.entries(src)) {
    if (name === "web") continue;
    assert.match(code, /holdFor\(/, `${name}: the hold comes from the shared model`);
  }
});
