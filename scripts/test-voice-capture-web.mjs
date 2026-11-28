// The web capture surface (openspec: add-voice-capture-lane, 5.1 / 5.2 / 5.3).
//
// The repo has no DOM test harness, so this file covers the surface the way the
// other page tests here do: behaviour through the real client module (`fetch` is
// stubbed, nothing is guessed), plus source assertions for the parts that only
// exist in JSX — the four slice states, the single-shot correction, and the fact
// that publishing into a room goes through a confirmation.
//
//   node --test scripts/test-voice-capture-web.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const api = await import("../web/src/lib/capture-api.ts");
const slices = await import("../packages/core/src/voice-capture-slices.ts");

const SOURCE = path.resolve(import.meta.dirname, "..", "web/src/components/voice/CaptureSession.tsx");
const src = fs.readFileSync(SOURCE, "utf8");
const LOCALES = ["zh-CN", "en", "ja", "fr", "es"].map((l) => ({
  lang: l,
  json: JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, "..", `web/src/locales/${l}/common.json`), "utf8"),
  ),
}));

// ── a fetch that records what the client sent ────────────────────────────────
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init };
    calls.push(call);
    const out = await handler(call);
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      json: async () => out.body,
    };
  };
  return calls;
}

const CAPTURE = {
  id: "cap_1",
  title: "周会",
  status: "recording",
  createdAt: 1,
  expiresAt: 2,
  finishedAt: null,
  budget: { minutes: 120, usd: 6 },
  used: { minutes: 0, usd: 0 },
  mergedText: null,
  originalText: null,
  correctedAt: null,
  roomId: null,
  retainAudioMs: 0,
};

// ── client behaviour ──────────────────────────────────────────────────────

test("create sends only the options it was given, and surfaces the 503 code", async () => {
  const calls = stubFetch(() => ({ status: 201, body: { capture: CAPTURE } }));
  const capture = await api.createCapture({ title: "周会" });
  assert.equal(capture.id, "cap_1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/voice/captures");
  assert.deepEqual(JSON.parse(calls[0].init.body), { title: "周会" });

  stubFetch(() => ({ status: 503, body: { error: "语音功能已停用", code: "voice_disabled" } }));
  const err = await api.createCapture().catch((e) => e);
  assert.ok(err instanceof api.CaptureRequestError);
  assert.equal(err.code, "voice_disabled", "the UI needs the CODE, not the English message");
  assert.equal(err.status, 503);
});

test("a chunk upload carries seq, start_ms, duration_ms and the file", async () => {
  const calls = stubFetch(() => ({ status: 200, body: { chunk: { seq: 3, status: "done", text: "第三段" } } }));
  const blob = new Blob([Buffer.from("riff")], { type: "audio/webm" });
  const out = await api.uploadCaptureChunk("cap_1", { seq: 3, startMs: 90_000, durationMs: 30_000 }, blob);
  assert.equal(out.ok, true);
  assert.equal(out.chunk.text, "第三段");

  const form = calls[0].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("seq"), "3");
  assert.equal(form.get("start_ms"), "90000");
  assert.equal(form.get("duration_ms"), "30000");
  const file = form.get("file");
  assert.ok(file instanceof Blob, "the slice audio rides as a file part");
  assert.match(String(file.name ?? ""), /\.(webm|m4a|ogg|wav)$/);
});

test("a retry sends no file at all — the server kept the slice's audio", async () => {
  const calls = stubFetch(() => ({ status: 200, body: { chunk: { seq: 1, status: "done" } } }));
  await api.uploadCaptureChunk("cap_1", { seq: 1, startMs: 30_000, durationMs: 30_000 }, null);
  const form = calls[0].init.body;
  assert.equal(form.get("file"), null);
  assert.equal(form.get("seq"), "1");
});

test("a lost-response replay is a success, not a second upload", async () => {
  stubFetch(() => ({ status: 200, body: { duplicate: true, chunk: { seq: 0, status: "done", text: "已有文本" } } }));
  const out = await api.uploadCaptureChunk("cap_1", { seq: 0, startMs: 0, durationMs: 30_000 }, new Blob([""]));
  assert.equal(out.ok, true);
  assert.equal(out.duplicate, true);
  assert.equal(api.isDuplicateSuccess(out), true);
  assert.equal(out.chunk.text, "已有文本");
});

test("a per-slice failure is DATA (a row), never a thrown exception", async () => {
  stubFetch(() => ({
    status: 502,
    body: { code: "upstream_error", retryable: false, chunk: { seq: 2, status: "failed", errorCode: "upstream_error" } },
  }));
  const out = await api.uploadCaptureChunk("cap_1", { seq: 2, startMs: 60_000, durationMs: 30_000 }, new Blob([""]));
  assert.equal(out.ok, false);
  assert.equal(out.code, "upstream_error");
  assert.equal(out.retryable, false);
  assert.equal(out.chunk.status, "failed");
  // And the shared plan agrees this row is done trying.
  assert.equal(
    slices.sliceAction({ seq: 2, status: "failed", attempts: 2, retryable: out.retryable }),
    "give-up",
  );
});

test("a 202 with `stopped` is a success that also reports the closed gate", async () => {
  stubFetch(() => ({
    status: 202,
    body: { stopped: "minutes", chunk: { seq: 9, status: "pending" }, budget: { minutes: 120, minutesLimit: 120 } },
  }));
  const out = await api.uploadCaptureChunk("cap_1", { seq: 9, startMs: 270_000, durationMs: 30_000 }, new Blob([""]));
  assert.equal(out.ok, true, "the slice was buffered — that is not an error");
  assert.equal(out.stopped, "minutes");
  assert.equal(out.chunk.status, "pending", "buffered, not transcribed");
});

test("a transport failure is a `network` refusal, not a fake server code", async () => {
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const err = await api.uploadCaptureChunk("cap_1", { seq: 0, startMs: 0, durationMs: 1000 }, new Blob([""])).catch((e) => e);
  assert.equal(err.code, "network");
  assert.equal(err.status, 0);
});

test("into a room always carries confirm:true — the gate is not the UI's to skip", async () => {
  const calls = stubFetch(() => ({ status: 200, body: { ok: true, sessionId: "room-a" } }));
  await api.sendCaptureToRoom("cap_1", "room-a");
  assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId: "room-a", confirm: true });
});

// ── the surface itself ────────────────────────────────────────────────────

test("every slice state has a localized label in all five locales", () => {
  const states = ["pending", "transcribing", "done", "failed"];
  for (const { lang, json } of LOCALES) {
    assert.ok(json.voiceCapture, `${lang}: voiceCapture block missing`);
    for (const s of states) {
      assert.equal(typeof json.voiceCapture.state?.[s], "string", `${lang}: state.${s} missing`);
      assert.notEqual(json.voiceCapture.state[s].trim(), "", `${lang}: state.${s} is blank`);
    }
  }
  // And the component reads them from the same path (not a hand-written table).
  assert.match(src, /voiceCapture\.state\.\$\{/);
});

test("the four states are visually distinguishable, not one generic row", () => {
  // A failed row carries its own border + error text + retry; the others do not.
  assert.match(src, /row\.status === "failed"[\s\S]{0,200}border-status-failed/);
  assert.match(src, /StatusPill status=\{pillKind\(row\.status\)\}/);
  assert.match(src, /row\.status === "failed" &&[\s\S]{0,400}retry\(row\)/);
  // A failed row shows a readable reason, with a fallback for unknown upstream codes.
  assert.match(src, /voiceCapture\.errors\.\$\{row\.errorCode/);
  assert.match(src, /defaultValue: t\("voiceCapture\.errors\.internal_error"\)/);
});

test("correction is single-shot and says so instead of failing on the second click", () => {
  assert.match(src, /disabled=\{corrected \|\|/, "the save button must close after the one correction");
  assert.match(src, /data-testid="capture-correction-spent"/);
  assert.match(src, /voiceCapture\.correctionSpent/);
});

test("publishing into a room goes through a confirmation dialog, never window.confirm", () => {
  assert.equal(/window\.confirm/.test(src), false, "no window.confirm anywhere");
  assert.match(src, /<ConfirmDialog[\s\S]{0,500}voiceCapture\.roomConfirm/);
  assert.match(src, /onClick=\{\(\) => setRoomOpen\(true\)\}/, "the button only opens the dialog");
  // The send itself happens from the dialog's onConfirm, not from the button.
  assert.match(src, /onConfirm=\{\(\) => void sendToRoom\(\)\}/);
});

test("no hardcoded CJK reaches the JSX — every string goes through t()", () => {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const noComments = noBlock.replace(/^\s*\/\/.*$/gm, "");
  const offenders = noComments.split("\n").filter((line) => /[\u4e00-\u9fff]/.test(line));
  assert.deepEqual(offenders, [], `hardcoded Chinese in JSX: ${offenders.slice(0, 3).join(" | ")}`);
});

test("the entry hides itself when the lane is unavailable", () => {
  assert.match(src, /if \(!voice\?\.available\) return null/);
  assert.match(src, /data-testid="capture-open"/);
});

test("progress and segments come from the shared plan, not a local re-derivation", () => {
  assert.match(src, /captureProgress\(/);
  assert.match(src, /formatOffset\(/);
  assert.match(src, /exportCaptureText\(/);
  assert.match(src, /sliceAction\(/);
  // No second retry table of its own.
  assert.equal(/maxAttempts\s*[:=]\s*\d+/.test(src), false, "the retry ceiling must be the shared constant");
});
