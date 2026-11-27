#!/usr/bin/env node
// ── web-design-system ui-core tests (harden-web-design-foundation 2.x) ──────
// Pins the PURE halves of the primitives: tab roving order (incl. wrap and
// disabled skip), the toast v2 queue reducer (cap, FIFO promotion, idempotent
// dismiss), and the DOM-order rule that makes ConfirmDialog land the keyboard
// on the cancel side. JSX files themselves are verified by tsc + batch ② e2e.
//
//   node --test scripts/test-ui-core.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tabFocusStep } from "../web/src/lib/tabsCore.ts";
import { toastReduce, TOAST_TTL, TOAST_MAX_VISIBLE } from "../web/src/lib/toastCore.ts";

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

// ── tabs ─────────────────────────────────────────────────────────────────────
test("tab arrows wrap and skip disabled tabs", () => {
  const items = [{ id: "a" }, { id: "b", disabled: true }, { id: "c" }];
  assert.equal(tabFocusStep(items, 0, "ArrowRight"), 2, "skips disabled b");
  assert.equal(tabFocusStep(items, 2, "ArrowRight"), 0, "wraps to first");
  assert.equal(tabFocusStep(items, 2, "ArrowLeft"), 0, "backward skips disabled");
  assert.equal(tabFocusStep(items, 0, "Home"), 0);
  assert.equal(tabFocusStep(items, 0, "End"), 2);
});

test("tabs with nothing enabled return -1; all-disabled list is safe", () => {
  assert.equal(tabFocusStep([], 0, "ArrowRight"), -1);
  assert.equal(tabFocusStep([{ disabled: true }], 0, "End"), -1);
});

// ── toast v2 queue ───────────────────────────────────────────────────────────
const item = (id, severity = "info") => ({ id, severity, title: `t${id}`, ttlMs: TOAST_TTL[severity] });

test("push caps at TOAST_MAX_VISIBLE, extras queue FIFO", () => {
  let s = { visible: [], queued: [] };
  for (let i = 1; i <= 5; i++) s = toastReduce(s, { type: "push", item: item(i) });
  assert.deepEqual(s.visible.map((t) => t.id), [1, 2, 3]);
  assert.deepEqual(s.queued.map((t) => t.id), [4, 5]);
});

test("dismiss promotes the oldest queued item", () => {
  let s = { visible: [1, 2, 3].map((i) => item(i)), queued: [item(4)] };
  s = toastReduce(s, { type: "dismiss", id: 2 });
  assert.deepEqual(s.visible.map((t) => t.id), [1, 3, 4]);
  assert.equal(s.queued.length, 0);
});

test("dismiss is idempotent (late timer cannot corrupt the list)", () => {
  const s = { visible: [item(1)], queued: [item(2)] };
  const after = toastReduce(s, { type: "dismiss", id: 999 });
  assert.equal(after, s, "unknown id returns the same state object");
  assert.deepEqual(toastReduce(s, { type: "dismiss", id: 1 }).visible.map((t) => t.id), [2]);
});

test("error outdwells success and info (spec floor)", () => {
  assert.ok(TOAST_TTL.error >= TOAST_TTL.success);
  assert.ok(TOAST_TTL.error >= TOAST_TTL.info);
  assert.equal(TOAST_MAX_VISIBLE, 3);
});

// ── confirm dialog: the safe-side focus default is a DOM-order property ─────
test("ConfirmDialog wires cancel before confirm in DOM order", () => {
  const src = read("../web/src/components/ui/confirm-dialog.tsx");
  const cancel = src.indexOf("{cancelLabel}");
  const confirm = src.indexOf("{confirmLabel}");
  assert.ok(cancel > 0 && confirm > 0, "both labels render");
  assert.ok(cancel < confirm, "cancel must precede confirm so Dialog's first-focusable lands on it");
});

test("Toast v2 host exists with close affordance and no hard-coded copy", () => {
  const src = read("../web/src/components/ui/toast.tsx");
  assert.match(src, /closeLabel/);
  assert.doesNotMatch(src, /"[^"\n]*[一-鿿][^"\n]*"/, "no zh literals in the primitive");
});

// ── g-prefix navigation (unify-operate-states 4.3) ──────────────────────────
test("g-nav chord: first-letter mapping, window expiry, least-letters wins", async () => {
  const { buildGMap, gKeyStep, G_WINDOW_MS } = await import("../web/src/lib/gNav.ts");
  const targets = [
    { slug: "chat", path: "/chat" },
    { slug: "clusters", path: "/clusters" },
    { slug: "memory", path: "/memory" },
  ];
  const map = buildGMap(targets);
  assert.equal(map.c.slug, "chat", "least-letters slug wins the letter");
  let st = { gAt: null };
  st = gKeyStep(st, 1000, "g", map).next;
  const hit = gKeyStep(st, 1500, "c", map);
  assert.equal(hit.goto, "/chat");
  assert.equal(hit.next.gAt, null);
  st = { gAt: null };
  st = gKeyStep(st, 1000, "g", map).next;
  assert.equal(gKeyStep(st, 1000 + G_WINDOW_MS + 1, "c", map).goto, null, "expired chord does not navigate");
  assert.equal(gKeyStep({ gAt: null }, 1000, "x", map).goto, null, "non-chord keys pass through");
});
