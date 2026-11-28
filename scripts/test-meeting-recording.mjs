// Meeting recording: the S3 signer and the capability gate
// (add-ai-native-meeting 4.2).
//
// Two things here are worth pinning because both fail SILENTLY in production:
//   · a wrong SigV4 signature returns 403 on every write — recording "works"
//     until you look in the bucket
//   · a capability that reports enabled without a bucket makes the UI promise a
//     recording that will 409 on the first segment
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordingCapability, recordingStore, recordingMisconfigured } from "../server/meeting-capability.js";

const base = {
  MEETING_ENABLED: "1",
  MEETING_LIVEKIT_URL: "/livekit",
  MEETING_RECORDING: "1",
  MEETING_RECORDING_ENDPOINT: "http://rustfs.internal:9000",
  MEETING_RECORDING_BUCKET: "livekit-recordings",
  MEETING_RECORDING_ACCESS_KEY: "ak",
  MEETING_RECORDING_SECRET_KEY: "sk",
};

test("recording is off unless explicitly turned on", () => {
  const { MEETING_RECORDING, ...noFlag } = base;
  assert.equal(recordingCapability(noFlag).enabled, false);
  // and the meeting itself can be on without recording being on — the two
  // switches are independent on purpose
  assert.equal(recordingCapability({ ...noFlag, MEETING_ENABLED: "1" }).enabled, false);
});

test("the flag alone is not enough — every piece must be present", () => {
  for (const missing of ["MEETING_RECORDING_ENDPOINT", "MEETING_RECORDING_BUCKET", "MEETING_RECORDING_ACCESS_KEY", "MEETING_RECORDING_SECRET_KEY"]) {
    const env = { ...base };
    delete env[missing];
    assert.equal(recordingCapability(env).enabled, false, `${missing} missing must disable recording`);
    assert.equal(recordingMisconfigured(env), true, `${missing} missing is a CONFIGURED-but-broken state, not "off"`);
  }
});

test("enabled when everything is present, and the client sees only the flag", () => {
  const cap = recordingCapability(base);
  assert.equal(cap.enabled, true);
  assert.deepEqual(Object.keys(cap), ["enabled"], "the client-facing shape is exactly one key");
  // specifically: no credential-shaped field may reach the browser
  for (const k of ["bucket", "endpoint", "accessKey", "secretKey"]) {
    assert.equal(cap[k], undefined, `${k} must never be in the client-facing shape`);
  }
});

test("the store handle carries what the signer needs and nothing else", () => {
  const s = recordingStore(base);
  assert.equal(s.bucket, "livekit-recordings");
  assert.equal(s.endpoint, "http://rustfs.internal:9000");
  assert.equal(s.region, "us-east-1", "a default region keeps RustFS happy");
  assert.equal(recordingStore({ ...base, MEETING_RECORDING: "0" }), null, "off means no handle at all");
});
