// Stub stdio MCP server for the add-crm-desk-bridge executor tests: one tool,
// `messages_create`, whose behavior is steered by STUB_MODE so each failure
// taxonomy branch is a mode flip instead of a separate server.
//   ok    (default) → "Message created (stub)"
//   401   → isError "Chatwoot API error: 401 Unauthorized"
//   422   → isError "Chatwoot API error: 422 Unprocessable Entity"
//   plain → isError "Email has already been taken" (joined-errors wording, no status)
//   echo  → JSON echo of the received args (argKeys filtering assertions)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "stub-crm", version: "0" });

server.registerTool(
  "messages_create",
  {
    description: "stub messages_create",
    inputSchema: {
      account_id: z.number(),
      conversation_id: z.number(),
      content: z.string(),
    },
  },
  async (args) => {
    const mode = process.env.STUB_MODE || "ok";
    if (mode === "401") {
      return { content: [{ type: "text", text: "Chatwoot API error: 401 Unauthorized" }], isError: true };
    }
    if (mode === "422") {
      return { content: [{ type: "text", text: "Chatwoot API error: 422 Unprocessable Entity" }], isError: true };
    }
    if (mode === "plain") {
      return { content: [{ type: "text", text: "Email has already been taken" }], isError: true };
    }
    if (mode === "echo") {
      return { content: [{ type: "text", text: JSON.stringify({ receivedArgs: args }) }] };
    }
    return { content: [{ type: "text", text: "Message created (stub)" }] };
  },
);

await server.connect(new StdioServerTransport());
