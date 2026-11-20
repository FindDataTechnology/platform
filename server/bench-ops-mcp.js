// ── Bench ops MCP server (stdio) ─────────────────────────────────────────────
//
// Four tools, one per machine endpoint, so a fleet turn can actually work the
// bench's queue instead of being told about it in prose:
//
//   bench_work_order_list      — what is waiting for me (read-only)
//   bench_work_order_claim     — take one
//   bench_work_order_complete  — close one
//   bench_run_report           — say what the round did
//
// Why tools and not prompt conventions: a prompt can be rewritten freely, but a
// tool is the thing that is enforced. There is no second path to the bench's
// fleet surface from a drop-in turn, and this child does no writes of its own
// beyond the one POST per call (the peer's gates authorize it).
//
// Attribution stays honest: `source`/`runner_ref` are built from the fleet ref
// the PEER reports for this credential plus the turn's own `post`/`round`. No
// env-only identity exists, because one MCP child serves every post in the cell
// — an env value could only ever name the wrong post.
//
// Refusal wording is load-bearing: `not_deployed` (404 with a generic body) means
// "wait for the peer's shard / fix BENCH_URL", while `forbidden`/`auth` mean "fix
// the credential". A caller that cannot tell those apart retries the wrong thing
// forever.

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
  VERDICT_GATES,
  VERDICT_OUTCOMES,
  claimWorkOrder,
  completeWorkOrder,
  getVerdict,
  listRulers,
  listVerdicts,
  listWorkOrders,
  recordRun,
} from "../lib/bench-ops-client.js";

// The stdio channel IS the protocol: stdout carries JSON-RPC and nothing else.
console.log = (...args) => console.error(...args);

const TOOLS = [
  {
    name: "bench_work_order_list",
    description:
      "List the work orders the bench (知验台) has assigned to THIS fleet in " +
      "this domain: pending or in progress, nobody else's. Call it before " +
      "deciding what to do this round — it is the only view of the queue that " +
      "belongs to the fleet (the console page is for people, the ledger answers " +
      "'what ran'). Read-only on the peer: no status change, no event. " +
      "Returns {domain, fleet_ref, count, work_orders:[{id,target_kind," +
      "target_key,title,detail,status,created_at,claimed_by}]}. `claimed_by` " +
      "distinguishes 'nobody took it' from 'I took it last round'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bench_work_order_claim",
    description:
      "Claim one work order for this fleet. 409 means another fleet holds it " +
      "(do not retry — pick another order); 403 means the order is not assigned " +
      "to this fleet (do not retry). A repeat claim by the same fleet is an " +
      "idempotent hit: created=false. Claiming is a visible hand-off to the " +
      "human who dispatched it, so claim only what this round will actually do.",
    inputSchema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: {
          type: "integer",
          description: "The `id` from bench_work_order_list.",
        },
      },
    },
  },
  {
    name: "bench_work_order_complete",
    description:
      "Close one work order after the round has done the work. Must be claimed " +
      "first (409 otherwise). Completing does NOT write knowledge units — it " +
      "records that the work is done, and the order's human owner still decides " +
      "what the products become. created=false means this is a repeat of a " +
      "closing you already sent.",
    inputSchema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "integer", description: "The order to close." },
        note: {
          type: "string",
          description: "One line for the human owner: what was actually produced.",
        },
        artifact_refs: {
          type: "array",
          items: { type: "string" },
          description:
            "Pointers to what you produced (paths, URLs, keys). Never inline content.",
        },
      },
    },
  },
  {
    name: "bench_run_report",
    description:
      "Report one round into the bench's run ledger: role, outcome, counts. " +
      "`runner_ref` is derived as fleet:<fleet>/<post>#<round> from the peer's " +
      "own answer for this credential plus the turn's identity line — it is " +
      "never passed in, so a report cannot be attributed to a fleet that did " +
      "not run it. Replaying the same round is an idempotent hit (created=false) " +
      "and changes nothing. `outcome` must be one of the peer's four run states; " +
      "anything else is refused 422. To record what this round was JUDGED to be, " +
      "pass `verdict` — a separate vocabulary (verdict.outcome is pass/fail/" +
      "inconclusive), never merged with the run outcome above.",
    inputSchema: {
      type: "object",
      required: ["post", "round", "role", "outcome"],
      properties: {
        post: {
          type: "string",
          description:
            "From the turn's identity line (`post=<ref>`). Single token, no whitespace.",
        },
        round: {
          type: "integer",
          description: "1-based round number of this run within the post.",
        },
        role: {
          type: "string",
          description: "Which seat ran (the role name from the fleet's roster).",
        },
        outcome: {
          type: "string",
          description: "One of the peer's four outcome states (e.g. ok / partial / failed / skipped).",
        },
        counts: {
          type: "object",
          description: "What was produced, as named counters (e.g. {\"drafts\": 2}).",
        },
        artifact_refs: {
          type: "array",
          items: { type: "string" },
          description: "Pointers to the round's outputs.",
        },
        remaining: { type: "string", description: "What is left, in the round's own words." },
        detail: { type: "string", description: "Free-form note for the ledger." },
        task_id: { type: "integer", description: "The work order this round served, if any." },
        verdict: {
          type: "object",
          description:
            "Optional evaluation identity: what judged this round's output, against " +
            "which ruler version, and what came out. Omit it to report a plain run. " +
            "When given, all five fields are required (a half-populated verdict is " +
            "unusable on the peer).",
          required: ["ruler_kind", "ruler_key", "ruler_digest", "gate", "outcome"],
          properties: {
            ruler_kind: { type: "string", description: "e.g. rubric / gold-set / checker-set." },
            ruler_key: { type: "string", description: "The ruler's stable key." },
            ruler_digest: {
              type: "string",
              description:
                "The ruler's canonical digest. Two scores are comparable ONLY when " +
                "their digests match; a different digest is a different ruler.",
            },
            gate: {
              type: "string",
              enum: [...VERDICT_GATES],
              description: "Which gate this verdict was judged under.",
            },
            outcome: {
              type: "string",
              enum: [...VERDICT_OUTCOMES],
              description:
                "pass / fail / inconclusive. `inconclusive` means the evaluation " +
                "could not decide (too little evidence, lane down) — it is NOT a " +
                "failure and MUST NOT be reported as one.",
            },
          },
        },
      },
    },
  },
  {
    name: "bench_verdict_list",
    description:
      "Read the bench's verdict ledger (知验台's unified evaluation record) for " +
      "this domain. Each row names WHAT was evaluated (subject), WITH WHICH ruler " +
      "(and its digest), under which gate, and what came out. Filter by subject to " +
      "see one object's trend. `outcome` is three-state and includes " +
      "`inconclusive`; `provisional=true` means the judge behind it has not passed " +
      "calibration, so it is evidence, not a promotion reason. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        subject_kind: { type: "string", description: "Narrow to one subject kind (e.g. pack, contract, judge)." },
        subject_key: { type: "string", description: "Narrow to one subject key." },
        gate: { type: "string", enum: [...VERDICT_GATES], description: "Narrow to one gate." },
        outcome: { type: "string", enum: [...VERDICT_OUTCOMES], description: "Narrow to one outcome." },
        limit: { type: "integer", description: "Max rows (peer caps it)." },
      },
    },
  },
  {
    name: "bench_verdict_get",
    description:
      "One verdict with its per-criterion evidence and artifact references. Use " +
      "it instead of trusting a summary score: the summarized number is a " +
      "diagnostic, the individual criterion verdicts are the evidence.",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: {
        run_id: { type: "integer", description: "The verdict id from bench_verdict_list." },
      },
    },
  },
  {
    name: "bench_ruler_list",
    description:
      "The rulers (rubrics / gold sets / checker sets) this domain can be judged " +
      "by, with their digests. Call it before self-evaluating: a verdict that " +
      "names no digest cannot be compared with anything, and picking the wrong " +
      "ruler key produces a score nobody can reproduce.",
    inputSchema: { type: "object", properties: {} },
  },
];

function errOut(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function okOut(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fail(err) {
  if (err instanceof BenchProposalError) {
    // kind + retryable are what the round reporter needs to stop correctly.
    return errOut(`${err.kind}${err.retryable ? " (retryable)" : ""}: ${err.message}`);
  }
  return errOut(`${err?.name || "Error"}: ${err?.message || err}`);
}

export async function toolList(_args = {}, opts = {}) {
  try {
    const out = await listWorkOrders({ env: opts.env, transport: opts.transport });
    return okOut({
      domain: out.domain,
      fleet_ref: out.fleetRef,
      count: out.count,
      work_orders: out.workOrders,
    });
  } catch (err) {
    return fail(err);
  }
}

export async function toolClaim(args = {}, opts = {}) {
  try {
    const out = await claimWorkOrder(args.task_id, { env: opts.env, transport: opts.transport });
    return okOut({ ...out, result: out.created ? "已认领" : "幂等命中（本舰队已持有）" });
  } catch (err) {
    return fail(err);
  }
}

export async function toolComplete(args = {}, opts = {}) {
  try {
    const out = await completeWorkOrder(
      args.task_id,
      { note: args.note, artifactRefs: args.artifact_refs },
      { env: opts.env, transport: opts.transport },
    );
    return okOut({ ...out, result: out.created ? "已关单" : "幂等命中（此前已关）" });
  } catch (err) {
    return fail(err);
  }
}

export async function toolRunReport(args = {}, opts = {}) {
  try {
    const out = await recordRun(
      {
        post: args.post,
        round: args.round,
        role: args.role,
        outcome: args.outcome,
        counts: args.counts,
        artifactRefs: args.artifact_refs,
        remaining: args.remaining,
        detail: args.detail,
        taskId: args.task_id,
        verdict: args.verdict,
      },
      { env: opts.env, transport: opts.transport },
    );
    return okOut({ ...out, result: out.created ? "已记入台账" : "幂等命中（同一 runner_ref）" });
  } catch (err) {
    return fail(err);
  }
}

export async function toolVerdictList(args = {}, opts = {}) {
  try {
    const out = await listVerdicts(
      {
        subjectKind: args.subject_kind,
        subjectKey: args.subject_key,
        gate: args.gate,
        outcome: args.outcome,
        limit: args.limit,
      },
      { env: opts.env, transport: opts.transport },
    );
    return okOut({ count: out.count, verdicts: out.verdicts });
  } catch (err) {
    return fail(err);
  }
}

export async function toolVerdictGet(args = {}, opts = {}) {
  try {
    const verdict = await getVerdict(args.run_id, { env: opts.env, transport: opts.transport });
    return okOut({ verdict });
  } catch (err) {
    return fail(err);
  }
}

export async function toolRulerList(_args = {}, opts = {}) {
  try {
    const out = await listRulers({ env: opts.env, transport: opts.transport });
    return okOut({ count: out.count, rulers: out.rulers });
  } catch (err) {
    return fail(err);
  }
}

const HANDLERS = {
  bench_work_order_list: toolList,
  bench_work_order_claim: toolClaim,
  bench_work_order_complete: toolComplete,
  bench_run_report: toolRunReport,
  bench_verdict_list: toolVerdictList,
  bench_verdict_get: toolVerdictGet,
  bench_ruler_list: toolRulerList,
};

export const server = new Server(
  { name: "bench-ops-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params ?? {};
  const handler = HANDLERS[name];
  if (!handler) return errOut(`unknown tool: ${name}`);
  return handler(args);
});

// Only start stdio when launched as the MCP child; importing the module (tests,
// tooling) must stay side-effect free. Same guard as bench-proposal-mcp.js.
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
