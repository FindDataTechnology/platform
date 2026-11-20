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

//: 两种模式对同一个 403 的解释不同，而工具描述是岗位唯一会读的那段文字。
//: session：403＝这枚人的凭据不是本域专家；machine：403＝这次 source 不是本令牌的登记。
//: 写成一句「凭据不是专家」会把机器面的岗位引去申请权限，而该改的是 source。
const PROPOSAL_MODE = String(process.env.BENCH_PROPOSAL_MODE || "session").trim() || "session";

//: 机器面下进程自己就带着 BENCH_FLEET_REF（envRefs 转发）——工具描述把它**原样报出来**，
//: 岗位不再需要从「fleet:<fleet_id>/<post_id>」这种占位写法里猜自己是谁
//: （task 3.3：提示词里只有 {{fleetContext}}，岗位不知道自己的 fleet_id）。
//: 在役舰队的 persona 是建队时浇铸的、改不到，所以这句话必须长在工具描述里——
//: 它随镜像出片就到达所有挂这个面的岗位，不依赖任何舰队重建。
const MACHINE_REF = String(process.env.BENCH_FLEET_REF || "").trim();
const MACHINE_PREFIX = MACHINE_REF ? `fleet:${MACHINE_REF}/` : "fleet:<your fleet_ref>/";

const FORBIDDEN_CLAUSE =
  PROPOSAL_MODE === "machine"
    ? `403 means your source is not this token's own registration (it must start ` +
      `with \`${MACHINE_PREFIX}\`) or that registration was revoked — fix the ` +
      "source, do not ask for more domain scope."
    : "403 means the credential is not an expert of this domain.";

const SOURCE_CLAUSE =
  PROPOSAL_MODE === "machine"
    ? `Stable submitter identity — in this process it MUST be exactly ` +
      `\`${MACHINE_PREFIX}<post_id>\` (your fleet_id is this process's BENCH_FLEET_REF` +
      `${MACHINE_REF ? `, currently \`${MACHINE_REF}\`` : ", which is not set here"}; ` +
      "a source that doesn't match is refused locally and NO request is sent — the fix " +
      "is to correct the source, never to retry). Required: it is half of the idempotency key."
    : "Stable submitter identity across rounds — 'fleet:<fleet_id>/<post_id>' " +
      "from your identity line. Required: it is half of the idempotency key.";

const TOOL = {
  name: "bench_proposal_submit",
  description:
    "Submit one ontology draft to this domain's proposal inbox in the bench " +
    "platform (知验台). Use it for every entity/relation declaration your round " +
    "produces; do NOT propose ontology drafts through a customer action gate. " +
    "Returns {id, state, created, result}. created=false means the inbox already " +
    "held this pending key — report it as an idempotent hit, not as new. On " +
    "refusal the result is {result:'失败', kind, retryable, draft_kept:true, " +
    "message}: write ONE report line per draft from `result` (新增 / 幂等命中 / " +
    "失败+kind) and say the draft is still kept — a failure is never 'nothing " +
    "happened'. A refusal is final for the round: 400 needs new evidence or a " +
    `vocabulary-correct kind; ${FORBIDDEN_CLAUSE} Evidence ` +
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
        description: SOURCE_CLAUSE,
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

//: One shape for both halves of a round: the success path carries
//: `result: 新增|幂等命中`, the failure path carries `result: 失败` plus the
//: refusal kind and `draft_kept: true`. A report line is then a field read, not
//: a regex over prose — and "the draft is still here" cannot be forgotten.
function failOut(kind, message, { retryable = false } = {}) {
  return errOut(JSON.stringify({ result: "失败", kind, retryable, draft_kept: true, message }));
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
    return failOut(
      "config",
      "source is required: pass 'fleet:<fleet_id>/<post_id>' from your identity " +
        "line — it is half of the idempotency key" +
        (PROPOSAL_MODE === "machine" ? " (in machine mode it must be your own " +
          "fleet_ref, the one this token is registered for)" : ""),
    );
  }
  if (!/^[^\s]+$/.test(draft.source)) {
    return failOut("config", "source must be a single token with no whitespace");
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
      return failOut(err.kind, err.message, { retryable: err.retryable });
    }
    return failOut("unexpected", String(err?.message || err));
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
