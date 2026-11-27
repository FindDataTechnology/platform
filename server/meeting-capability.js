// ── Meeting capability switch (add-ai-native-meeting, task 1.3) ─────────────
//
// The self-hosted meeting face is OFF by default and turns on only with an
// explicit deployment decision. This is deliberately the OPPOSITE default from
// the copilot dock (which predates its flag and defaults on): a media service
// that is not deployed — or deployed but not yet bandwidth-verified — must not
// render an entry that fails on first click.
//
// Two facts the flag carries to the client, and only these:
//   • enabled — should any meeting entry exist at all
//   • livekitUrl — where to connect (null when disabled)
//
// It carries NO key: the LiveKit API secret stays server-side. The client asks
// the server for a join token (POST /api/meeting/token); the secret never ships.
export function meetingEnabled(env = process.env) {
  return env.MEETING_ENABLED === "1";
}

/** The LiveKit signalling URL the browser would connect to (ws:// or wss://). */
export function meetingLivekitUrl(env = process.env) {
  if (!meetingEnabled(env)) return null;
  const url = String(env.MEETING_LIVEKIT_URL || "").trim();
  return url || null;
}

/**
 * What the boot config exposes. Absent (older servers) ⇒ the web reads it as
 * disabled, which is the safe direction: no entry, no failed click.
 */
export function meetingCapability(env = process.env) {
  const enabled = meetingEnabled(env) && Boolean(meetingLivekitUrl(env));
  return { enabled, livekitUrl: meetingLivekitUrl(env), recording: recordingCapability(env) };
}

/**
 * Recording is a SEPARATE switch from the meeting itself (add-ai-native-meeting
 * 4.2). Turning on a meeting must not silently start keeping audio: recording is
 * the kind of capability whose consent has to be explicit, and a deployment with
 * no storage configured must not advertise an entry that fails on click. So this
 * is on only when every piece is present — a bucket, an endpoint, a credential —
 * and the flag is set.
 *
 * The client sees only `{enabled}`; never the bucket, the endpoint or the key.
 */
export function recordingCapability(env = process.env) {
  // Deliberately ONE key. `configured` (the flag set but a piece missing) is an
  // operator fact, not a client one — returning it here would put a
  // never-true-for-the-browser field into the boot config and blur "off"
  // with "broken". recordingMisconfigured() answers that question instead.
  return { enabled: recordingEnabled(env) };
}

/** Is recording genuinely usable — flag set AND every piece present? */
function recordingEnabled(env) {
  if (env.MEETING_RECORDING !== "1") return false;
  return Boolean(
    String(env.MEETING_RECORDING_BUCKET || "").trim() &&
    String(env.MEETING_RECORDING_ENDPOINT || "").trim() &&
    String(env.MEETING_RECORDING_ACCESS_KEY || "").trim() &&
    String(env.MEETING_RECORDING_SECRET_KEY || "").trim(),
  );
}

/**
 * Operator-facing: the switch is on but something is missing, so recording will
 * 409 on the first segment. Server logs use this so the failure is visible
 * before a meeting, not during one.
 */
export function recordingMisconfigured(env = process.env) {
  return env.MEETING_RECORDING === "1" && !recordingEnabled(env);
}

/** The storage handle, server-side only. Throws nothing: returns null if unset. */
export function recordingStore(env = process.env) {
  if (!recordingEnabled(env)) return null;
  return {
    endpoint: String(env.MEETING_RECORDING_ENDPOINT).trim(),
    bucket: String(env.MEETING_RECORDING_BUCKET).trim(),
    accessKey: String(env.MEETING_RECORDING_ACCESS_KEY).trim(),
    secretKey: String(env.MEETING_RECORDING_SECRET_KEY).trim(),
    region: String(env.MEETING_RECORDING_REGION || "us-east-1").trim(),
  };
}
