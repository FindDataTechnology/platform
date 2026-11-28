// ── Notification MCP server (add-broadcast-and-notification-inbox 3.1/3.2/3.3) ─
//
// Exposes the recipient's own inbox to the agent. Same shape as
// `input-request-mcp.js` / `handoff-mcp.js`: a very thin stdio child plus a
// loopback REST bridge; identity comes from the per-user profile's env, so the
// model can never declare who it is.
//
// Why a separate server rather than more tools on `handoff-mcp`: that one means
// "hand this conversation to a human". Reading and acting on your own notices is
// a different capability, and mixing them would make both tool descriptions lie.
//
// The action discipline (design D5) is the point of this file: acting on a
// notice runs it through the action gate, which applies the platform's own
// preflight / mandate / risk tier. Nothing here decides whether the caller may
// do it — it asks the platform and relays the verdict verbatim as data.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const OWNER_EMAIL_ENV = "NOTIFY_OWNER_EMAIL";
export const BRIDGE_URL_ENV = "NOTIFY_BRIDGE_URL";

export function ownerEmailFromEnv(env = process.env) {
  const v = String(env[OWNER_EMAIL_ENV] || "").trim().toLowerCase();
  return v || null;
}

function bridgeOrigin(env = process.env) {
  if (env[BRIDGE_URL_ENV]) return String(env[BRIDGE_URL_ENV]).replace(/\/+$/, "");
  const raw = env.HOST || "localhost";
  const host = raw === "0.0.0.0" || raw === "::" ? "127.0.0.1" : raw;
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `http://${bracketed}:${env.PORT || 3000}`;
}

async function call(origin, method, path, body, { timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export const TOOLS = [
  {
    name: "notify_inbox_list",
    description:
      "List the notifications waiting in YOUR inbox. Each notice carries a `ref` " +
      "(the real object it is about: {kind, id}) and sometimes an `action` " +
      "({actionId, args}) you can execute directly instead of guessing what to do. " +
      "Use this when the turn is a wake-up/notification event, or when the owner asks " +
      "what is waiting. Returns { notifications: [...], unread }.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Optional filter: only notices from this source (e.g. 'broadcast').",
        },
        state: {
          type: "string",
          enum: ["unread", "read", "acted"],
          description: "Optional filter by state. Omit to see everything not yet acted on.",
        },
        limit: { type: "number", description: "Maximum rows to return (default 50)." },
      },
    },
  },
  {
    name: "notify_inbox_act",
    description:
      "Execute a notice's `action` for a notification id, then mark that notice acted. " +
      "The action names a REGISTERED platform action; it runs through the same admission " +
      "gate (preflight, mandate, risk tier) as calling that action directly — this tool " +
      "adds no authority of its own. An action above the read tier comes back `pending`: " +
      "the owner still has to approve it. If the platform refuses, the refusal is returned " +
      "verbatim: report it, do not retry with different arguments to get around it.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "The notification id (from notify_inbox_list)." },
      },
    },
  },
];

export function httpDriver({ ownerEmail, origin }) {
  return {
    async list({ source, state, limit } = {}) {
      const qs = new URLSearchParams();
      if (source) qs.set("source", String(source));
      if (state) qs.set("state", String(state));
      qs.set("limit", String(Math.min(Number(limit) || 50, 200)));
      // The bridge trusts loopback + the injected identity, exactly like the
      // other first-party MCP children: the owner is in the URL because this
      // process has no way to hold a browser session.
      return call(origin, "GET", `/api/notify/inbox/${encodeURIComponent(ownerEmail)}?${qs}`);
    },
    async act({ id } = {}) {
      return call(
        origin,
        "POST",
        `/api/notify/inbox/${encodeURIComponent(ownerEmail)}/${encodeURIComponent(String(id))}/act`,
        {},
      );
    },
  };
}

export async function createServer({
  identity = () => ({ ownerEmail: ownerEmailFromEnv(), origin: bridgeOrigin() }),
  driverFactory = httpDriver,
} = {}) {
  const server = new Server({ name: "notify-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return runTool({ name, args, identity: identity(), driverFactory });
  });

  return server;
}

/**
 * One tool call, separated from the SDK so the identity rule is testable without
 * driving a protocol handshake. Exported for exactly that reason.
 */
export async function runTool({ name, args, identity, driverFactory = httpDriver }) {
  const who = identity;
  const ownerEmail = who?.ownerEmail ?? null;
  if (!ownerEmail) {
    // No identity means no inbox of its own to read. A clear failure beats a
    // call that the platform would reject anyway and the model would read as
    // "the platform is broken".
    return {
      content: [
        {
          type: "text",
          text: `notifications are not available on this surface: no owner identity was injected (${OWNER_EMAIL_ENV} is empty).`,
        },
      ],
      isError: true,
    };
  }
  const driver = driverFactory({ ownerEmail, origin: who?.origin ?? bridgeOrigin() });
  try {
    if (name === "notify_inbox_list") {
      const out = await driver.list(args ?? {});
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
    if (name === "notify_inbox_act") {
      const out = await driver.act(args ?? {});
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  } catch (err) {
    return { content: [{ type: "text", text: `${name} failed: ${err.message}` }], isError: true };
  }
}

async function run() {
  // Same reason as the sibling MCP children: a stdio child must never let a
  // library write onto stdout — it is the MCP frame channel.
  console.log = (...args) => console.error(...args);
  const server = await createServer();
  await server.connect(new StdioServerTransport());
}

const launchedDirectly = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (launchedDirectly) {
  run().catch((err) => {
    console.error("[notify-mcp] failed to start:", err);
    process.exit(1);
  });
}
