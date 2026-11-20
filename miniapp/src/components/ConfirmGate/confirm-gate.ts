// The confirm gate state machine (openspec: erp-confirm-gate-mobile).
//
// The four-stage interaction every ERP confirm-gate page must use:
//   submit -> pending (no double submit) -> server confirm | reject with an
//   explainable message -> timeout fallback.
// Extracted verbatim from the cron page's hardened create flow (cron/index.tsx:
// form stays open, fields retained, 8s timeout says "服务器未确认，请检查连接后重试").
// The optimistic-close antipattern — treating submit as success and hiding a
// rejection inside a just-collapsed form — is structurally impossible here:
// there is no success path except confirm(), and timeout never reports one.
//
// Pure and framework-free (timers injectable) so node --test can drive all
// three paths; useConfirmGate() in index.tsx is the thin React wrapper.

export type ConfirmGateOutcome =
  | { outcome: "confirmed" }
  | { outcome: "rejected"; message: string }
  | { outcome: "timeout" };

export interface ConfirmGateSettle {
  confirm(): void;
  reject(message: string): void;
}

export interface ConfirmGateSnapshot {
  pending: boolean;
  error: string | null;
}

interface MachineOptions {
  /** No-receipt fallback window; the cron page's hardened 8s. */
  timeoutMs?: number;
  /** Fallback text on timeout; cron's exact wording by default. */
  timeoutMessage?: string;
  /** Fires once per settled start (confirm/reject/timeout). */
  onSettled?: (result: ConfirmGateOutcome) => void;
  timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_TIMEOUT_MESSAGE = "服务器未确认，请检查连接后重试";

type Timers = Required<MachineOptions>["timers"];

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createConfirmGateMachine(options: MachineOptions = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMessage = options.timeoutMessage ?? DEFAULT_TIMEOUT_MESSAGE;
  const timers = options.timers ?? defaultTimers;

  let pending = false;
  let error: string | null = null;
  let timer: unknown = null;
  // Settled-within-this-start flag: a settle called synchronously inside
  // perform (e.g. the socket is down and the send already failed) must not
  // then be parked into pending — the form never entered the waiting state.
  let settledInStart = false;
  // True while perform() is running: settles arriving NOW are this start's
  // synchronous receipt, not stale leftovers from an earlier one.
  let inPerform = false;
  // Cached snapshot: React's useSyncExternalStore calls getSnapshot on every
  // render and requires a STABLE reference while nothing changed — a fresh
  // object per call would loop.
  let snap: ConfirmGateSnapshot = { pending, error };

  function snapshot(): ConfirmGateSnapshot {
    return snap;
  }

  function clearTimer() {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  }

  function settle(
    next: ConfirmGateOutcome,
    after: () => void,
  ) {
    clearTimer();
    if (next.outcome === "rejected") {
      error = next.message;
    } else if (next.outcome === "confirmed") {
      error = null;
    } else {
      error = timeoutMessage;
    }
    const wasPending = pending;
    pending = false;
    settledInStart = true;
    snap = { pending, error };
    options.onSettled?.(next);
    if (wasPending) after();
  }

  function confirm() {
    if (pending) {
      settle({ outcome: "confirmed" }, () => {});
      return;
    }
    if (inPerform && !settledInStart) {
      // Synchronous confirm inside perform: done before pending ever began.
      // Stay idle (never pending), clear any error, fire the receipt once.
      clearTimer();
      error = null;
      settledInStart = true;
      snap = { pending, error };
      options.onSettled?.({ outcome: "confirmed" });
    }
    // Otherwise: stale/late confirm while idle — ignored, never a second
    // success.
  }

  function reject(message: string) {
    if (pending) {
      settle({ outcome: "rejected", message }, () => {});
      return;
    }
    if (inPerform && !settledInStart) {
      // Send already failed inside perform: record the explainable error but
      // stay idle — no timeout, no pending flash.
      clearTimer();
      error = message;
      settledInStart = true;
      snap = { pending, error };
      options.onSettled?.({ outcome: "rejected", message });
      return;
    }
    // Stale/late reject while idle — ignored; the displayed error (e.g. the
    // timeout fallback) must not be overwritten by a late receipt.
  }

  function onTimeout() {
    timer = null;
    if (!pending) return;
    settle({ outcome: "timeout" }, () => {});
  }

  /**
   * Run one submission. `perform` receives the settle handle; if it returns
   * without settling, the gate enters pending and arms the timeout. A start
   * while pending is a no-op (double-submit guard). Re-entrancy between
   * starts clears the previous error — a fresh attempt starts clean.
   */
  function start(perform: (settle: ConfirmGateSettle) => void) {
    if (pending) return;
    clearTimer();
    error = null;
    settledInStart = false;
    inPerform = true;
    snap = { pending, error };
    perform({ confirm, reject });
    inPerform = false;
    if (settledInStart) return;
    pending = true;
    snap = { pending, error };
    timer = timers.setTimeout(onTimeout, timeoutMs);
  }

  /** Clear a displayed error (retry affordance); leaves pending untouched. */
  function reset() {
    error = null;
    snap = { pending, error };
  }

  function dispose() {
    clearTimer();
  }

  return { snapshot, start, confirm, reject, reset, dispose };
}

export type ConfirmGateMachine = ReturnType<typeof createConfirmGateMachine>;
