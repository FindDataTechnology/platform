// The client half of meeting capture (openspec: meeting-capture-client-wiring,
// tasks 5.1 / 5.2).
//
// The server lane has been complete since add-meeting-capture; what was missing
// was that NOTHING ever created a capture in the meeting shape. The e2e test in
// test-meeting-capture-e2e.mjs calls `createCapture` on the store directly, i.e.
// it borrows an identity the product never had — which is exactly why the live
// acceptance kept landing on `needs_confirmation`.
//
// So this file pins the transport contract the two mobile clients use, in both
// directions:
//   (a) with a meeting context, the create request carries `speakerMode:"session"`
//       and `meetingId` — the two fields the server needs to attribute the
//       stream to the authenticated subject;
//   (b) WITHOUT one, the request object is byte-for-byte the old shape: no new
//       keys at all (the loose capture path must not change);
//   (c) the transport that finally serializes the body adds those keys only when
//       they are present (checked at the source level, because the Taro/Expo
//       bindings cannot be imported into node).
//
//   node --test scripts/test-meeting-capture-client-contract.mjs

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");
const SLICES_FILE = path.join(ROOT, "packages/core/src/voice-capture-slices.ts");

// Both clients import `@platform/core`; node has no tsconfig paths, so the bare
// specifier is mapped to the one module they actually use (same trick as
// test-voice-capture-mobile.mjs — it also proves they reach the SHARED plan).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@platform/core") {
      return { url: pathToFileURL(SLICES_FILE).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const CLIENTS = [
  { name: "miniapp", platform: "miniapp", lib: "miniapp/src/lib/capture-upload.ts", entry: "miniapp/src/components/CaptureEntry.tsx" },
  { name: "app", platform: "app", lib: "app/src/lib/capture-upload.ts", entry: "app/src/components/CaptureEntry.tsx" },
];

/** A transport that records every request and answers like the server would. */
function recordingTransport({ createStatus = 201 } = {}) {
  const calls = [];
  const upload = async (req) => {
    calls.push(req);
    if (req.op === "create") {
      return { status: createStatus, body: { capture: { id: "cap_contract" } } };
    }
    return { status: 200, body: {} };
  };
  return { calls, upload };
}

for (const client of CLIENTS) {
  const mod = await import(pathToFileURL(path.join(ROOT, client.lib)).href);

  test(`${client.name}: meeting context puts speakerMode="session" and meetingId on the create request`, async () => {
    const t = recordingTransport();
    const uploader = mod.createCaptureUploader({
      upload: t.upload,
      platform: { name: client.platform, sliceMs: 30_000 },
    });

    const state = await uploader.startCapture({
      title: "会议记录",
      speakerMode: "session",
      meetingId: "mtg_abc",
    });

    const create = t.calls.find((c) => c.op === "create");
    assert.ok(create, "create request was sent");
    assert.equal(create.speakerMode, "session");
    assert.equal(create.meetingId, "mtg_abc");
    // The client must expose the id afterwards: binding to the meeting happens
    // right after create, and it needs the captureId the server just minted.
    assert.equal(state.captureId, "cap_contract");
  });

  test(`${client.name}: loose capture keeps the old request shape (no new keys)`, async () => {
    const t = recordingTransport();
    const uploader = mod.createCaptureUploader({
      upload: t.upload,
      platform: { name: client.platform, sliceMs: 30_000 },
    });

    await uploader.startCapture({ title: "散装录音" });

    const create = t.calls.find((c) => c.op === "create");
    assert.ok(create, "create request was sent");
    assert.deepEqual(Object.keys(create).sort(), ["op", "title"]);
    assert.equal("speakerMode" in create, false);
    assert.equal("meetingId" in create, false);
  });

  test(`${client.name}: the transport adds the fields only when present`, () => {
    // Source-level pin: the Taro/Expo bindings build the POST body inline and
    // cannot be imported here. An unconditional `speakerMode: req.speakerMode`
    // would put `undefined` on the loose path and change what the server reads.
    const src = fs.readFileSync(path.join(ROOT, client.entry), "utf8");
    assert.match(
      src,
      /\.\.\.\(req\.speakerMode \? \{ speakerMode: req\.speakerMode \} : \{\}\)/,
      "speakerMode must be spread only when present",
    );
    assert.match(
      src,
      /\.\.\.\(req\.meetingId \? \{ meetingId: req\.meetingId \} : \{\}\)/,
      "meetingId must be spread only when present",
    );
  });
}

test("both clients declare the same request fields (no client-specific variant)", async () => {
  const shapes = [];
  for (const client of CLIENTS) {
    const src = fs.readFileSync(path.join(ROOT, client.lib), "utf8");
    const iface = src.slice(src.indexOf("export interface CaptureUploadRequest"), src.indexOf("export interface CaptureUploadResponse"));
    shapes.push({
      name: client.name,
      hasMode: /speakerMode\?: "shared" \| "session";/.test(iface),
      hasMeeting: /meetingId\?: string;/.test(iface),
    });
  }
  for (const s of shapes) {
    assert.equal(s.hasMode, true, `${s.name} declares speakerMode`);
    assert.equal(s.hasMeeting, true, `${s.name} declares meetingId`);
  }
});

// ── the app's OWN locale file, not the web's ───────────────────────────────
//
// `app/src/i18n/index.ts` loads `./zh-CN.json` + `./en.json` — two files that
// have nothing to do with `web/src/locales/*`. So a `t("zhiyu.meeting.x")` in
// app code renders the RAW KEY unless the key is in those two files, and
// `scripts/check-locales.js` cannot see it (it only walks the web locales).
//
// This is not hypothetical: before this change the app already referenced seven
// `zhiyu.meeting.*` keys with ZERO of them present in app's locales, and nothing
// reported it. The miniapp is exempt by design — it has no i18n runtime at all
// (see its `lib/cron-text.ts`), so hardcoded Chinese there is the house style.
test("app: every zhiyu.meeting.* key the app references exists in BOTH app locales", () => {
  const locales = ["zh-CN", "en"].map((name) => ({
    name,
    data: JSON.parse(fs.readFileSync(path.join(ROOT, "app/src/i18n", `${name}.json`), "utf8")),
  }));

  // Collect references from the app's source tree (skip node_modules).
  const refs = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|json)$/.test(entry.name)) {
        for (const m of fs.readFileSync(full, "utf8").matchAll(/zhiyu\.meeting\.([A-Za-z]+)/g)) refs.add(m[1]);
      }
    }
  };
  walk(path.join(ROOT, "app/src"));

  assert.ok(refs.size > 0, "the app really does reference zhiyu.meeting.* keys");
  for (const locale of locales) {
    const block = locale.data?.zhiyu?.meeting ?? {};
    const missing = [...refs].filter((k) => !String(block[k] ?? "").trim());
    assert.deepEqual(missing, [], `${locale.name}: missing or empty meeting keys`);
  }
});

// ── "whose seat is this" must come from the server, not from row order ──────
//
// The bind route attributes a stream to the AUTHENTICATED subject, so the entry
// may only appear once the server says "you are a participant of this meeting".
// Deriving it client-side from the participant list is a different question with
// a different answer: `participants.find(p => p.state !== "abandoned")` returns
// whoever joined FIRST, which is somebody else as soon as two people are in —
// i.e. it would offer "record my stream" to a person who never joined, and the
// bind would then 409 (or, worse, appear to succeed for the wrong seat).
//
// This is a source-level pin: the RN/Taro pages cannot be imported into node.
test("both room pages take MY seat from the server's answer (getOpenMeeting), never from row order", () => {
  const pages = [
    { name: "app", file: "app/src/app/(tabs)/zhiyu/[roomId].tsx" },
    { name: "miniapp", file: "miniapp/src/pages/zhiyu/room/index.tsx" },
  ];
  for (const page of pages) {
    const src = fs.readFileSync(path.join(ROOT, page.file), "utf8");
    assert.doesNotMatch(
      src,
      /setMine\([^)]*participants\.find/,
      `${page.name}: "mine" must not be picked out of the participant list`,
    );
    assert.match(src, /getOpenMeeting\(roomId\)/, `${page.name}: asks the server for my participant row`);
    assert.match(src, /setMine\(open\./, `${page.name}: and stores the server's answer`);
  }
});

// ── the web lane (tasks 2.1 / 2.3) — the third client, same two promises ────
//
// Web ships in the platform bundle and is a React component, so it cannot be
// imported here. But its two load-bearing lines are exactly the ones a careless
// refactor would drop, and before this file nothing checked them at all (the
// verification for 2.1/2.3 was "read the diff"):
//
//   • create declares the meeting shape only when there IS a meeting
//     (otherwise the loose recorder's request changes);
//   • the bind happens AFTER the capture exists, and a failure must not stop
//     the recording — so it is invoked without awaiting the lane's stop.
test("web lane: meeting context on create, and the bind is issued from the created capture", () => {
  const src = fs.readFileSync(path.join(ROOT, "web/src/components/voice/CaptureSession.tsx"), "utf8");
  assert.match(
    src,
    /\.\.\.\(meetingId \? \{ speakerMode: "session" as const, meetingId \} : \{\}\)/,
    "create must declare speakerMode/meetingId only when a meeting is in context",
  );
  assert.match(src, /await bindMeetingCapture\(meetingId, captureId\)/, "the bind uses the meeting + capture ids");
  assert.match(src, /if \(meetingId\) void bindToMeeting\(created\.id\)/, "bind is issued from the created capture, un-awaited");
  assert.match(src, /useState\(meetingRoomId \?\? ""\)/, "the room field starts from the meeting's room");

  const panel = fs.readFileSync(path.join(ROOT, "web/src/components/zhiyu/MeetingPanel.tsx"), "utf8");
  // Only offered to someone the server says joined: the handler may not exist
  // without `mine`, and an unjoined visitor must still get 「加入」instead.
  assert.match(panel, /mine \? \(/, "the `mine` branch gates the entry");
  assert.match(panel, /data-testid="zhiyu-meeting-record-mine"/, "the entry carries the shared testid");
  assert.match(panel, /onRecordMine\(\{ meetingId: meeting\.id, roomId \}\)/, "it hands over the meeting and its room");
});

// ── the container both web recorders hand over ──────────────────────────────
// The 词元 lane refuses webm / ogg / fragmented mp4 (measured 2026-11-15: all
// 400, and each 400 de-rotates the shared audio account for ~1min). So neither
// web surface may prefer a streaming container, and both must route through the
// WAV encoder. This is the guard that keeps the next edit from quietly
// restoring the old preference order.
test("neither web recorder prefers a container the lane refuses", () => {
  const adapter = fs.readFileSync(path.join(ROOT, "web/src/lib/voice-adapter.ts"), "utf8");
  const session = fs.readFileSync(path.join(ROOT, "web/src/components/voice/CaptureSession.tsx"), "utf8");

  // The normal path is the PCM tap; MediaRecorder is the fallback.
  assert.match(adapter, /import \{ encodeWav \} from "\.\/wav-encoder\.ts"/, "composer 走 WAV 编码器");
  assert.match(adapter, /const tap = createPcmCapture\(stream\);/, "composer 先试 PCM 通道");
  assert.match(adapter, /if \(tap\) \{[\s\S]{0,200}return;/, "PCM 通道成功即返回，不再建 MediaRecorder");
  assert.match(adapter, /WAV_TAKE_MIME = "audio\/wav"/, "产物 mime 是 audio/wav");

  assert.match(session, /import \{ encodeWav \} from "@\/lib\/wav-encoder\.ts"/, "采集走同一个 WAV 编码器");
  assert.match(session, /const tap = createBrowserPcmCapture\(stream\);/, "每片先试 PCM 通道");
  assert.match(session, /encodeWav\(\{ chunks: captured, sampleRate: tap\.sampleRate \}\)/, "每片编码成完整 WAV");
  assert.match(session, /type: "audio\/wav"/, "切片 mime 是 audio/wav");

  // The old preference must not be reachable as the FIRST choice again: the
  // candidate list may only appear inside the fallback function.
  const prefLines = adapter.split("\n").filter((l) => l.includes('"audio/webm;codecs=opus"'));
  assert.equal(prefLines.length, 1, "webm 只能出现在回落候选表里一次");
  assert.match(prefLines[0], /\["audio\/webm;codecs=opus", "recording\.webm"\]/, "回落表本身保持不变");
});

// The upload NAME is what the server sniffs the container from, so the slice
// name has to follow the bytes we now produce. This executes the real helper
// instead of reading the source: a `.webm` name on WAV bytes would make the
// lane refuse a file it accepts.
test("切片文件名跟着产物走：wav 切片叫 capture-slice.wav", async () => {
  const { sliceFileName } = await import("../web/src/lib/capture-api.ts");
  assert.equal(sliceFileName(new Blob([], { type: "audio/wav" })), "capture-slice.wav");
  // The fallback paths keep the old names, so a browser without Web Audio still
  // says what it actually produced.
  assert.equal(sliceFileName(new Blob([], { type: "audio/webm;codecs=opus" })), "capture-slice.webm");
  assert.equal(sliceFileName(new Blob([], { type: "audio/mp4" })), "capture-slice.m4a");
  assert.equal(sliceFileName(new Blob([], { type: "audio/ogg;codecs=opus" })), "capture-slice.ogg");
  // An unknown/absent type must still name a container the server will see as
  // webm — the old default, not a guess.
  assert.equal(sliceFileName(new Blob([], { type: "" })), "capture-slice.webm");
});
