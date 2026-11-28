// One "is the spawned server up yet?" wait, shared by every fixture that boots a
// gateway (or a server) in its own process.
//
// WHY THIS EXISTS: eight test files each carried their own copy of this loop and
// the budgets drifted apart — `test-cell-gateway` / `test-cell-bindings` /
// `test-gateway-sessionless` waited 80×250ms = 20s, `test-onboarding-hosted` 30s,
// and `test-app-pairing` 300×100ms = 30s. The 20s ones fail on a loaded machine:
// 2026-11-16 on a box with 5.4/6.1GB swap in use, every case in
// `test-cell-gateway.mjs` burned its full 20s and reported "gateway never became
// healthy", which reads as "this file is slow" rather than "the fixture's bound
// is too tight" (the file cost 301s of pure waiting).
//
// The 30s default is not invented here: `test-app-pairing.mjs` already argued it
// after CI run 42477779338 — a cold node boot on a contended 2-core runner
// legitimately takes longer than 15s, the same bound is then read as a hard
// failure ("server on 3659 never became healthy", while the same commit passed
// 15/15 locally), and a real boot regression still exhausts the window and fails.
// So the only thing this removes is the false red.
//
// `HEALTH_BUDGET_MS` overrides the budget (a thrashing laptop may need 90s). It
// only ever *extends* the wait; it cannot make a broken boot look healthy.

export const DEFAULT_HEALTH_BUDGET_MS = 30_000;
export const DEFAULT_HEALTH_INTERVAL_MS = 250;

export function healthBudgetMs(env = process.env) {
  const raw = Number(env.HEALTH_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HEALTH_BUDGET_MS;
}

/** How many probes a budget buys. Exported so a self-test can pin the arithmetic. */
export function healthTries(budgetMs = DEFAULT_HEALTH_BUDGET_MS, intervalMs = DEFAULT_HEALTH_INTERVAL_MS) {
  return Math.max(1, Math.ceil(budgetMs / intervalMs));
}

const defaultMessage = (url, waitedMs, budgetMs, dead) =>
  dead
    ? `server died before becoming healthy (${url}, waited ${waitedMs}ms)`
    : `${url} never became healthy within ${budgetMs}ms (waited ${waitedMs}ms)`;

/**
 * Poll `${base}${path}` until it answers 2xx, the budget runs out, or `onDead()`
 * reports that the child process is gone.
 *
 * @returns {Promise<number>} milliseconds actually waited
 * @throws {Error} from `failMessage(waitedMs, { dead })` when it never came up,
 *                 so each caller keeps its own wording and its own child logs.
 */
export async function waitForHealthy(
  base,
  {
    path = "/healthz",
    budgetMs = healthBudgetMs(),
    intervalMs = DEFAULT_HEALTH_INTERVAL_MS,
    init,
    accept = (res) => res.ok,
    onDead,
    failMessage,
  } = {},
) {
  const url = `${base}${path}`;
  const started = Date.now();
  const tries = healthTries(budgetMs, intervalMs);

  for (let i = 0; i < tries; i++) {
    if (onDead?.()) {
      const waitedMs = Date.now() - started;
      throw new Error(
        failMessage ? failMessage(waitedMs, { dead: true }) : defaultMessage(url, waitedMs, budgetMs, true),
      );
    }
    try {
      if (accept(await fetch(url, init))) return Date.now() - started;
    } catch {
      /* not listening yet */
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }

  const waitedMs = Date.now() - started;
  throw new Error(
    failMessage ? failMessage(waitedMs, { dead: false }) : defaultMessage(url, waitedMs, budgetMs, false),
  );
}
