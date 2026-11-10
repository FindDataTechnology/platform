// ── Bench proposal MCP server (stdio) ────────────────────────────────────────
//
// One tool: `bench_proposal_submit`. It exists so the ontology fleet's proposal
// post has a single outlet to 知验台's domain inbox instead of pushing drafts
// into 柏讯's per-tenant action gate (openspec:
// switch-fleet-proposals-to-domain-inbox).
//
// Why a tool and not a prompt-only convention: the prompt can be rewritten
// freely, but a tool is the thing that is actually enforced — there is no
// second path to bench writes from a fleet turn, and this child does no writes
// of its own beyond the one POST (the peer's two gates authorize it).
//
// Attribution stays honest: the post passes its own identity line
// (`fleet:<fleet_id>/<post_id>`) as `source`, which the peer needs both for the
// idempotency key and for its self-confirmation ban. There is deliberately no
// env fallback for it — no such env exists, and inventing one would produce a
// stable-looking identity that nothing provisions. The tool never invents a
// domain either: it comes from BENCH_PROPOSAL_DOMAIN.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BenchProposalError,
  submitProposal,
} from "../lib/bench-proposal-client.js";

// The stdio channel IS the protocol: stdout carries JSON-RPC and nothing else.
console.log = (...args) => console.error(...args);

const TOOL = {
  name: "bench_proposal_submit",
  description:
    "Submit one ontology draft to this domain's proposal inbox in the bench " +
    "platform (知验台). Use it for every entity/relation declaration your round " +
    "produces; do NOT propose ontology drafts through a customer action gate. " +
    "Returns {id, state, created}. created=false means the inbox already held " +
    "this pending key — report it as an idempotent hit, not as new. A refusal " +
    "is final for the round: 400 needs new evidence or a vocabulary-correct " +
    "kind, 403 means the credential is not an expert of this domain. Evidence " +
    "is mandatory: a draft with nothing to check is refused by the peer.",
  inputSchema: {
    type: "object",
    required: ["source", "kind", "external_key", "body", "evidence"],
    properties: {
      kind: {
        type: "string",
        description:
          "Entity type or relationship kind, exactly as the domain template " +
          "declares it (out-of-vocabulary kinds are refused).",
      },
      external_key: {
        type: "string",
        description:
          "The business key. Relationships use {from_key}->{kind}:{to_key}.",
      },
      body: { type: "string", description: "The declaration's prose body." },
      evidence: {
        type: ["object", "array", "string"],
        description:
          "What a reviewer checks to confirm this. Never empty. Relationship " +
          "drafts must carry from_key and to_key here — the peer derives the " +
          "relationship key from them.",
      },
      impact: {
        type: "string",
        description: "Optional note on what confirming this changes.",
      },
      source: {
        type: "string",
        description:
          "Stable submitter identity across rounds — 'fleet:<fleet_id>/<post_id>' " +
          "from your identity line. Required: it is half of the idempotency key.",
      },
      submitted_by: {
        type: "string",
        description:
          "Optional attribution override. The peer refuses self-confirmation, " +
          "so this must name the post, not the confirming human.",
      },
    },
  },
};

function errOut(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function okOut(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

// The identity line lives in the turn prompt (`fleet=<id>; post=<ref>; …`,
// rendered by fleet-reports.js), not in the environment — one MCP child serves
// every post in the cell, so an env value could only ever name the wrong post.
// The post therefore passes its own `<id>/<ref>` pair explicitly and this
// module refuses to invent one.

export async function toolSubmit(args = {}, opts = {}) {
  const env = opts.env ?? process.env;
  const source = String(args.source || "").trim();
  const draft = {
    source,
    kind: args.kind,
    externalKey: args.external_key,
    body: args.body,
    evidence: args.evidence,
    impact: args.impact,
    submittedBy: args.submitted_by || source,
  };
  if (!draft.source) {
    return errOut(
      "source is required: pass 'fleet:<fleet_id>/<post_id>' from your identity " +
        "line — it is half of the idempotency key",
    );
  }
  if (!/^[^\s]+$/.test(draft.source)) {
    return errOut("source must be a single token with no whitespace");
  }
  try {
    const out = await submitProposal(draft, { env, transport: opts.transport });
    return okOut({
      id: out.id,
      state: out.state,
      external_key: out.externalKey,
      created: out.created,
      // The one line the round report should carry.
      result: out.created ? "新增" : "幂等命中",
    });
  } catch (err) {
    if (err instanceof BenchProposalError) {
      // kind + retryable are what the round's reporter needs to stop correctly.
      return errOut(
        `${err.kind}${err.retryable ? " (retryable)" : ""}: ${err.message}`,
      );
    }
    return errOut(`submit failed: ${err?.message || err}`);
  }
}

export const server = new Server(
  { name: "bench-proposal-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [TOOL] }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params ?? {};
  if (name !== TOOL.name) return errOut(`unknown tool: ${name}`);
  return toolSubmit(args);
});

// Only start stdio when launched as the MCP child; importing the module (tests,
// tooling) must stay side-effect free. Same guard as fleet-mcp/actions-mcp.
const launchedDirectly = (() => {
  try {
    return (
      process.argv[1] &&
      import.meta.url === pathToFileURL(resolve(process.argv[1])).href
    );
  } catch {
    return false;
  }
})();

if (launchedDirectly) {
  await server.connect(new StdioServerTransport());
}
