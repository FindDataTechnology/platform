// Outbound-capability contract (make-im-lane-outbound-capable 1.1).
// Run: node --test scripts/test-bot-outbound-capabilities.mjs
//
// The point of this test is the TABLE, not the plumbing: every platform app
// declares its outbound shape next to its own sending code, and the binding
// face reads that declaration instead of guessing. A wrong table entry is a
// "bound but silently undeliverable" bug in production — exactly the 2026-11-18
// shape — so the assertions are literal per platform.
//
// Coverage is DERIVED from BOT_TYPES, never hand-written (add-mattermost-channel
// 1.2). A hand-written subset silently exempts every platform added after it was
// written: Slack landed 2026-11-18, one day before the declaration contract, and
// this file's five-entry list never noticed that its capability read "none"
// while its own sendText called chat.postMessage. Anything that enumerates
// platforms for a coverage check must start from the authoritative list.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BOT_TYPES,
  isOutboundOnly,
  outboundCapabilityFor,
  outboundCapabilityOfBot,
  OUTBOUND_MODES,
} from "../server/bots/adapter.js";

// Pure-outbound legs declare `inbound: false` by platform design (a group robot
// has no callback). Everything else must receive AND declare a real send shape.
const RECEIVING_TYPES = BOT_TYPES.filter((t) => !isOutboundOnly(t));
const OUTBOUND_ONLY_TYPES = BOT_TYPES.filter((t) => isOutboundOnly(t));

test("every platform declares its outbound shape", () => {
  // url-keyed: credentials travel in the URL/body, no caller-IP allowlist.
  assert.equal(outboundCapabilityFor("telegram").mode, "url-keyed");
  assert.equal(outboundCapabilityFor("feishu").mode, "url-keyed");
  // Proactive but IP-gated: an egress change breaks sending while credentials stay valid.
  assert.equal(outboundCapabilityFor("wecom").mode, "proactive-ip-gated");
  assert.equal(outboundCapabilityFor("wechat-oa").mode, "proactive-ip-gated");
  // Passive only: no unprompted send path exists at all.
  assert.equal(outboundCapabilityFor("wecom-bot").mode, "passive-window");
  // Slack sends through chat.postMessage with a bearer token — no IP gate.
  assert.equal(outboundCapabilityFor("slack").mode, "url-keyed");
});

test("no receiving platform is left undeclared", () => {
  // The derivation is the assertion: a platform added to BOT_TYPES without an
  // outbound declaration answers "none" and fails here, naming itself.
  for (const type of RECEIVING_TYPES) {
    const { mode } = outboundCapabilityFor(type);
    assert.ok(OUTBOUND_MODES.includes(mode), `${type}: ${mode} is not a known mode`);
    assert.notEqual(mode, "none", `${type} must declare a real outbound shape`);
  }
  assert.ok(RECEIVING_TYPES.length >= 1, "the derivation found no receiving platforms at all");
});

test("every declared mode is in the closed set", () => {
  for (const type of BOT_TYPES) {
    const { mode } = outboundCapabilityFor(type);
    assert.ok(OUTBOUND_MODES.includes(mode), `${type}: ${mode} is not a known mode`);
  }
});

test("inbound is true for every platform that can receive, and only for those", () => {
  for (const type of RECEIVING_TYPES) {
    assert.equal(outboundCapabilityFor(type).inbound, true, `${type} receives messages`);
  }
  // The reverse assertion (add-mattermost-channel 1.3): a type whose capability
  // says "cannot receive" must also be outbound-only. Two facts that disagree —
  // capability.inbound false while a webhook route is still registered — means
  // the declaration is lying about one of them.
  for (const type of BOT_TYPES) {
    const { inbound } = outboundCapabilityFor(type);
    assert.equal(
      inbound,
      !isOutboundOnly(type),
      `${type}: capability.inbound=${inbound} contradicts isOutboundOnly=${isOutboundOnly(type)}`,
    );
  }
  for (const type of OUTBOUND_ONLY_TYPES) {
    assert.equal(outboundCapabilityFor(type).inbound, false, `${type} cannot receive`);
  }
  // Slack specifically: it landed before the contract and must not regress into
  // the outbound-only bucket by accident.
  assert.ok(!OUTBOUND_ONLY_TYPES.includes("slack"), "slack receives messages");
});

test("an unknown type has no outbound path (never a guessed one)", () => {
  assert.deepEqual(outboundCapabilityFor("nope-not-a-platform"), { mode: "none", inbound: false });
  assert.deepEqual(outboundCapabilityFor(undefined), { mode: "none", inbound: false });
});

test("a generic channel row answers for the platform it was bound to", () => {
  // The row's own type says nothing about sending; the binding does.
  assert.equal(
    outboundCapabilityOfBot({ type: "channel", credentials: { platform: "wecom" } }).mode,
    "proactive-ip-gated",
  );
  assert.equal(
    outboundCapabilityOfBot({ type: "channel", credentials: { platform: "wecom-bot" } }).mode,
    "passive-window",
  );
  // Unbound channel row: awaiting-connection, so no outbound story yet.
  assert.equal(outboundCapabilityOfBot({ type: "channel", credentials: {} }).mode, "none");
  // A plain row defers to its own type.
  assert.equal(outboundCapabilityOfBot({ type: "telegram" }).mode, "url-keyed");
  assert.equal(outboundCapabilityOfBot({ type: "slack" }).mode, "url-keyed");
});
