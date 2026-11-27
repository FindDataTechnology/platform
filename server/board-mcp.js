// ── Board read MCP server (stdio) — unify-copilot-workbench 1.6 ─────────────
//
// One read tool: `board_read`. A copilot that can propose but cannot look is
// guessing; the action-gate spec allows read tools on its face precisely so
// the copilot can have evidence before proposing. This is the first such tool
// (the registry had zero `read` entries before this change).
//
// Deliberately ONE tool, not one per block type: block kinds grow with the
// catalog (this same change adds `chart`), and a tool per kind would make the
// tool face drift every time the data model does. Kind lives in the return
// value, not in the function name.
//
// Shape (design D3): no `blockId` → the map only (what blocks exist, which tab,
// what order in the user's view). With `blockId` → that block's data too. The
// split matters: a wire board is four upstream calls, so a default that fetched
// everything would turn every copilot turn into silent load on the line's API.
//
// Same posture as library-mcp.js: direct import, short reads under WAL, no new
// HTTP surface and no new loopback bridge. Identity is the per-user profile's
// env (the ACTIONS_MCP_PROPOSER_EMAIL precedent) because a stdio child has no
// session of its own — the server never guesses whose board it is.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as db from "../db.js";
import {
  defaultViewFromCatalog,
  getBoardAdapter,
  listBoardLines,
  storedViewOrNull,
} from "../lib/board-adapters.js";

// stdout is the JSON-RPC channel; db.js logs its open line via console.log.
console.log = (...args) => console.error(...args);

export const BOARD_MCP_USER_EMAIL = "BOARD_MCP_USER_EMAIL";

function userEmailFromEnv(env = process.env) {
  const v = String(env[BOARD_MCP_USER_EMAIL] || "").trim().toLowerCase();
  return v || null;
}

const TOOLS = [
  {
    name: "board_read",
    description:
      "Read the board the user is currently looking at. Without blockId this returns " +
      "the catalog (which blocks exist, each block's kind, tab and title) and the " +
      "user's current view order — NOT the block data, so it is cheap. Pass blockId " +
      "to also get that block's data. Use this before proposing anything about the " +
      "board; do not guess what is on it.",
    inputSchema: {
      type: "object",
      properties: {
        line: {
          type: "string",
          description: `Board line. One of: ${listBoardLines().join(", ")}. Defaults to the line the copilot was opened from when the host supplied one.`,
        },
        blockId: {
          type: "string",
          description: "Optional: also return this block's data.",
        },
      },
    },
  },
];

export async function createServer({ email = userEmailFromEnv(), defaultLine = null } = {}) {
  const server = new Server({ name: "board-read-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name !== "board_read") {
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    }
    const line = String(args?.line || defaultLine || "").trim();
    if (!line) {
      return {
        content: [{ type: "text", text: `line required (one of: ${listBoardLines().join(", ")})` }],
        isError: true,
      };
    }
    const adapter = getBoardAdapter(line);
    if (!adapter) {
      return {
        content: [{ type: "text", text: `该线尚未接入: ${line}（可用: ${listBoardLines().join(", ")}）` }],
        isError: true,
      };
    }

    try {
      const result = await adapter.fetchBlocks({ email });
      if (result?.connected === false) {
        // Connected-ness is data the copilot must not paper over: the honest
        // answer is "the user has not connected this line", not an empty board.
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                line,
                connected: false,
                reason: result.reason ?? "not_connected",
                connectPath: result.connectPath ?? null,
                note: "用户尚未连接该线凭据；看板没有数据可读。",
              }),
            },
          ],
        };
      }
      const catalog = Array.isArray(result?.blocks) ? result.blocks : [];
      const view = storedViewOrNull(db.getPreference, line) ?? defaultViewFromCatalog(catalog);
      const summary = catalog.map((b) => ({
        id: b.id,
        type: b.type ?? null,
        tab: b.tab ?? null,
        title: b.title ?? null,
        unavailable: Boolean(b.error),
      }));
      const payload = { line, title: adapter.title, connected: true, catalog: summary, view };

      const blockId = typeof args?.blockId === "string" ? args.blockId.trim() : "";
      if (blockId) {
        const block = catalog.find((b) => b.id === blockId);
        if (!block) {
          // Naming the miss is the point: silently returning no data reads as
          // "the block is empty", which is a different (and false) claim.
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `块不存在: ${blockId}`,
                  availableBlocks: summary.map((b) => b.id),
                }),
              },
            ],
            isError: true,
          };
        }
        payload.block = {
          id: block.id,
          type: block.type ?? null,
          title: block.title ?? null,
          tab: block.tab ?? null,
          error: block.error ?? null,
          data: block.data ?? null,
          links: block.links ?? [],
          actions: (block.actions ?? []).map((a) => ({ id: a.id, label: a.label })),
        };
      }

      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `board_read failed: ${err?.message || err}` }], isError: true };
    }
  });

  return server;
}

// Entry point when spawned as a child (mcp.json → node server/board-mcp.js).
if (import.meta.url === `file://${process.argv[1]}`) {
  await db.initDb();
  const server = await createServer();
  await server.connect(new StdioServerTransport());
}
