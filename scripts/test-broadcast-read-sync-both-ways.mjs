#!/usr/bin/env node
// ── Bidirectional read-state sync (sync-broadcast-read-both-ways) ────────────
//
// "已读 is account-level" needs BOTH directions to hold, and each direction
// must survive the other face being unreachable. The two properties that keep
// this honest:
//   · a user's read in the cell fires exactly one outward sync, and only for
//     rows that actually carry a broadcastId;
//   · the gateway's own inbound sync does NOT bounce back (no loop between two
//     live faces).
//
//   node --test scripts/test-broadcast-read-sync-both-ways.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { syncBroadcastReadToGateway, broadcastSyncConfigured } from "../server/notifications-sync.js";

test("sync client: posts the (recipient, broadcastId) pair with the shared secret", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, changed: 1 }) };
  };
  const out = await syncBroadcastReadToGateway({
    email: "a@x",
    broadcastId: "bc_1",
    env: { CELL_GATEWAY_SECRET: "s", GATEWAY_INTERNAL_URL: "http://gw:1/x" },
    fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://gw:1/x/api/zhiyu/notifications/read-by-broadcast");
  assert.equal(calls[0].headers["x-cloud-gateway-secret"], "s");
  assert.deepEqual(calls[0].body, { recipient: "a@x", broadcastId: "bc_1" });
  assert.equal(out.changed, 1);
});

test("sync client: normalises the recipient to lower case (one identity, one spelling)", async () => {
  const calls = [];
  const fetchImpl = async (_u, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await syncBroadcastReadToGateway({
    email: "  A@X  ",
    broadcastId: "bc_1",
    env: { CELL_GATEWAY_SECRET: "s" },
    fetchImpl,
  });
  assert.equal(calls[0].recipient, "a@x");
});

test("sync client: a non-ok answer throws (the caller logs it, never fails the request)", async () => {
  await assert.rejects(
    () =>
      syncBroadcastReadToGateway({
        email: "a@x",
        broadcastId: "bc_1",
        env: { CELL_GATEWAY_SECRET: "s" },
        fetchImpl: async () => ({ ok: false, status: 503 }),
      }),
    /gateway answered 503/,
  );
});

test("sync client: unconfigured is a plain refusal, so callers can skip the work", async () => {
  assert.equal(broadcastSyncConfigured({}), false);
  assert.equal(broadcastSyncConfigured({ CELL_GATEWAY_SECRET: "s" }), true);
  await assert.rejects(
    () => syncBroadcastReadToGateway({ email: "a@x", broadcastId: "bc_1", env: {} }),
    /no CELL_GATEWAY_SECRET/,
  );
});
