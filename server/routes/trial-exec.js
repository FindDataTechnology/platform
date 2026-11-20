// Trial-exec service channel (add-supply-studio-migration task 5.3): the
// run-domain half of the cross-domain trial lane. The supply-domain Studio
// (facet) owns the document, but a real trial (装一台跑一轮: install the cast
// pack → provision the fleet → fire a round → collect evidence → judge) needs
// the 壹座 runtime — cells, credentials, fleet DB, cron, the LLM lane. This
// endpoint is the headless executor facet calls instead of the deferred stub:
//
//   facet POST /:id/trial ──(runWhole seam)──▶ POST /api/trial-exec ──▶ runTrial(live deps)
//
// Trust model: server-to-server only, guarded by the shared FACET_INTERNAL_TOKEN
// (the same credential gateway/facet-proxy.js rides in the opposite direction —
// one shared secret, two call directions). No user session: the creator's email
// rides in the blueprint payload and keys the install/provision ownership, the
// same attribution the deployTeam deep link produces through a live session.
//
// Response is synchronous (the report in one body): runTrial's own bounded
// windows (fire timeout, evidence window) cap the wall clock; callers pass a
// timeoutMs under the platform's HTTP request ceiling (Node default 300s) so a
// hung collect cannot pin the connection past it.
import { runTrial, createLiveTrialDeps } from "../blueprint-trial.js";
import { validateBlueprint } from "../blueprint-validate.js";
import { timingSafeEqual } from "node:crypto";

const MAX_TIMEOUT_MS = 270_000; // under Node's 300s default requestTimeout
const MIN_TIMEOUT_MS = 30_000;

export function createTrialExecRoutes(app, { depsFactory } = {}) {
  // depsFactory: test seam only — production always uses the real live deps.
  const liveDeps = depsFactory ?? createLiveTrialDeps;

  const execRunning = new Set();

  app.post("/api/trial-exec", async (req, res) => {
    // ── service gate: shared credential, timing-safe ────────────────────────
    const expected = String(process.env.FACET_INTERNAL_TOKEN || "");
    const got = String(req.headers["x-facet-token"] || "");
    if (!expected || !got || got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
      return res.status(401).json({ error: "trial-exec is a service channel (x-facet-token required)", code: "trial_exec_unauthorized" });
    }

    const blueprint = req.body?.blueprint;
    if (!blueprint || typeof blueprint !== "object" || Array.isArray(blueprint)) {
      return res.status(400).json({ error: "blueprint (object) is required", code: "trial_exec_blueprint_required" });
    }
    // Structural gates mirror the route-level ones (facet enforced them
    // already; the run domain re-checks rather than trusting the payload).
    if (blueprint.content?.kind === "agent") {
      return res.status(409).json({ error: "agent-kind documents have no trial lane", kind: "agent", code: "trial_exec_agent_kind" });
    }
    if (blueprint.status !== "cast" || !blueprint.castPackId) {
      return res.status(409).json({ error: `blueprint is '${blueprint.status}' — only cast blueprints with a cast pack can run a trial`, code: "trial_exec_not_cast" });
    }
    if (!blueprint.ownerEmail || typeof blueprint.ownerEmail !== "string") {
      return res.status(400).json({ error: "blueprint.ownerEmail (the facet creator) is required for install/provision attribution", code: "trial_exec_owner_required" });
    }
    const verdict = validateBlueprint(blueprint.content);
    if (!verdict.ok) {
      return res.status(422).json({ error: "blueprint content fails static validation", code: "trial_exec_validation_failed", errors: verdict.errors, findings: verdict.findings });
    }
    if (execRunning.has(blueprint.id)) {
      return res.status(409).json({ error: "a trial run is already in progress for this blueprint", code: "trial_exec_in_progress" });
    }
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Number(req.body?.timeoutMs) || MAX_TIMEOUT_MS));

    execRunning.add(blueprint.id);
    try {
      const report = await runTrial({ blueprint, deps: liveDeps(), timeoutMs });
      // The report is the payload; the facet side owns persistence (its
      // store.saveTrialReport) and the sign-off chain. The run domain keeps no
      // blueprint copy — the doc of record stays on the supply domain (D1).
      res.json({ report });
    } catch (err) {
      res.status(500).json({ error: err?.message || "trial run failed", code: "trial_exec_failed" });
    } finally {
      execRunning.delete(blueprint.id);
    }
  });
}
