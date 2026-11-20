// The diarization probe's classifier (openspec: add-speaker-attribution, 1.1).
//
// The probe decides the scope of a whole capability, so its judgement has to be
// testable without the network. The distinction it exists to protect:
//   supported    — a speaker field exists
//   unsupported  — a real transcript, and no speaker field anywhere
//   inconclusive — we were refused, so we learned nothing
// Collapsing the third into the second is how a capability gets cancelled by a
// bad credential, and this repo's own probe run produced exactly that: 401s on a
// key that worked minutes earlier, then 200s with plain text.
//
//   node --test scripts/test-probe-diarization.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The probe is a LIVE script against our own audio lane, so the public snapshot
// excludes it (scripts/probe-*.mjs). Its classifier is the part worth pinning
// offline, and that pin can only live where the probe lives — elsewhere this
// import is MODULE_NOT_FOUND, i.e. red for a reason that has nothing to do with
// diarization. Skip by name with the reason (same shape as
// test-snapshot-build-info.mjs), so the gate states what it could not check.
const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE_ABSENT = existsSync(join(HERE, "probe-diarization.mjs"))
  ? false
  : "the diarization probe is a live script against our audio lane; the public snapshot excludes scripts/probe-*.mjs";

const { classify, findSpeakerEvidence, findGranularity } = PROBE_ABSENT
  ? { classify: null, findSpeakerEvidence: null, findGranularity: null }
  : await import("./probe-diarization.mjs");

const skip = PROBE_ABSENT ? { skip: PROBE_ABSENT } : {};

const json = (o) => JSON.stringify(o);

// ── supported ─────────────────────────────────────────────────────────────

test("a speaker field anywhere is `supported`", skip, () => {
  const shapes = [
    { text: "a", speaker: "SPEAKER_00" },
    { text: "a", speaker_id: 1 },
    { text: "a", segments: [{ start: 0, end: 2, text: "a", speaker: "S1" }] },
    { text: "a", speaker_labels: [{ id: "1", name: "A" }] },
    { text: "a", diarization: [{ speaker: "1", start: 0, end: 2 }] },
    { text: "a", results: { utterances: [{ speakerId: "x", text: "a" }] } },
  ];
  for (const s of shapes) {
    const c = classify(200, json(s));
    assert.equal(c.verdict, "supported", JSON.stringify(s));
    assert.ok(c.evidence.length > 0);
  }
});

test("speaker evidence is found at depth, not only at the top level", skip, () => {
  const nested = { data: { segments: [{ transcript: "x", speaker_label: "A" }] } };
  assert.deepEqual(findSpeakerEvidence(nested), ["data.segments[0].speaker_label"]);
});

// ── unsupported ───────────────────────────────────────────────────────────

test("a real transcript with no speaker field is `unsupported`, not inconclusive", skip, () => {
  const c = classify(200, json({ text: "我们先确认预算，然后讨论排期。" }));
  assert.equal(c.verdict, "unsupported");
  assert.deepEqual(c.evidence, []);
  assert.equal(c.text, "我们先确认预算，然后讨论排期。");
});

test("verbose_json without segments is still unsupported AND has no granularity", skip, () => {
  // This is exactly what the live lane returned: the parameter was accepted and
  // ignored, so a caller that trusted the format name would find nothing.
  const c = classify(200, json({ text: "一句话" }));
  assert.equal(c.verdict, "unsupported");
  assert.deepEqual(c.granularity, { kind: "none", hasStart: false, hasEnd: false });
});

test("segments without speakers still count as unsupported, but record the granularity", skip, () => {
  const c = classify(200, json({ text: "a b", segments: [{ start: 0, end: 1, text: "a" }, { start: 1, end: 2, text: "b" }] }));
  assert.equal(c.verdict, "unsupported");
  assert.deepEqual(c.granularity, { kind: "segment", hasStart: true, hasEnd: true });
});

test("word granularity is detected when the lane provides it", skip, () => {
  assert.equal(findGranularity({ words: [{ word: "a", start: 0, end: 0.2 }] }).kind, "word");
});

// ── inconclusive ──────────────────────────────────────────────────────────

test("a rejected credential is inconclusive, and says so in the reason", skip, () => {
  for (const status of [401, 403]) {
    const c = classify(status, json({ code: "INVALID_API_KEY", message: "Invalid API key" }));
    assert.equal(c.verdict, "inconclusive", `status ${status}`);
    assert.equal(c.code, "INVALID_API_KEY");
    assert.match(c.reason, /credential/);
    assert.match(c.reason, /nothing about diarization/);
  }
});

test("a 400 for an unsupported response_format is inconclusive, not 'no diarization'", skip, () => {
  // diarized_json was rejected outright by the live lane. That is evidence the
  // FORMAT is unsupported, not evidence about the lane's separation ability —
  // the other shapes answered 200 and carried the real answer.
  const c = classify(400, json({ code: "invalid_response_format" }));
  assert.equal(c.verdict, "inconclusive");
});

test("a non-JSON or empty answer is inconclusive", skip, () => {
  assert.equal(classify(200, "<html>gateway</html>").verdict, "inconclusive");
  assert.equal(classify(200, json({})).verdict, "inconclusive");
  assert.equal(classify(200, json({ text: "   " })).verdict, "inconclusive");
});

test("transport-level nonsense never yields a definite verdict", skip, () => {
  assert.equal(classify(0, "transport error: ECONNREFUSED").verdict, "inconclusive");
  assert.equal(classify(502, json({ error: "bad gateway" })).verdict, "inconclusive");
});

test("the classifier never claims support without a field to point at", skip, () => {
  // Random prose about speakers must not be read as a speaker field.
  const c = classify(200, json({ text: "speaker 1 said hello, speaker 2 agreed" }));
  assert.equal(c.verdict, "unsupported");
});
