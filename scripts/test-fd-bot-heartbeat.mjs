// Heartbeat for the fd-bot transport (adopt-fd-bot-transport 8.1).
//
// The contract this pins: an outage must produce exactly ONE alert carrying a
// stable tag, recovery must be reported, and a deployment that never configured
// fd-bot must stay silent. The third one matters as much as the first two — a
// service complaining about a dependency it was never told to use trains people
// to ignore the tag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFdBotHeartbeat, DOWN_TAG, UP_TAG } from "../server/fd-bot-heartbeat.js";

const quiet = () => {
  const lines = [];
  const push = (m) => lines.push(m);
  return { lines, log: { log: push, warn: push, error: push } };
};

const failFetch = async () => {
  throw new Error("ECONNREFUSED");
};

test("no FD_BOT_URL means no probe and no complaints", async () => {
  const { lines, log } = quiet();
  const alerts = [];
  const hb = createFdBotHeartbeat({ url: () => "", fetchImpl: failFetch, alert: (a) => alerts.push(a), log });
  const r = await hb.probe();
  assert.equal(r.state, "unconfigured");
  assert.equal(lines.length, 0);
  assert.equal(alerts.length, 0);
});

test("one or two failures stay quiet; the threshold produces exactly one alert", async () => {
  const { lines, log } = quiet();
  const alerts = [];
  const hb = createFdBotHeartbeat({ url: () => "http://fd-bot.test", threshold: 3, fetchImpl: failFetch, alert: (a) => alerts.push(a), log });

  assert.equal((await hb.probe()).state, "down");
  assert.equal((await hb.probe()).state, "down");
  assert.equal(alerts.length, 0, "a transient blip must not page anyone");
  assert.equal(lines.length, 0);

  assert.equal((await hb.probe()).state, "down");
  assert.equal(alerts.length, 1, "the third failure is the outage");
  assert.equal(alerts[0].kind, "down");

  // Further failures during the SAME outage do not re-alert.
  await hb.probe();
  await hb.probe();
  assert.equal(alerts.length, 1, "an alert per poll is noise that trains people to ignore it");
});

test("the outage log line names the consequence and the blast radius", async () => {
  const { lines, log } = quiet();
  const hb = createFdBotHeartbeat({ url: () => "http://fd-bot.test", threshold: 1, fetchImpl: failFetch, log });
  await hb.probe();
  const line = lines.join("\n");
  assert.ok(line.includes(DOWN_TAG), "the tag is what makes it greppable/alertable");
  assert.match(line, /receiving nothing/, "the operator needs the consequence, not 'fetch failed'");
  assert.match(line, /in-cell bots are unaffected/, "the blast radius is a different half of the fleet");
});

test("recovery clears the flag and announces itself once", async () => {
  const { lines, log } = quiet();
  const alerts = [];
  let healthy = false;
  const fetchImpl = async () => {
    if (!healthy) throw new Error("ECONNREFUSED");
    return new Response("{}", { status: 200 });
  };
  const hb = createFdBotHeartbeat({ url: () => "http://fd-bot.test", threshold: 1, fetchImpl, alert: (a) => alerts.push(a), log });
  await hb.probe();
  assert.equal(hb.status.down, true);
  healthy = true;
  await hb.probe();
  assert.equal(hb.status.down, false);
  assert.ok(lines.some((l) => l.includes(UP_TAG)));
  assert.deepEqual(alerts.map((a) => a.kind), ["down", "recovered"]);

  // Staying healthy produces no further lines.
  const before = lines.length;
  await hb.probe();
  assert.equal(lines.length, before);
});

test("a non-2xx health answer counts as down, not as up", async () => {
  const hb = createFdBotHeartbeat({
    url: () => "http://fd-bot.test",
    threshold: 1,
    fetchImpl: async () => new Response("{}", { status: 503 }),
    log: { log() {}, warn() {}, error() {} },
  });
  const r = await hb.probe();
  assert.equal(r.state, "down");
});
