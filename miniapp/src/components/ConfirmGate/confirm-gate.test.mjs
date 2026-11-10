// Unit tests for the ConfirmGate state machine (openspec:
// erp-confirm-gate-mobile). The four-stage contract: submit -> pending (no
// double submit) -> server confirm | explainable reject -> timeout fallback
// that NEVER reports success. Timers are injected so the timeout path is
// driven deterministically. Same pattern as markdown.test.mjs: node --test
// importing the .ts source.

import test from "node:test";
import assert from "node:assert/strict";
import { createConfirmGateMachine, DEFAULT_TIMEOUT_MESSAGE } from "./confirm-gate.ts";

// Deterministic clock + timer bookkeeping for tests.
function fakeTimers() {
  const pending = new Map();
  let seq = 0;
  let now = 0;
  return {
    timers: {
      setTimeout(fn, ms) {
        const id = ++seq;
        pending.set(id, { fn, at: now + ms });
        return id;
      },
      clearTimeout(handle) {
        pending.delete(handle);
      },
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

test("confirm path: start -> pending -> confirm() succeeds once", () => {
  const t = fakeTimers();
  const settled = [];
  const m = createConfirmGateMachine({ timers: t.timers, onSettled: (r) => settled.push(r) });

  m.start((_settle) => {
    // no synchronous settle — the receipt comes later
  });
  assert.equal(m.snapshot().pending, true);
  assert.equal(m.snapshot().error, null);
  assert.equal(t.pendingCount, 1);

  m.confirm();
  assert.equal(m.snapshot().pending, false);
  assert.equal(m.snapshot().error, null);
  assert.deepEqual(settled, [{ outcome: "confirmed" }]);
  assert.equal(t.pendingCount, 0);

  // A late duplicate confirm is ignored — never a second success.
  m.confirm();
  assert.deepEqual(settled, [{ outcome: "confirmed" }]);
});

test("reject path: explainable message shown verbatim, not success", () => {
  const t = fakeTimers();
  const settled = [];
  const m = createConfirmGateMachine({ timers: t.timers, onSettled: (r) => settled.push(r) });

  m.start(() => {});
  m.reject("信用额度不足：已占用 12,000 元，可用额度 3,000 元");
  assert.equal(m.snapshot().pending, false);
  assert.equal(m.snapshot().error, "信用额度不足：已占用 12,000 元，可用额度 3,000 元");
  assert.deepEqual(settled, [{ outcome: "rejected", message: "信用额度不足：已占用 12,000 元，可用额度 3,000 元" }]);

  // Retrying starts clean: the old rejection does not leak into it.
  m.start(() => {});
  assert.equal(m.snapshot().pending, true);
  assert.equal(m.snapshot().error, null);
});

test("timeout path: fallback text, no success, late receipts ignored", () => {
  const t = fakeTimers();
  const settled = [];
  const m = createConfirmGateMachine({
    timeoutMs: 8000,
    timers: t.timers,
    onSettled: (r) => settled.push(r),
  });

  m.start(() => {});
  t.advance(7999);
  assert.equal(m.snapshot().pending, true, "still waiting at 7999ms");

  t.advance(1);
  assert.equal(m.snapshot().pending, false);
  assert.equal(m.snapshot().error, DEFAULT_TIMEOUT_MESSAGE);
  assert.equal(DEFAULT_TIMEOUT_MESSAGE, "服务器未确认，请检查连接后重试");
  assert.deepEqual(settled, [{ outcome: "timeout" }]);

  // A receipt after the timeout must NOT flip anything to success.
  m.confirm();
  assert.equal(m.snapshot().pending, false);
  assert.equal(m.snapshot().error, DEFAULT_TIMEOUT_MESSAGE);
  assert.deepEqual(settled, [{ outcome: "timeout" }]);
});

test("double submit while pending is a no-op", () => {
  const t = fakeTimers();
  const m = createConfirmGateMachine({ timers: t.timers });
  let runs = 0;
  m.start(() => {
    runs += 1;
  });
  m.start(() => {
    runs += 1;
  });
  assert.equal(runs, 1);
  assert.equal(m.snapshot().pending, true);
});

test("synchronous reject inside perform (send already failed): idle, no pending flash, no timer", () => {
  const t = fakeTimers();
  const settled = [];
  const m = createConfirmGateMachine({ timers: t.timers, onSettled: (r) => settled.push(r) });

  m.start((settle) => {
    settle.reject("未连接，无法创建任务");
  });
  assert.equal(m.snapshot().pending, false);
  assert.equal(m.snapshot().error, "未连接，无法创建任务");
  assert.equal(t.pendingCount, 0);
  assert.deepEqual(settled, [{ outcome: "rejected", message: "未连接，无法创建任务" }]);
});

test("synchronous confirm inside perform: never pending", () => {
  const t = fakeTimers();
  const settled = [];
  const m = createConfirmGateMachine({ timers: t.timers, onSettled: (r) => settled.push(r) });

  m.start((settle) => {
    settle.confirm();
  });
  assert.equal(m.snapshot().pending, false);
  assert.equal(m.snapshot().error, null);
  assert.equal(t.pendingCount, 0);
  assert.deepEqual(settled, [{ outcome: "confirmed" }]);
});

test("custom timeout message and reset()", () => {
  const t = fakeTimers();
  const m = createConfirmGateMachine({ timeoutMs: 100, timeoutMessage: "自定义兜底", timers: t.timers });
  m.start(() => {});
  t.advance(100);
  assert.equal(m.snapshot().error, "自定义兜底");

  m.reset();
  assert.equal(m.snapshot().error, null);
});

test("stale reject while idle never overwrites the displayed timeout fallback", () => {
  const t = fakeTimers();
  const m = createConfirmGateMachine({ timers: t.timers });
  m.start(() => {});
  t.advance(8000);
  assert.equal(m.snapshot().error, DEFAULT_TIMEOUT_MESSAGE);

  // The server's receipt finally arrives — after the gate gave up. The form
  // must keep showing the timeout fallback, not flip to either success or
  // the late message.
  m.reject("信用额度不足");
  m.confirm();
  assert.equal(m.snapshot().error, DEFAULT_TIMEOUT_MESSAGE);
  assert.equal(m.snapshot().pending, false);
});

test("dispose drops the pending timer (unmount safety)", () => {
  const t = fakeTimers();
  const m = createConfirmGateMachine({ timers: t.timers });
  m.start(() => {});
  m.dispose();
  assert.equal(t.pendingCount, 0);
  // No timer fired after dispose; state frozen, not success.
  t.advance(60_000);
  assert.equal(m.snapshot().pending, true);
});
