// The shared slicing + retry plan (openspec: add-voice-capture-lane, 5.1/5.4).
//
// This is the file that makes "三端走同一份切片 + 重传实现" checkable: one module in
// packages/core, imported by web, the mini-program and the app. The tests below
// pin the two properties that would silently corrupt a transcript if they broke
// — a gap (audio nobody transcribes) and an overlap (the same words twice) —
// plus the retry ceiling and the export shape.
//
//   node --test scripts/test-voice-capture-slices.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const {
  CAPTURE_MAX_ATTEMPTS,
  planSlices,
  slicesCoverTotal,
  sliceAction,
  captureProgress,
  pendingSlices,
  captureComplete,
  formatOffset,
  exportCaptureText,
} = await import("../packages/core/src/voice-capture-slices.ts");

// ── planning ──────────────────────────────────────────────────────────────

test("a one-hour recording plans 120 contiguous 30s slices", () => {
  const slices = planSlices(60 * 60_000);
  assert.equal(slices.length, 120);
  assert.equal(slices[0].startMs, 0);
  assert.equal(slices.at(-1).startMs, 119 * 30_000);
  assert.deepEqual(
    slices.map((s) => s.seq),
    Array.from({ length: 120 }, (_, i) => i),
  );
});

test("the plan tiles the recording exactly: no gap, no overlap, no padded tail", () => {
  for (const totalMs of [1, 999, 30_000, 31_000, 60_000, 60_001, 55 * 60_000]) {
    const slices = planSlices(totalMs, 30_000);
    assert.equal(slicesCoverTotal(slices, totalMs), true, `total ${totalMs}`);
    // Every millisecond belongs to exactly one slice.
    const covered = slices.reduce((sum, s) => sum + s.durationMs, 0);
    assert.equal(covered, totalMs);
  }
  // A 45s recording is 30s + 15s, not 30s + 30s of padding.
  assert.deepEqual(planSlices(45_000, 30_000), [
    { seq: 0, startMs: 0, durationMs: 30_000 },
    { seq: 1, startMs: 30_000, durationMs: 15_000 },
  ]);
});

test("a non-positive or absurd duration plans nothing instead of throwing", () => {
  assert.deepEqual(planSlices(0), []);
  assert.deepEqual(planSlices(-5000), []);
  assert.deepEqual(planSlices(Number.NaN), []);
  assert.deepEqual(planSlices(10_000, 0), planSlices(10_000, 30_000), "a bad chunk size falls back");
});

// ── retry decisions ───────────────────────────────────────────────────────

test("a slice's next action follows status, attempts and the server's retryable flag", () => {
  const base = { seq: 0, attempts: 0, status: "pending" };
  assert.equal(sliceAction(base), "send");
  assert.equal(sliceAction({ ...base, status: "failed", attempts: 1 }), "send", "one failure is retryable");
  assert.equal(sliceAction({ ...base, status: "failed", attempts: CAPTURE_MAX_ATTEMPTS }), "give-up");
  assert.equal(sliceAction({ ...base, status: "transcribing", attempts: 1 }), "wait");
  assert.equal(sliceAction({ ...base, status: "done", attempts: 1 }), "done");
  // The server's own refusal wins: it knows whether the audio survived.
  assert.equal(sliceAction({ ...base, status: "failed", attempts: 1, retryable: false }), "give-up");
});

test("the retry queue is in seq order and excludes everything settled", () => {
  const chunks = [
    { seq: 3, status: "failed", attempts: 1 },
    { seq: 1, status: "done", attempts: 1 },
    { seq: 4, status: "failed", attempts: CAPTURE_MAX_ATTEMPTS },
    { seq: 0, status: "failed", attempts: 1 },
    { seq: 2, status: "transcribing", attempts: 1 },
  ];
  assert.deepEqual(pendingSlices(chunks), [0, 3]);
});

test("a recording is complete once every slice is transcribed or out of retries", () => {
  assert.equal(captureComplete([{ seq: 0, status: "done", attempts: 1 }]), true);
  assert.equal(captureComplete([{ seq: 0, status: "failed", attempts: CAPTURE_MAX_ATTEMPTS }]), true);
  assert.equal(captureComplete([{ seq: 0, status: "failed", attempts: 1 }]), false, "still retryable");
  assert.equal(captureComplete([{ seq: 0, status: "pending", attempts: 0 }]), false);
  assert.equal(captureComplete([{ seq: 0, status: "transcribing", attempts: 1 }]), false);
  assert.equal(captureComplete([]), true, "an empty capture has nothing left to do");
});

// ── progress ──────────────────────────────────────────────────────────────

test("progress counts a failure as settled work, not as zero", () => {
  const chunks = [
    { seq: 0, status: "done", attempts: 1 },
    { seq: 1, status: "failed", attempts: 1 },
    { seq: 2, status: "transcribing", attempts: 1 },
    { seq: 3, status: "pending", attempts: 0 },
  ];
  const p = captureProgress(chunks, () => 30_000);
  assert.equal(p.total, 4);
  assert.equal(p.done, 1);
  assert.equal(p.failed, 1);
  assert.equal(p.inFlight, 1);
  assert.equal(p.waiting, 1);
  assert.equal(p.fraction, 0.5, "done + failed are both settled");
  assert.equal(p.transcribedMinutes, 0.5, "only the transcribed slice counts as minutes");
});

test("progress on an empty plan is zero, not NaN", () => {
  const p = captureProgress([], () => 0);
  assert.equal(p.fraction, 0);
  assert.equal(p.transcribedMinutes, 0);
});

// ── export ────────────────────────────────────────────────────────────────

test("offsets are mm:ss and never negative or NaN", () => {
  assert.equal(formatOffset(0), "00:00");
  assert.equal(formatOffset(59_999), "00:59");
  assert.equal(formatOffset(60_000), "01:00");
  assert.equal(formatOffset(3_723_000), "62:03");
  assert.equal(formatOffset(-1), "00:00");
  assert.equal(formatOffset(Number.NaN), "00:00");
});

test("the plain-text export is one line per segment, silent ones dropped", () => {
  const text = exportCaptureText([
    { startMs: 0, text: "会议开始" },
    { startMs: 30_000, text: "   " },
    { startMs: 60_000, text: "第二段" },
  ]);
  assert.equal(text, "[00:00] 会议开始\n[01:00] 第二段");
  assert.equal(exportCaptureText([]), "");
});

test("the same segments export byte-identically twice (nothing time-dependent)", () => {
  const segments = [
    { startMs: 0, text: "甲" },
    { startMs: 90_000, text: "乙" },
  ];
  assert.equal(exportCaptureText(segments), exportCaptureText([...segments]));
});

// ── the three clients really share it ─────────────────────────────────────

test("web, the mini-program and the app all import this one module", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const clients = [
    "web/src",
    "miniapp/src",
    "app/src",
  ];
  // At least one file per client must reach the shared plan — otherwise that end
  // has its own slicing/retry, which is what the spec forbids.
  for (const dir of clients) {
    const base = path.join(root, dir);
    if (!fs.existsSync(base)) continue;
    const hit = walk(base).find((file) => {
      const src = fs.readFileSync(file, "utf8");
      return /voice-capture-slices|planSlices/.test(src);
    });
    assert.ok(hit, `${dir} has no file importing the shared slice plan`);
  }
});

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}
