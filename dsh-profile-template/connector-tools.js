// connector-tools.js — the facade reception's connector face
// (add-served-agent-connector-access D2). Pure module: the connector bridge
// (platform-connector-bridge.js) wires it to the JSON-RPC transport; tests
// drive it directly.
//
// A served agent must be able to reach the connectors its deployer bound, but
// it must NOT hold the credential: that token authenticates the deployer, and
// these turns belong to whoever is visiting. So the child names a binding and a
// tool, the runner decides who is on the other end of THIS turn, and the
// platform calls the connector as that person.
//
// Same two directions as the matter wire (no reverse RPC):
//   1. `connectorCall/send` NOTIFICATION (child → host): one per call, with a
//      fresh callId, the op, and the args.
//   2. `connectorCall/result` REQUEST (host → child): resolves the pending call
//      by callId with the platform's outcome or its refusal — including the
//      hint that says who has to act ("sign in once", "ask the operator").
//
// The token, the connector origin, the visitor's identity: none of that exists
// down here. A refusal arrives as data the model can relay honestly.

import { randomUUID } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";

const CONNECTOR_WAIT_MS = Number(process.env.DSH_CONNECTOR_TIMEOUT_MS) || 60_000;

export class ConnectorWire {
  #pending = new Map();

  constructor({ notify, timeoutMs = CONNECTOR_WAIT_MS, uuid = randomUUID } = {}) {
    if (typeof notify !== "function") throw new Error("ConnectorWire requires a notify(method, params) function");
    this.notify = notify;
    this.timeoutMs = timeoutMs;
    this.uuid = uuid;
  }

  request({ op, args = {} } = {}) {
    const callId = this.uuid();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(callId)) {
          resolve({ ok: false, reason: "timeout", message: "the platform did not answer the connector request in time" });
        }
      }, this.timeoutMs);
      timer.unref?.();
      this.#pending.set(callId, { resolve, timer });
      try {
        this.notify("connectorCall/send", { callId, op, args });
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(callId);
        resolve({ ok: false, reason: "transport", message: `the connector request could not be sent: ${e?.message || e}` });
      }
    });
  }

  settle(params) {
    const callId = typeof params?.callId === "string" ? params.callId : "";
    const entry = this.#pending.get(callId);
    if (entry === undefined) return { accepted: false, reason: "unknown or already-settled call" };
    this.#pending.delete(callId);
    clearTimeout(entry.timer);
    const { callId: _id, ...result } = params ?? {};
    entry.resolve(result);
    return { accepted: true };
  }

  shutdown() {
    for (const [callId, entry] of this.#pending) {
      clearTimeout(entry.timer);
      this.#pending.delete(callId);
      entry.resolve({ ok: false, reason: "shutdown", message: "the agent runtime is shutting down" });
    }
  }
}

const textBlocks = (lines) => lines.map((line) => ({ type: "text", text: line }));

// One tool, two ops. Listing is separate because a model that has to guess a
// binding key will guess wrong and then blame the connector.
export function createConnectorTools({ wire }) {
  const list = defineTool({
    name: "connector_bindings",
    description:
      "List the connectors this deployment can reach. Call it before connector_call if you do not already know " +
      "the binding key. A binding is a SaaS account the deployer connected; calls made on a signed-in visitor's " +
      "turn run with THAT visitor's authorization, and on an anonymous turn with the deployer's.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          reason: { type: "string" },
          message: { type: "string" },
          bindings: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { key: { type: "string", required: true } },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value?.ok) return textBlocks([`Connectors could not be listed: ${value?.message || value?.reason || "unknown reason"}.`]);
        if (!value.bindings?.length) return textBlocks(["This deployment has no connector bindings."]);
        return textBlocks([`Available connector bindings: ${value.bindings.map((b) => b.key).join(", ")}`]);
      },
    },
    async execute() {
      return wire.request({ op: "list" });
    },
  });

  const call = defineTool({
    name: "connector_call",
    description:
      "Call one tool on a connected SaaS/connector account. `binding` is a binding key from connector_bindings; " +
      "`tool` is the connector-side tool name; `arguments` is that tool's own input object. " +
      "If the call is refused, the result says who must fix what (a visitor may need to sign in once; the " +
      "operator may need to enable delegation) — relay that to the visitor instead of retrying blindly. " +
      "Never claim an action was performed as the visitor when the result says it ran as the deployer.",
    parameters: {
      binding: { type: "string", required: true, description: "The binding key, e.g. from connector_bindings." },
      tool: { type: "string", required: true, description: "The connector-side tool name to call." },
      arguments: { type: "object", additionalProperties: true, description: "The connector tool's input object." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          reason: { type: "string" },
          message: { type: "string" },
          hint: { type: "string" },
          code: { type: "string" },
          executedAs: { type: "string" },
          text: { type: "string" },
          httpStatus: { type: "number" },
        },
      },
      render: (_args, value) => {
        if (!value?.ok) {
          const why = value?.hint || value?.message || value?.code || "unknown reason";
          return textBlocks([`The connector call was not made: ${why}`]);
        }
        const as = value.executedAs === "actor"
          ? "as the visitor"
          : value.reason === "visitor_identity_absent"
            ? "as the deployer (this visitor has no connector identity)"
            : "as the deployer (no visitor on this turn)";
        return textBlocks([`Connector answered (${as}).`, value.text ?? ""].filter(Boolean));
      },
    },
    async execute(args) {
      return wire.request({
        op: "call",
        args: { binding: args?.binding, tool: args?.tool, arguments: args?.arguments },
      });
    },
  });

  return [list, call];
}
