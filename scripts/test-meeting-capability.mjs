// Meeting capability switch (openspec: add-ai-native-meeting, task 1.3).
//
// The contract that matters: a meeting entry may exist ONLY when the deployment
// explicitly enabled it AND named a LiveKit URL. Every other combination is
// disabled — because the failure mode of a too-eager default is an entry that
// dies on first click (a media service nobody deployed).
//
// No key material may appear in the boot config: the LiveKit secret is
// server-side only; the client asks for a token.
//
//   node --test scripts/test-meeting-capability.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { meetingEnabled, meetingLivekitUrl, meetingCapability } from "../server/meeting-capability.js";

test("default (no env) is OFF", () => {
  assert.equal(meetingEnabled({}), false);
  assert.equal(meetingLivekitUrl({}), null);
  assert.deepEqual(meetingCapability({}), { enabled: false, livekitUrl: null, recording: { enabled: false } });
});

test("enabled without a URL is still OFF (a half-configured deployment must not render the entry)", () => {
  assert.deepEqual(meetingCapability({ MEETING_ENABLED: "1" }), { enabled: false, livekitUrl: null, recording: { enabled: false } });
});

test("URL without the enable switch is OFF (naming a URL is not consent to run media)", () => {
  assert.deepEqual(meetingCapability({ MEETING_LIVEKIT_URL: "wss://meet.example.com" }), {
    enabled: false,
    livekitUrl: null,
    recording: { enabled: false },
  });
});

test("enabled + URL is the only ON state", () => {
  assert.deepEqual(meetingCapability({ MEETING_ENABLED: "1", MEETING_LIVEKIT_URL: "wss://meet.example.com" }), {
    enabled: true,
    livekitUrl: "wss://meet.example.com",
    // Recording is a SEPARATE switch (4.2): a working meeting does not imply
    // that audio is being kept.
    recording: { enabled: false },
  });
});

test("the enable switch is strict: only the literal '1' turns it on", () => {
  for (const v of ["0", "true", "yes", "", "on"]) {
    assert.equal(meetingEnabled({ MEETING_ENABLED: v }), false, `MEETING_ENABLED=${v} must not enable`);
  }
  assert.equal(meetingEnabled({ MEETING_ENABLED: "1" }), true);
});

test("the capability carries no secret", () => {
  const cap = meetingCapability({
    MEETING_ENABLED: "1",
    MEETING_LIVEKIT_URL: "wss://meet.example.com",
    MEETING_LIVEKIT_API_SECRET: "super-secret-value",
  });
  assert.ok(!JSON.stringify(cap).includes("super-secret"), "no key material in the boot config");
  assert.deepEqual(Object.keys(cap).sort(), ["enabled", "livekitUrl", "recording"]);
  // Same rule for the storage credential (4.2): the browser may learn that
  // recording is ON, never where it goes or with what key.
  const withStore = meetingCapability({
    MEETING_ENABLED: "1",
    MEETING_LIVEKIT_URL: "wss://meet.example.com",
    MEETING_RECORDING: "1",
    MEETING_RECORDING_ENDPOINT: "http://s3.internal:9000",
    MEETING_RECORDING_BUCKET: "private-bucket",
    MEETING_RECORDING_ACCESS_KEY: "AKIA-nope",
    MEETING_RECORDING_SECRET_KEY: "shh-very-secret",
  });
  const wire = JSON.stringify(withStore);
  for (const leak of ["s3.internal", "private-bucket", "AKIA-nope", "shh-very-secret"]) {
    assert.ok(!wire.includes(leak), `the boot config must not leak ${leak}`);
  }
  assert.deepEqual(withStore.recording, { enabled: true }, "the client learns only THAT recording is on");
});
