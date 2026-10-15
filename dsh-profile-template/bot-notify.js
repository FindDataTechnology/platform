// bot-notify.js — the `bot_notify` face of the platform notify bridge
// (add-agent-notifications D1/D3). Pure module: the bridge
// (platform-notify-bridge.js) wires it to the JSON-RPC transport; tests drive
// it directly.
//
// The child may CALL bot_notify, but every decision — the deployment's bound
// channel, the per-agent rate bound, the relay credential — lives on the
// runner. This module only carries the call there and the answer back, over
// the two directions the SDK transport actually carries (the ask precedent,
// no reverse RPC):
//
//   1. `botNotify/send` NOTIFICATION (child → host): one per call, with a
//      fresh notifyId. The runner forwards accepted calls to the platform bot
//      relay with its own credentials and never sends the token down here.
//   2. `botNotify/result` REQUEST (host → child): resolves the pending call by
//      notifyId with the relay's outcome or failure shape, which the tool
//      returns to the calling turn. Unknown ids answer `{accepted:false}` —
//      a call that already timed out is gone from the table.

import { randomUUID } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";

// Per-call wait ceiling. The host's relay POST is bounded at 10s; this bounds
// the wait for the host's ANSWER, so a runner restart or a wedged host
// surfaces as a tool error instead of hanging the turn. Overridable like the
// ask window (DSH_ASK_FALLBACK_MS).
const NOTIFY_WAIT_MS = Number(process.env.DSH_NOTIFY_TIMEOUT_MS) || 30_000;

export class BotNotifyWire {
  #pending = new Map(); // notifyId → { resolve, timer }

  constructor({ notify, timeoutMs = NOTIFY_WAIT_MS, uuid = randomUUID }) {
    if (typeof notify !== "function") throw new Error("BotNotifyWire requires a notify(method, params) function");
    this.notify = notify;
    this.timeoutMs = timeoutMs;
    this.uuid = uuid;
  }

  // One tool call: park, notify the host, wait for the result request.
  request({ event, text, channel } = {}) {
    const notifyId = this.uuid();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(notifyId)) {
          resolve({ ok: false, reason: "timeout", message: "the platform did not answer the notification request in time" });
        }
      }, this.timeoutMs);
      timer.unref?.();
      this.#pending.set(notifyId, { resolve, timer });
      try {
        this.notify("botNotify/send", {
          notifyId,
          event,
          text,
          ...(typeof channel === "string" && channel ? { channel } : {}),
        });
      } catch (e) {
        // The transport write failed (child shutting down): settle now.
        clearTimeout(timer);
        this.#pending.delete(notifyId);
        resolve({ ok: false, reason: "transport", message: `the notification request could not be sent: ${e?.message || e}` });
      }
    });
  }

  // The host's result request: first settlement wins; a duplicate or an id
  // this wire never issued is answered accepted:false and changes nothing.
  settle(params) {
    const notifyId = typeof params?.notifyId === "string" ? params.notifyId : "";
    const entry = this.#pending.get(notifyId);
    if (entry === undefined) return { accepted: false, reason: "unknown or already-settled notify" };
    this.#pending.delete(notifyId);
    clearTimeout(entry.timer);
    const { notifyId: _id, ...result } = params ?? {};
    entry.resolve(result);
    return { accepted: true };
  }

  // Shutdown ladder: every parked call settles with a structured failure so no
  // tool call outlives the runtime it was made in.
  shutdown() {
    for (const [notifyId, entry] of this.#pending) {
      clearTimeout(entry.timer);
      this.#pending.delete(notifyId);
      entry.resolve({ ok: false, reason: "shutdown", message: "the agent runtime is shutting down" });
    }
  }
}

function textBlocks(lines) {
  // Only {type:"text"} blocks reach the model (observed live in the
  // chart-bind bridge: a plain string render is dropped).
  return lines.map((line) => ({ type: "text", text: line }));
}

// The model-facing tool. Its ONLY side effect is the wire call: `execute`
// returns the platform's answer verbatim, so a refusal reaches the turn as
// data the agent can act on (report it, retry later, stop notifying).
export function createBotNotifyTool({ wire }) {
  return defineTool({
    name: "bot_notify",
    description:
      "Send a short operational notification to the chat channel this deployment binds — for humans " +
      "(operators watching a chat), not the current conversation. Use it for standing-agent events your " +
      "pack defines, e.g. ticket_done / pr_opened / gate_changed / handoff_needed. The deployment binds at " +
      "most one channel; omit `channel` or pass the bound name. If the call is refused, the result names why " +
      "(no binding, rate limit, relay failure) — report that instead of retrying blindly.",
    parameters: {
      event: {
        type: "string",
        required: true,
        description: "Short stable event key identifying what happened (e.g. ticket_done, pr_opened, gate_changed, handoff_needed).",
      },
      text: {
        type: "string",
        required: true,
        description: "One short plain-text message body; the platform prepends `[event]` when it delivers.",
      },
      channel: {
        type: "string",
        description: "Optional channel name; when given it must equal this deployment's bound channel, or the call is refused.",
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
          status: { type: "number" },
        },
      },
      render: (args, value) => {
        if (value?.ok) {
          return textBlocks([`Notification delivered to the bound channel (event: ${args?.event ?? "?"}).`]);
        }
        return textBlocks([
          `The notification was not delivered: ${value?.message || value?.reason || "unknown reason"}.`,
          "Report this to the user; do not retry in a loop.",
        ]);
      },
    },
    async execute(args) {
      return wire.request({
        event: args?.event,
        text: args?.text,
        channel: args?.channel,
      });
    },
  });
}