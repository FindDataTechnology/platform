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
 * A UI clock is not a poll. `setInterval(() => setNowMs(Date.now()), 1000)`
 * re-renders an elapsed counter and never asks the server anything, so it
 * cannot grow a second cursor. Screens say so on the line itself, which keeps
 * the exemption visible in review instead of hiding it in a file-level list.
 */
const CLOCK_ALLOWANCE = /gate-allow:\s*ui-clock/;

/**
 * A screen that is WIRED but not DRIVEN.
 *
 * This is the assertion whose absence shipped the 2026-11-17 regression: the
 * gate only forbade the wrong things, so a page that imported the shared
 * machine, built the shared transport and then never moved the cursor passed
 * every check — and showed a single snapshot forever. Forbidding things is
 * half a gate; the other half is requiring that the right path runs.
 */
const DRIVEN = [
  { re: /\bnew\s+PollDriver\s*\(/, why: "build the shared driver (packages/core/src/zhiyu-poll.ts)" },
  { re: /\bdriver\s*\.\s*start\s*\(/, why: "start the driver — a client that is never asked for increments shows one snapshot" },
  { re: /\bdriver\s*\.\s*stop\s*\(/, why: "stop the driver on unmount, or a remount leaves a second reader behind" },
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
  // Strip comments first: these files DISCUSS the rule they follow. A comment
  // naming PollDriver must not satisfy "is driven" — only code counts.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const { re, why } of DRIVEN) {
    if (!re.test(code)) problems.push(`is not driven: ${why}`);
  }
  for (const { re, why } of TRANSPORT_ONLY) {
    for (const line of code.split("\n")) {
      if (!re.test(line)) continue;
      // Constructing the browser's EventSource is the page's ONE transport-ish
      // job: it hands the global to the adapter as a factory. Anywhere else it
      // is a hand-rolled stream.
      if (/new\s+EventSource\s*\(/.test(line) && /eventSource\s*:/.test(line)) continue;
      if (CLOCK_ALLOWANCE.test(line)) continue;
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

test("the gate catches a WIRED BUT NEVER DRIVEN screen (the 2026-11-17 regression)", () => {
  // Exactly what production ran for four days: every shared piece imported,
  // the client constructed, `start()` awaited — and nothing ever asked for an
  // increment, so the stream never opened. Every prohibition-only gate passes
  // this. The driver assertions are what make it red.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "machine-undriven-"));
  const file = path.join(tmp, "RoomPage.tsx");
  fs.writeFileSync(
    file,
    `import { useEffect } from "react";
import { ZhiyuRoomClient } from "@platform/core";
import { createEventSourceTransport } from "@/lib/zhiyu-room-transport";
export default function Room({ roomId }) {
  useEffect(() => {
    const transport = createEventSourceTransport({ roomId, eventSource: (u) => new EventSource(u) });
    const client = new ZhiyuRoomClient({ transport, roomId });
    client.subscribe((state) => setRows(state.messages));
    void client.start();
    return () => transport.close();
  }, [roomId]);
  return null;
}
`,
  );
  const problems = inspect(file, { usesModel: false });
  assert.ok(
    problems.some((p) => p.includes("is not driven") && p.includes("start the driver")),
    `a screen that never drives its client must fail, got ${JSON.stringify(problems)}`,
  );
  assert.equal(problems.some((p) => p.includes("does transport work")), false, "it uses the shared transport correctly");
});

test("a UI clock may use setInterval when it says so on the line", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "machine-clock-"));
  const file = path.join(tmp, "RoomPage.tsx");
  fs.writeFileSync(
    file,
    `const id = setInterval(() => setNowMs(Date.now()), 1000); // gate-allow: ui-clock
const bad = setInterval(() => {}, 1000);
`,
  );
  const problems = inspect(file, { usesModel: false });
  const timerProblems = problems.filter((p) => p.includes("timer"));
  assert.equal(timerProblems.length, 1, "only the unmarked timer is a poll");
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
