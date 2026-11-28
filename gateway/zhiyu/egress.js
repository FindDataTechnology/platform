// ── Meeting recording via LiveKit Egress (add-ai-native-meeting 4.2) ─────────
//
// Records each participant's audio as its own OGG file and writes it to the
// deployment's S3-compatible store (RustFS here). One file per speaker — NOT a
// mixed-down track — because it keeps the room's attribution discipline: a file
// names exactly one person, so nobody can ever be credited with someone else's
// words (the same rule the transcript lane enforces with per_stream evidence).
//
// WHY TRACK EGRESS AND NOT ROOM COMPOSITE:
// composite renders a web page in Chrome to produce a mixed MP4. That needs the
// browser runtime, transcodes everything, and throws away who said what. Track
// egress uses the Go SDK directly: no Chrome, one OGG per track, and the file
// name carries the participant. For an audio-only meeting it is both cheaper and
// more truthful.
//
// WHY NO EGRESS SDK:
// paas deliberately carries no livekit dependency (the token is minted with
// node:crypto, and the meeting page keeps livekit-client in its own lazy chunk).
// Egress is exposed over Twirp — plain HTTP POST with a JSON body — so the same
// zero-dependency approach works: sign a JWT with the `roomRecord` grant and
// POST it. Verified against the cluster server 2026-11-24: an unauthenticated
// call returns 401 while a bogus path returns 404, so the route is really there.
import crypto from "node:crypto";

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/**
 * Twirp lives next to the signalling endpoint, but the browser-facing
 * MEETING_LIVEKIT_URL is a ROOT-RELATIVE path (`/livekit`) — deliberately, so one
 * deployment can be reached under more than one hostname. The server cannot
 * resolve a relative path, so recording uses its own absolute in-cluster
 * address. Deriving it from the ws URL when one is given keeps the two in step.
 */
function twirpBase(wsUrl) {
  const raw = String(wsUrl || "").trim();
  if (!raw) throw new Error("livekit http base required for egress");
  if (raw.startsWith("/")) throw new Error(`egress needs an absolute address, got the relative path '${raw}'`);
  return raw.replace(/^ws/, "http").replace(/\/livekit\/?$/, "");
}

/**
 * A JWT that may call the Egress API. `roomRecord` is the grant Twirp checks —
 * unlike a join token it is not scoped to one room, because starting egress is
 * an operator action on the deployment, not a participant action.
 */
export function mintEgressToken({ apiKey, apiSecret, identity = "paas-egress", ttlSec = 300 }) {
  if (!apiKey || !apiSecret) throw new Error("livekit apiKey/apiSecret required");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: apiKey,
    sub: identity,
    nbf: now,
    exp: now + Math.max(60, ttlSec),
    video: { roomRecord: true },
  };
  const h = `${b64url(header)}.${b64url(payload)}`;
  return `${h}.${crypto.createHmac("sha256", apiSecret).update(h).digest("base64url")}`;
}

/** One Twirp call. Returns {ok, status, body}; never throws on an HTTP error. */
async function twirp(service, method, { token, body, httpBase, timeoutMs = 15000 }) {
  const url = `${String(httpBase).replace(/\/+$/, "")}/twirp/livekit.${service}/${method}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 400) }; }
    return { ok: r.ok, status: r.status, body: parsed };
  } catch (e) {
    return { ok: false, status: 0, body: { error: String(e?.message || e) } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start recording ONE participant to `dest`.
 *
 * Participant egress (not TrackComposite) for three reasons that all matter in a
 * meeting where people join late, mute, and step out:
 *   · it takes an IDENTITY, so no track_id has to be resolved first — the file
 *     is named after a person, which is the whole point
 *   · it waits for that person to publish, so starting before they speak is fine
 *   · it follows mute/unpublish and stops by itself when they leave, so nothing
 *     has to reconcile state afterwards
 * TrackComposite would need a track_id per participant and would keep recording
 * silence after they left.
 *
 * @param {object} args
 * @param {string} args.wsUrl        server WS URL (wss://…/livekit); Twirp base derived
 * @param {string} args.apiKey
 * @param {string} args.apiSecret
 * @param {string} args.roomName     media room (meeting.livekitRoom)
 * @param {string} args.identity     the participant to record
 * @param {object} args.dest         {endpoint, bucket, accessKey, secret, region, forcePathStyle}
 * @param {string} args.prefix       object-key prefix, e.g. `mtg-<id>/`
 * @returns {Promise<{ok:boolean, egressId?:string, error?:string, status?:number}>}
 */
export async function startParticipantRecording({ wsUrl, apiKey, apiSecret, roomName, identity, dest, prefix }) {
  const httpBase = twirpBase(wsUrl);
  const token = mintEgressToken({ apiKey, apiSecret });
  const res = await twirp("Egress", "StartParticipantEgress", {
    httpBase,
    token,
    body: {
      room_name: roomName,
      identity,
      // OGG: the only container the audio-only path writes, and it needs no
      // video pipeline. `{publisher_identity}` comes from the participant we
      // named, so the object key states who the file belongs to.
      file_outputs: [{
        file_type: "OGG",
        filepath: `${prefix}{room_name}-{publisher_identity}-{time}.ogg`,
        s3: {
          access_key: dest.accessKey,
          secret: dest.secret,
          endpoint: dest.endpoint,
          bucket: dest.bucket,
          region: dest.region || "us-east-1",
          force_path_style: dest.forcePathStyle !== false,
        },
      }],
    },
  });
  if (!res.ok) return { ok: false, status: res.status, error: res.body?.msg || res.body?.error || `HTTP ${res.status}` };
  return { ok: true, egressId: res.body?.egress_id ?? null };
}

/** Stop one recording. Idempotent from the caller's point of view. */
export async function stopRecording({ wsUrl, apiKey, apiSecret, egressId }) {
  const httpBase = twirpBase(wsUrl);
  const token = mintEgressToken({ apiKey, apiSecret });
  const res = await twirp("Egress", "StopEgress", { httpBase, token, body: { egress_id: egressId } });
  return res.ok ? { ok: true } : { ok: false, status: res.status, error: res.body?.msg || `HTTP ${res.status}` };
}

/** Current state of one egress (used to tell "still recording" from "finished"). */
export async function egressStatus({ wsUrl, apiKey, apiSecret, egressId }) {
  const httpBase = twirpBase(wsUrl);
  const token = mintEgressToken({ apiKey, apiSecret });
  const res = await twirp("Egress", "ListEgress", { httpBase, token, body: { egress_id: egressId } });
  if (!res.ok) return { ok: false, status: res.status, error: res.body?.msg || `HTTP ${res.status}` };
  const item = (res.body?.items || [])[0] || null;
  return { ok: true, egress: item };
}
