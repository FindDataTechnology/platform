// The attribution view (openspec: add-speaker-attribution, 7.1).
//
// The repo has no DOM harness, so behaviour is proved through the real client
// module (fetch stubbed) and the JSX contract is proved by reading the source —
// the same idiom as scripts/test-voice-capture-web.mjs.
//
// The one thing this file is really guarding: `separation` is FOUR states. A
// surface that folds `partial` into `full` claims identities the recording does
// not have, and that is the failure mode the whole capability exists to prevent.
//
//   node --test scripts/test-speaker-attribution-view.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const api = await import("../web/src/lib/capture-api.ts");

const SOURCE = path.resolve(import.meta.dirname, "..", "web/src/components/voice/AttributionPanel.tsx");
const src = fs.readFileSync(SOURCE, "utf8");
const LOCALES = ["zh-CN", "en", "ja", "fr", "es"].map((l) => ({
  lang: l,
  json: JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, "..", `web/src/locales/${l}/common.json`), "utf8"),
  ),
}));

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const out = await handler({ url: String(url), init });
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.body };
  };
  return calls;
}

const payload = (over = {}) => ({
  captureId: "cap_1",
  speakerMode: "shared",
  separated: false,
  attributions: [
    { cluster: "anonymous", startMs: 0, endMs: 30_000, member: null, certainty: "anonymous", basis: "本场未做分离", conflict: null },
  ],
  bindings: [],
  events: [],
  summary: {
    total: 1,
    session: 0,
    bound: 0,
    anonymous: 1,
    separation: "none",
    separated: false,
    dispatchable: 0,
    needsConfirmation: 1,
    conflicts: 0,
  },
  adopted: [],
  ...over,
});

test("the four separation values survive the wire as four distinct answers", async () => {
  for (const separation of ["none", "partial", "full", "not_needed"]) {
    stubFetch(() => ({
      status: 200,
      body: payload({
        separation,
        summary: { ...payload().summary, separation, separated: separation === "full" },
      }),
    }));
    const out = await api.fetchCaptureAttributions("cap_1");
    assert.equal(out.summary.separation, separation, `${separation} must not be normalized`);
    assert.equal(out.summary.separated, separation === "full", "separated is true for FULL only");
  }
});

test("partial is never reported as separated", async () => {
  stubFetch(() => ({
    status: 200,
    body: payload({
      attributions: [
        { cluster: "speaker_1", startMs: 0, endMs: 30_000, member: null, certainty: "anonymous", basis: "匿名簇，尚未贴名", conflict: null },
        { cluster: "anonymous", startMs: 30_000, endMs: 60_000, member: null, certainty: "anonymous", basis: "本场未做分离", conflict: null },
      ],
      summary: { ...payload().summary, separation: "partial", separated: false, total: 2, anonymous: 2 },
    }),
  }));
  const out = await api.fetchCaptureAttributions("cap_1");
  assert.equal(out.summary.separation, "partial");
  assert.equal(out.summary.separated, false);
});

test("a refused binding carries the CODE and the offending member", async () => {
  stubFetch(() => ({ status: 409, body: { code: "member_not_present", detail: { member: "stranger@x.test" } } }));
  const err = await api.bindCaptureCluster("cap_1", "anonymous", "stranger@x.test").catch((e) => e);
  assert.ok(err instanceof api.CaptureRequestError);
  assert.equal(err.code, "member_not_present");
  assert.equal(err.detail.member, "stranger@x.test", "the surface needs to know WHICH member");
});

test("bind and unbind post exactly the documented bodies", async () => {
  const calls = stubFetch(() => ({ status: 200, body: { ok: true, op: "bind", previous: null, attributions: [] } }));
  await api.bindCaptureCluster("cap_1", "speaker_2", "b@x.test");
  assert.equal(calls[0].url, "/api/voice/captures/cap_1/bind");
  assert.deepEqual(JSON.parse(calls[0].init.body), { cluster: "speaker_2", member: "b@x.test" });

  await api.unbindCaptureCluster("cap_1", "speaker_2");
  assert.equal(calls[1].url, "/api/voice/captures/cap_1/unbind");
  assert.deepEqual(JSON.parse(calls[1].init.body), { cluster: "speaker_2" });
});

test("attribution ids are escaped into the path", async () => {
  const calls = stubFetch(() => ({ status: 200, body: payload() }));
  await api.fetchCaptureAttributions("cap_../../etc");
  assert.equal(calls[0].url, "/api/voice/captures/cap_..%2F..%2Fetc/attributions");
});

// ── the JSX contract ──────────────────────────────────────────────────────

test("the panel renders a distinct branch for every separation state", () => {
  for (const s of ["none", "partial", "full", "not_needed"]) {
    for (const { lang, json } of LOCALES) {
      const text = json.speakerAttribution?.separation?.[s];
      assert.equal(typeof text, "string", `${lang}: separation.${s} missing`);
      assert.notEqual(text.trim(), "", `${lang}: separation.${s} is blank`);
    }
  }
  // And the component reads them from the same path rather than a local table.
  assert.match(src, /speakerAttribution\.separation\.\$\{separation\}/);
  assert.match(src, /data-separation=\{separation\}/);
});

test("the panel distinguishes partial from full by MORE than the label", () => {
  // The two states must differ in styling too: a reader skimming must not see
  // 「部分未分离」 rendered in the same calm tone as 「已完成分离」.
  assert.match(src, /separation === "full" \|\| separation === "not_needed"/);
  assert.match(src, /border-status-waiting\/40/, "the not-fully-separated states carry a warning tone");
});

test("a conflict is surfaced with its note and a count", () => {
  assert.match(src, /summary\.conflicts > 0/);
  assert.match(src, /speakerAttribution\.conflictNotice/);
  assert.match(src, /data-testid="attribution-conflict"/);
  // A row whose identity overrode separation is flagged in place too.
  assert.match(src, /row\.conflict &&/);
});

test("pending confirmations point at the existing todo surface, not a second inbox", () => {
  assert.match(src, /speakerAttribution\.pendingHint/);
  assert.match(src, /data-testid="attribution-pending-hint"/);
  // No inline confirm/reject list: that would be the second inbox 6.2 forbids.
  assert.equal(/speakerAttribution\.confirm\b/.test(src), false);
  assert.equal(/<ConfirmDialog/.test(src), false, "nothing here is destructive enough to need one");
});

test("naming is a human action with no suggested answer", () => {
  assert.match(src, /speakerAttribution\.name/);
  assert.match(src, /data-testid=\{`attribution-name-\$\{group\.cluster\}`\}/);
  // No "probably X" affordance: a guess that looks like an answer gets clicked.
  // (Comments are stripped first — the code documents the idea, which is fine.)
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/可能(是|为)/.test(stripped), false);
});

test("no hardcoded CJK in the JSX — all copy goes through t()", () => {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const noComments = noBlock.replace(/^\s*\/\/.*$/gm, "");
  const offenders = noComments.split("\n").filter((line) => /[\u4e00-\u9fff]/.test(line));
  assert.deepEqual(offenders, [], `hardcoded Chinese: ${offenders.slice(0, 3).join(" | ")}`);
});

test("the change trail is rendered so 改绑不追溯 is inspectable", () => {
  assert.match(src, /data\.events\.length > 0/);
  assert.match(src, /speakerAttribution\.op\.\$\{e\.op\}/);
  assert.match(src, /e\.from \?\? "—"/);
  assert.match(src, /e\.actor/);
});

test("the grouping folds by member AND cluster — never by member alone", () => {
  // Two people who share no cluster must stay apart; one person with two
  // clusters must stay two groups (merging would claim continuity).
  assert.match(src, /`\$\{member\}:\$\{row\.cluster\}`/);
  assert.match(src, /`\$\{UNSET\}:\$\{row\.cluster\}`/);
});
