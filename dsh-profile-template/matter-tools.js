// matter-tools.js — the facade reception's matter face (add-matter-threads
// D2/D3). Pure module: the matters bridge (platform-matters-bridge.js) wires
// it to the JSON-RPC transport; tests drive it directly.
//
// The child may CALL matter_open / matter_status / matter_read, but every
// decision — the facet route, the service credential, the per-agent open
// bound — lives on the runner. This module only carries the call there and
// the answer back, over the two directions the SDK transport carries (the
// bot-notify precedent, no reverse RPC):
//
//   1. `matterCall/send` NOTIFICATION (child → host): one per call, with a
//      fresh callId and the op + args. The runner validates, applies its
//      bounds, calls the facet's internal route with its own credential, and
//      never sends the token down here.
//   2. `matterCall/result` REQUEST (host → child): resolves the pending call
//      by callId with the facet's outcome or failure shape, which the tool
//      returns to the calling turn. Unknown ids answer `{ok:false}` — a call
//      that already timed out is gone from the table.

import { randomUUID } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";

const MATTER_WAIT_MS = Number(process.env.DSH_MATTER_TIMEOUT_MS) || 30_000;

export class MatterWire {
  #pending = new Map(); // callId → { resolve, timer }

  constructor({ notify, timeoutMs = MATTER_WAIT_MS, uuid = randomUUID } = {}) {
    if (typeof notify !== "function") throw new Error("MatterWire requires a notify(method, params) function");
    this.notify = notify;
    this.timeoutMs = timeoutMs;
    this.uuid = uuid;
  }

  request({ op, args = {} } = {}) {
    const callId = this.uuid();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(callId)) {
          resolve({ ok: false, reason: "timeout", message: "the platform did not answer the matter request in time" });
        }
      }, this.timeoutMs);
      timer.unref?.();
      this.#pending.set(callId, { resolve, timer });
      try {
        this.notify("matterCall/send", { callId, op, args });
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(callId);
        resolve({ ok: false, reason: "transport", message: `the matter request could not be sent: ${e?.message || e}` });
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

function textBlocks(lines) {
  return lines.map((line) => ({ type: "text", text: line }));
}

// The model-facing trio. execute's only side effect is the wire call — a
// refusal reaches the turn as data the reception can act on (tell the visitor
// honestly, retry later, stop).
export function createMatterTools({ wire }) {
  const open = defineTool({
    name: "matter_open",
    description:
      "Open a matter (事项) for the principal who owns this facade — use it when the visitor's question must " +
      "reach a human (pricing, contracts, external commitments, or an explicit request to talk to the owner). " +
      "The matter lands in the owner's queue with your summary; the visitor can ask you later for its status. " +
      "If the call is refused, the result names why (rate limit, platform failure) — tell the visitor honestly instead of retrying blindly.",
    parameters: {
      summary: {
        type: "string",
        required: true,
        description: "The visitor's question and the context the owner needs, in the visitor's language. At most 2000 characters.",
      },
      visitor_hint: {
        type: "string",
        description: "Optional: how the owner can reach or recognize the visitor (a name or contact the visitor stated in conversation, or the session reference). At most 300 characters.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          reason: { type: "string" },
          message: { type: "string" },
          id: { type: "string" },
          status: { type: "string" },
          httpStatus: { type: "number" },
        },
      },
      render: (_args, value) => {
        if (value?.ok) {
          return textBlocks([`Matter opened: ${value.id} (${value.status}). Give the visitor this reference.`]);
        }
        return textBlocks([`The matter could not be opened: ${value?.message || value?.reason || "unknown reason"}.`]);
      },
    },
    async execute(args) {
      return wire.request({ op: "open", args: { summary: args?.summary, visitor_hint: args?.visitor_hint } });
    },
  });

  const status = defineTool({
    name: "matter_status",
    description:
      "List this deployment's matters (newest activity first, open ones first) — use it when a visitor asks how " +
      "their matter is going, or before opening a new one to check for an existing thread.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          reason: { type: "string" },
          message: { type: "string" },
          matters: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                summary: { type: "string", required: true },
                status: { type: "string", required: true },
                visitorHint: { type: "string" },
                updatedAt: { type: "number", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value?.ok) return textBlocks([`Matter status could not be read: ${value?.message || value?.reason || "unknown reason"}.`]);
        if (!value.matters?.length) return textBlocks(["No matters on this deployment."]);
        return textBlocks(value.matters.map((m) => `${m.id} [${m.status}] ${m.summary.slice(0, 80)}`));
      },
    },
    async execute() {
      return wire.request({ op: "status" });
    },
  });

  const read = defineTool({
    name: "matter_read",
    description:
      "Read one matter's full timeline, including the owner's replies — use it to relay the owner's answer to the " +
      "visitor verbatim. The id is the mt_… reference given when the matter was opened (or seen in matter_status).",
    parameters: {
      id: { type: "string", required: true, description: "The mt_… matter id." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          reason: { type: "string" },
          message: { type: "string" },
          matter: { type: "object", additionalProperties: true },
          httpStatus: { type: "number" },
        },
      },
      render: (_args, value) => {
        if (!value?.ok) return textBlocks([`The matter could not be read: ${value?.message || value?.reason || "unknown reason"}.`]);
        const m = value.matter;
        return textBlocks([
          `${m.id} [${m.status}] ${m.summary.slice(0, 80)}`,
          ...m.timeline.map((e) => `${e.by} (${e.kind}): ${String(e.text ?? "").slice(0, 160)}`),
        ]);
      },
    },
    async execute(args) {
      return wire.request({ op: "read", args: { id: args?.id } });
    },
  });

  return [open, status, read];
}
