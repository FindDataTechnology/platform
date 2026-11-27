// ── Auto-evaluation queue (openspec: owner-inbox, skill/persona self-evolution) ──
//
// Evaluation is EVIDENCE, not a decision. Making a human click "evaluate" and
// then wait on a multi-second judge call puts a mechanical step inside the
// owner's budget — and when candidates pile up it is N such steps. So a
// candidate that lands is queued for evaluation immediately, and the human is
// left with the only thing that genuinely needs a person: accept or reject.
//
// What this module deliberately does NOT do:
//   • run more than one evaluation at a time (the judge lane is a shared model
//     endpoint; serial keeps the cost predictable and matches the A/B harness's
//     own "call pair, seconds" shape);
//   • retry forever (a failed evaluation leaves the candidate unevaluated with
//     an honest reason — 评测没跑成 ≠ 通过 — and the owner can re-run it);
//   • pretend to have a durable queue. The queue lives in memory: if the process
//     restarts mid-evaluation the candidate simply stays `candidate` with no
//     report, which is exactly the honest state.

const NOOP = () => {};

/** Auto-evaluation is on unless explicitly disabled (rollback switch). */
export function autoEvalEnabled(env = process.env) {
  return String(env?.AUTO_EVAL ?? "1") !== "0";
}

/** Per-owner evaluations per day. Separate from the proposal budget: a proposal
 *  costs a model turn, an evaluation costs a judge call pair. */
export function dailyEvalBudget(env = process.env) {
  const n = Number(env?.AUTO_EVAL_DAILY_CAP);
  return Number.isFinite(n) && n >= 0 ? n : 40;
}

/**
 * A serialized queue. `run(spec)` never throws: the caller's propose response
 * must not depend on an evaluation that has not happened yet.
 */
export function createEvalQueue({ log = NOOP, store = null, runEval = null } = {}) {
  let chain = Promise.resolve();
  let inFlight = 0;
  const counters = new Map(); // dayKey -> count

  function dayKey(now = Date.now()) {
    return new Date(now).toISOString().slice(0, 10);
  }

  function budgetLeft() {
    const used = counters.get(dayKey()) ?? 0;
    return dailyEvalBudget() - used;
  }

  function consume() {
    const k = dayKey();
    counters.set(k, (counters.get(k) ?? 0) + 1);
  }

  return {
    /** Current depth, for tests and diagnostics. */
    get pending() {
      return inFlight;
    },
    budgetLeft,
    /**
     * Skill candidate: prepare reads the CURRENT candidate row (it may have been
     * promoted/rejected between queueing and running — then there is nothing
     * left to evaluate).
     */
    enqueueSkill(candidate) {
      const id = candidate?.id;
      if (!store || !runEval) return { queued: false, reason: "eval queue has no store/runner wired" };
      if (!id) return { queued: false, reason: "candidate has no id" };
      return this.enqueue({
        label: `skill:${id}`,
        prepare: () => {
          const fresh = store.getCandidate(id);
          if (!fresh) return { skip: "candidate vanished" };
          if (fresh.status === "promoted" || fresh.status === "rejected") return { skip: `already ${fresh.status}` };
          if (fresh.evalReport && fresh.evalReport.passed === true) return { skip: "already evaluated" };
          const oldBody = fresh.supersedes ? (store.oldSkillContent?.(fresh.supersedes) ?? null) : null;
          const scenarioPrompt = String(fresh.evidence?.scenario ?? "").trim();
          // No scene ⇒ nothing to compare arms on. Burning a judge call to
          // have it fail is worse than saying so: the candidate stays
          // unevaluated (honest), and the owner can supply a scene on re-run.
          if (!scenarioPrompt) return { skip: "no scenario in evidence" };
          return { candidate: fresh, scenarioPrompt, oldBody };
        },
        // Each route wires its own runner (skill vs persona harness), injected
        // OUTSIDE the lane — the queue never resolves a judge lane itself.
        evaluate: (prep) =>
          runEval({
            candidate: { body: prep.candidate.body, supersedes: prep.candidate.supersedes },
            scenarioPrompt: prep.scenarioPrompt,
            oldSkillBody: prep.oldBody,
          }),
        onPassed: (report) => {
          store.saveEvalReport(id, report);
          store.markEvaluated(id);
        },
        onNotPassed: (report) => {
          store.saveEvalReport(id, report);
          store.markUnevaluated(id, `gate not passed: ${report?.reason ?? "unknown"}`);
        },
        onError: (err) => store.markUnevaluated(id, String(err?.message ?? err)),
      });
    },
    /** Persona candidate: same discipline, different harness and fields. */
    enqueuePersona(candidate) {
      const id = candidate?.id;
      if (!store || !runEval) return { queued: false, reason: "eval queue has no store/runner wired" };
      if (!id) return { queued: false, reason: "candidate has no id" };
      return this.enqueue({
        label: `persona:${id}`,
        prepare: () => {
          const fresh = store.getCandidate(id);
          if (!fresh) return { skip: "candidate vanished" };
          if (fresh.status === "promoted" || fresh.status === "rejected") return { skip: `already ${fresh.status}` };
          if (fresh.evalReport && fresh.evalReport.passed === true) return { skip: "already evaluated" };
          const scenarioPrompt = String(fresh.evidence?.scenario ?? "").trim();
          if (!scenarioPrompt) return { skip: "no scenario in evidence" };
          return { candidate: fresh, scenarioPrompt };
        },
        evaluate: (prep) =>
          runEval({
            currentPersona: prep.candidate.current_persona,
            amendedPersona: prep.candidate.amended_persona,
            scenarioPrompt: prep.scenarioPrompt,
          }),
        onPassed: (report) => {
          store.saveEvalReport(id, report);
          store.markEvaluated(id);
        },
        onNotPassed: (report) => {
          store.saveEvalReport(id, report);
          store.markUnevaluated(id, `gate not passed: ${report?.reason ?? "unknown"}`);
        },
        onError: (err) => store.markUnevaluated(id, String(err?.message ?? err)),
      });
    },
    /**
     * Queue one evaluation. `prepare()` is called at run time (never at queue
     * time) so it reads the candidate as it exists then; it returns either
     * `{ skip: reason }` or the argument bag for `evaluate`.
     */
    enqueue({ label, prepare, evaluate, onPassed, onNotPassed, onError }) {
      if (!autoEvalEnabled()) {
        return { queued: false, reason: "auto-eval disabled" };
      }
      if (budgetLeft() <= 0) {
        return { queued: false, reason: `evaluation budget exhausted (${dailyEvalBudget()}/day)` };
      }
      inFlight += 1;
      chain = chain.then(async () => {
        try {
          const prep = prepare();
          if (prep?.skip) {
            log(`[eval-queue] ${label}: skipped (${prep.skip})`);
            return;
          }
          consume();
          const report = await evaluate(prep);
          if (report?.passed) onPassed(report);
          else onNotPassed(report);
        } catch (err) {
          try {
            onError(err);
          } catch {
            /* the error path itself must not throw */
          }
          log(`[eval-queue] ${label}: failed — ${err?.message || err}`);
        } finally {
          inFlight -= 1;
        }
      });
      return { queued: true };
    },
    /** Await the whole chain (tests and orderly shutdown). */
    drain() {
      return chain;
    },
  };
}
