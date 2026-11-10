// ConfirmGate — the shared four-stage confirmation interaction
// (openspec: erp-confirm-gate-mobile). React wrapper over the pure machine
// in confirm-gate.ts.
//
// Contract every consumer keeps (UE 下单/对账, SE 代客下单/预警拍板,
// SP 接单/对账, CP 接单/运费对账, cron 既有新建):
//   - submit -> the form STAYS OPEN in pending ("创建中…"), double submit
//     blocked — never an optimistic close;
//   - server confirm -> onConfirmed (the page decides what success means);
//   - server reject -> the explainable message shows VERBATIM, fields
//     retained, retry allowed;
//   - 8s without a receipt (incl. WS drop) -> the timeout fallback text,
//     never a success rendering.
// Receipts arrive over the base's ONE wsSend channel (proposal 面的
// confirm/reject 席位, same-source with owner seats); the gate holds no
// second channel of its own.

import { useRef, useSyncExternalStore } from "react";
import { Text, View } from "@tarojs/components";
import {
  createConfirmGateMachine,
  type ConfirmGateMachine,
  type ConfirmGateOutcome,
  type ConfirmGateSettle,
} from "./confirm-gate.ts";

export type { ConfirmGateOutcome, ConfirmGateSettle } from "./confirm-gate.ts";

export interface ConfirmGateApi {
  /** True while waiting for the server receipt; block resubmission on it. */
  isPending(): boolean;
  /** Current displayed error (rejection verbatim, timeout fallback, or null). */
  getError(): string | null;
  /**
   * Stable snapshot reference (machine-cached) — useSyncExternalStore's
   * getSnapshot must not build a fresh object per call.
   */
  getSnapshot(): { pending: boolean; error: string | null };
  /** Subscribe (React useSyncExternalStore seam). */
  subscribe(fn: () => void): () => void;
  /** One submission; see createConfirmGateMachine.start. */
  start(perform: (settle: ConfirmGateSettle) => void): void;
  /** Server said yes. */
  confirm(): void;
  /** Server said no (explainable message shown verbatim). */
  reject(message: string): void;
  /** Clear the displayed error (retry affordance). */
  clearError(): void;
  /** Drop the pending timer (page unmount). */
  dispose(): void;
}

function createApi(opts: {
  timeoutMs?: number;
  timeoutMessage?: string;
  onSettled?: (result: ConfirmGateOutcome) => void;
  listeners: Set<() => void>;
}): ConfirmGateApi {
  const machine: ConfirmGateMachine = createConfirmGateMachine({
    timeoutMs: opts.timeoutMs,
    timeoutMessage: opts.timeoutMessage,
    onSettled: (r) => {
      opts.onSettled?.(r);
      for (const fn of opts.listeners) fn();
    },
  });
  const notify = () => {
    for (const fn of opts.listeners) fn();
  };
  return {
    isPending: () => machine.snapshot().pending,
    getError: () => machine.snapshot().error,
    getSnapshot: () => machine.snapshot(),
    subscribe: (fn) => {
      opts.listeners.add(fn);
      return () => opts.listeners.delete(fn);
    },
    start: (perform) => {
      machine.start(perform);
      notify();
    },
    confirm: () => {
      machine.confirm();
      notify();
    },
    reject: (message) => {
      machine.reject(message);
      notify();
    },
    clearError: () => {
      machine.reset();
      notify();
    },
    dispose: () => {
      machine.dispose();
      opts.listeners.clear();
    },
  };
}

/**
 * The confirm gate hook. The api object is stable for the component's life;
 * `onSettled`/labels are re-read each render through a ref, so passing an
 * inline callback never re-creates the machine mid-submission. Unmount
 * disposal of the pending timer is the page's one duty (see cron page).
 */
export function useConfirmGate(opts: {
  timeoutMs?: number;
  timeoutMessage?: string;
  onSettled?: (result: ConfirmGateOutcome) => void;
}): ConfirmGateApi {
  const apiRef = useRef<ConfirmGateApi | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const listenersRef = useRef(new Set<() => void>());
  if (!apiRef.current) {
    apiRef.current = createApi({
      timeoutMs: optsRef.current.timeoutMs,
      timeoutMessage: optsRef.current.timeoutMessage,
      onSettled: (r) => {
        optsRef.current.onSettled?.(r);
      },
      listeners: listenersRef.current,
    });
  }
  return apiRef.current;
}

/** Reactive snapshot for rendering (pending + error in one stable read). */
export function useConfirmGateSnapshot(api: ConfirmGateApi): { pending: boolean; error: string | null } {
  return useSyncExternalStore(api.subscribe, api.getSnapshot);
}

export interface ConfirmGateProps {
  api: ConfirmGateApi;
  onSubmit: () => void;
  submitLabel: string;
  /** Pending button text; cron's wording by default. */
  pendingLabel?: string;
  /** Page-local errors (validation) shown in the same slot, page error first. */
  error?: string | null;
  className?: string;
  pendingClassName?: string;
  errorClassName?: string;
  testId?: string;
  errorTestId?: string;
}

/**
 * The gate's shared UI: error line (page validation first, then the gate's
 * rejection/timeout — the form's one honest voice) + the submit/pending
 * button. Field layout stays with the page; this component renders ONLY
 * these two rows.
 */
export function ConfirmGate({
  api,
  onSubmit,
  submitLabel,
  pendingLabel = "创建中…",
  error,
  className = "confirm-gate-submit",
  pendingClassName = "confirm-gate-submit-disabled",
  errorClassName = "confirm-gate-error",
  testId,
  errorTestId,
}: ConfirmGateProps) {
  const snapshot = useConfirmGateSnapshot(api);
  const errorText = error ?? snapshot.error ?? null;
  return (
    <View className="confirm-gate">
      {errorText ? (
        <Text className={errorClassName} data-testid={errorTestId}>
          {errorText}
        </Text>
      ) : null}
      <Text
        className={`${className}${snapshot.pending ? ` ${pendingClassName}` : ""}`}
        onClick={onSubmit}
        data-testid={testId}
      >
        {snapshot.pending ? pendingLabel : submitLabel}
      </Text>
    </View>
  );
}
