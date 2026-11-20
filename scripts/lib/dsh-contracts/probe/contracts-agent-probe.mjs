// scripts/lib/dsh-contracts/probe/contracts-agent-probe.mjs — the in-process
// agent probe plugin (extend-dsh-contracts-020-capabilities design D1).
//
// ctx.agents, the preset registry, the subagent service, and per-agent tool
// scoping are IN-PROCESS APIs the runner's stdio JSON-RPC surface cannot reach.
// This plugin is the contracts' hands inside the child: a localhost-only HTTP
// endpoint (ephemeral port, announced via $DSH_HOME/contracts-probe.json) whose
// operations create agents, mount presets, drive turns, restrict tools, and
// start subagents. It is a DUMB ACTOR — assertions live runner-side, where the
// dummy LLM's recorded requests are; the probe reports facts and error text.
//
// Test-only: materialized into the contracts runner's throwaway profile beside
// this file's loader row. Never part of a shipped profile. Named exports only
// (no default) so the loader's unwrapExports keeps name/inject/apply.

import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

const name = "contracts-agent-probe";
const inject = ["agents", "agentPresets", "subagents", "tools"];

const TURN_BUDGET_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function firstLine(err) {
  return String(err?.message || err).split("\n")[0];
}

function apply(ctx) {
  const ops = {
    // Create an agent (optionally composed onto a preset) and optionally drive
    // one turn. The runner correlates the turn with its LLM request via a
    // unique marker in promptText.
    async agent({ sessionId, presetId, provider, model, promptText }) {
      const registry = ctx.agentPresets;
      const sid = SessionId(sessionId);
      const handle = await ctx.agents.create({
        sessionId: sid,
        meta: { cwd: process.cwd() },
        agentOptions: { provider, model },
        ...(presetId
          ? {
              setup: async (agentCtx) => {
                await registry.mount(agentCtx, presetId);
              },
            }
          : {}),
      });
      let turn = null;
      if (typeof promptText === "string" && promptText) {
        handle.agent.followup(
          createUserMessage({ content: [{ type: "text", text: promptText }], source: { kind: "user" } }),
        );
        turn = await Promise.race([
          handle.agent.whenIdle().then(() => "idle"),
          sleep(TURN_BUDGET_MS).then(() => "turn-budget-exceeded"),
        ]);
      }
      return {
        sessionId,
        preset: registry.composedPreset(handle.agent.ctx) ?? null,
        turn,
      };
    },

    // Mount an UNKNOWN preset: creation must fail BEFORE publication and roll
    // the whole agent back — the residue check is the assertion.
    async badPreset({ sessionId, presetId, provider, model }) {
      const registry = ctx.agentPresets;
      const sid = SessionId(sessionId);
      let error = null;
      try {
        const handle = await ctx.agents.create({
          sessionId: sid,
          meta: { cwd: process.cwd() },
          agentOptions: { provider, model },
          setup: async (agentCtx) => {
            await registry.mount(agentCtx, presetId);
          },
        });
        // Not thrown = not failed; dispose the wrongly-created agent so the
        // runner's residue check is meaningful, and report the miss.
        await handle.dispose().catch(() => {});
        error = "(no error — the unknown preset was accepted)";
      } catch (e) {
        error = firstLine(e);
      }
      return {
        error,
        residue: ctx.agents.list().some((a) => String(a.id) === String(sid)),
      };
    },

    // Visible tool names for one agent (per-agent scoping's read side).
    async tools({ sessionId }) {
      const agent = ctx.agents.get(SessionId(sessionId));
      if (!agent) throw new Error(`no live agent ${sessionId}`);
      return { names: ctx.tools.schemas(agent).map((s) => s.name).sort() };
    },

    // Restrict tools on ONE agent (DS Bot's recipe): intersect the deny list
    // with currently-visible names, retry until the restriction sticks —
    // schemas may still be registering and the restrict hook may not exist
    // during creation.
    async restrict({ sessionId, deny, timeoutMs = 15_000 }) {
      const agent = ctx.agents.get(SessionId(sessionId));
      if (!agent) throw new Error(`no live agent ${sessionId}`);
      const deadline = Date.now() + timeoutMs;
      let lastError = "(never attempted)";
      for (;;) {
        try {
          const visible = new Set(ctx.tools.schemas(agent).map((s) => s.name));
          const known = deny.filter((n) => visible.has(n));
          if (known.length > 0 && typeof agent.ctx?.tools?.restrict === "function") {
            agent.ctx.tools.restrict({ deny: known });
          }
          const names = ctx.tools.schemas(agent).map((s) => s.name);
          if (known.length > 0 && deny.every((n) => !names.includes(n))) {
            return { names: names.sort() };
          }
          if (known.length === 0 && typeof agent.ctx?.tools?.restrict === "function") {
            // The deny targets never became visible — report what IS visible;
            // the runner decides whether that is a finding.
            return { names: names.sort(), note: "deny targets not visible to this agent" };
          }
        } catch (e) {
          lastError = firstLine(e);
        }
        if (Date.now() >= deadline) {
          throw new Error(`restrict did not stick within ${timeoutMs}ms (last: ${lastError})`);
        }
        await sleep(500);
      }
    },

    // One-shot subagent delegation from a live parent. The child's request
    // lands on the dummy LLM — the runner asserts per-child agentOptions via
    // the marker/model on that request, and completion via stopReason.
    async subagentOneShot({ parentSessionId, promptText, agentOptions }) {
      const parent = ctx.agents.get(SessionId(parentSessionId));
      if (!parent) throw new Error(`no live parent agent ${parentSessionId}`);
      const run = await ctx.subagents.start("spawn", {
        parent,
        signal: new AbortController().signal,
        prompt: [{ type: "text", text: promptText }],
        ...(agentOptions ? { agentOptions } : {}),
      });
      const result = await run.result;
      return {
        childId: String(run.id),
        stopReason: String(result?.stopReason ?? "?"),
      };
    },

    // Continuable subagent: establishes a durable child (occupying a pool slot
    // while resident). Used for slot-admission: with maxActiveSubagents=1 the
    // SECOND start must reject ACTIVATION_LIMIT_REACHED without queuing.
    async subagentContinuable({ parentSessionId, promptText }) {
      const parent = ctx.agents.get(SessionId(parentSessionId));
      if (!parent) throw new Error(`no live parent agent ${parentSessionId}`);
      const start = await ctx.subagents.startContinuable({
        provider: "spawn",
        label: "contracts-slot-probe",
        request: { parent, prompt: [{ type: "text", text: promptText }] },
        signal: new AbortController().signal,
      });
      return { childId: String(start.childId) };
    },
  };

  const server = createServer((req, res) => {
    const op = req.url?.replace(/^\/+/, "");
    const handler = ops[op];
    if (req.method !== "POST" || typeof handler !== "function") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no op ${req.method} ${req.url}` }));
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let body = {};
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "body is not JSON" }));
        return;
      }
      try {
        const out = await handler(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out ?? {}));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        // The stable error CODE rides alongside the message (slot admission
        // asserts on it); keep both — the message alone is a human-readable
        // paraphrase that reshapes between releases.
        res.end(JSON.stringify({ error: firstLine(e), code: typeof e?.code === "string" ? e.code : null }));
      }
    });
  });

  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    const home = process.env.DSH_HOME ?? ".";
    writeFileSync(join(home, "contracts-probe.json"), `${JSON.stringify({ port })}\n`);
    ctx.logger?.info?.(`contracts-agent-probe: listening on 127.0.0.1:${port}`);
  });
  // unref: the endpoint must never be what keeps the child alive.
  server.unref();
  ctx.effect(() => () => server.close(), "contracts-agent-probe");
}

export { apply, inject, name };
