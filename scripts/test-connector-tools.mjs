// Unit tests — the facade child's connector face
// (add-served-agent-connector-access D2).
// Run: node --test scripts/test-connector-tools.mjs
//
// Two things are being pinned:
//
//   1.x  the wire is a pure two-direction carrier: one notification out with a
//        fresh callId, one answer in by that callId. Timeout and shutdown both
//        resolve (a hung tool would stall the turn), and an unknown id is
//        reported rather than silently swallowed.
//   2.x  the tools say what they mean: `connector_bindings` lists, `connector_call`
//        forwards exactly {binding, tool, arguments} — and its rendered text
//        tells the truth about WHO the call ran as. A model that renders "done
//        for you" after a deployer fallback is the failure this feature exists
//        to prevent.

import test from "node:test";
import assert from "node:assert/strict";
import { ConnectorWire, createConnectorTools } from "../dsh-profile-template/connector-tools.js";

/** A wire whose host side is a scripted callback. */
function wired(hostHandler, opts = {}) {
  const sent = [];
  const wire = new ConnectorWire({
    notify: (method, params) => {
      sent.push({ method, params });
      // Answer asynchronously, the way the real transport does.
      setImmediate(() => hostHandler(params, wire));
    },
    ...opts,
  });
  return { wire, sent };
}

test("1.1 a call sends one notification and resolves with the host's answer", async () => {
  const { wire, sent } = wired((params, w) => w.settle({ callId: params.callId, ok: true, text: "hi" }));
  const out = await wire.request({ op: "call", args: { binding: "shopify" } });
  assert.deepEqual(out, { ok: true, text: "hi" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "connectorCall/send");
  assert.equal(typeof sent[0].params.callId, "string");
  assert.deepEqual(sent[0].params.args, { binding: "shopify" });
});

test("1.2 each call gets its own callId, so concurrent visitors never cross answers", async () => {
  const { wire, sent } = wired((params, w) =>
    w.settle({ callId: params.callId, ok: true, text: params.args?.binding }),
  );
  const [a, b] = await Promise.all([
    wire.request({ op: "call", args: { binding: "a" } }),
    wire.request({ op: "call", args: { binding: "b" } }),
  ]);
  assert.equal(a.text, "a");
  assert.equal(b.text, "b");
  assert.notEqual(sent[0].params.callId, sent[1].params.callId);
});

test("1.3 a timeout resolves a failure — a hung host must not stall the turn", async () => {
  const { wire } = wired(() => {}, { timeoutMs: 10 });
  const out = await wire.request({ op: "call", args: {} });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "timeout");
});

test("1.4 shutdown resolves every pending call", async () => {
  const { wire } = wired(() => {});
  const pending = wire.request({ op: "call", args: {} });
  wire.shutdown();
  const out = await pending;
  assert.equal(out.ok, false);
  assert.equal(out.reason, "shutdown");
});

test("1.5 settling an unknown id is reported, not swallowed", () => {
  const wire = new ConnectorWire({ notify: () => {} });
  assert.deepEqual(wire.settle({ callId: "nope", ok: true }), { accepted: false, reason: "unknown or already-settled call" });
  // Double-settle of a real id is the same refusal.
  let id;
  const w2 = new ConnectorWire({ notify: (_m, p) => { id = p.callId; } });
  w2.request({ op: "list" });
  assert.equal(w2.settle({ callId: id, ok: true }).accepted, true);
  assert.equal(w2.settle({ callId: id, ok: true }).accepted, false);
});

test("1.6 a notify that throws resolves a transport failure instead of hanging", async () => {
  const wire = new ConnectorWire({
    notify: () => {
      throw new Error("pipe closed");
    },
  });
  const out = await wire.request({ op: "call" });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "transport");
});

test("2.1 the face exposes exactly the two tools, named as the model expects", () => {
  const { wire } = wired(() => {});
  const tools = createConnectorTools({ wire });
  assert.deepEqual(tools.map((t) => t.name), ["connector_bindings", "connector_call"]);
  for (const tool of tools) assert.equal(typeof tool.execute, "function");
});

test("2.2 connector_call forwards exactly binding, tool and arguments", async () => {
  const { wire, sent } = wired((params, w) => w.settle({ callId: params.callId, ok: true, text: "ok", executedAs: "actor" }));
  const tools = createConnectorTools({ wire });
  const call = tools.find((t) => t.name === "connector_call");
  await call.execute({ binding: "shopify", tool: "shopify.list_orders", arguments: { limit: 3 } });
  assert.deepEqual(sent[0].params.args, {
    binding: "shopify",
    tool: "shopify.list_orders",
    arguments: { limit: 3 },
  });
  // Nothing identity-shaped may leave the child.
  assert.deepEqual(Object.keys(sent[0].params.args).sort(), ["arguments", "binding", "tool"]);
});

test("2.3 the rendered text tells the truth about who the call ran as", async () => {
  const render = (result) => {
    const { wire } = wired(() => {});
    const call = createConnectorTools({ wire }).find((t) => t.name === "connector_call");
    return call.output.render({}, result)[0].text;
  };
  assert.match(render({ ok: true, executedAs: "actor", text: "done" }), /as the visitor/);
  assert.match(render({ ok: true, executedAs: "deployer", reason: "visitor_identity_absent" }), /no connector identity/);
  assert.match(render({ ok: true, executedAs: "deployer", reason: "no_visitor_scope" }), /no visitor on this turn/);
});

test("2.4 a refusal renders the hint, and never reads as success", () => {
  const { wire } = wired(() => {});
  const call = createConnectorTools({ wire }).find((t) => t.name === "connector_call");
  const text = call.output.render(
    {},
    { ok: false, code: "actor_unregistered", hint: "Sign in to the connector once." },
  )[0].text;
  assert.match(text, /was not made/);
  assert.match(text, /Sign in to the connector once/);
  assert.doesNotMatch(text, /answered/);
});

test("2.5 the list tool renders keys, and says plainly when there are none", () => {
  const { wire } = wired(() => {});
  const list = createConnectorTools({ wire }).find((t) => t.name === "connector_bindings");
  assert.match(list.output.render({}, { ok: true, bindings: [{ key: "shopify" }, { key: "wms" }] })[0].text, /shopify, wms/);
  assert.match(list.output.render({}, { ok: true, bindings: [] })[0].text, /no connector bindings/);
});
