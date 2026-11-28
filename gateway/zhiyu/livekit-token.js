// ── LiveKit access token, minted with node:crypto (add-ai-native-meeting 3.2) ──
//
// The browser must NOT sign its own LiveKit token — that needs the API secret.
// But paas also must not carry the whole livekit-server-sdk to mint one JWT:
// a LiveKit token is a plain HS256 JWT whose `video` grant names the room, and
// `node:crypto` signs that in one line. Verified against the real cluster server
// 2026-11-24: a token minted this way joins successfully.
//
// The secret stays server-side: the route returns the JWT (which the browser
// sends to LiveKit, not to us), never the secret.
import crypto from "node:crypto";

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/**
 * @param {{apiKey:string, apiSecret:string, room:string, identity:string, name?:string, ttlSec?:number}} args
 * @returns {string} a signed JWT
 */
export function mintLivekitToken({ apiKey, apiSecret, room, identity, name = "", ttlSec = 3600 }) {
  if (!apiKey || !apiSecret) throw new Error("livekit apiKey/apiSecret required");
  if (!room || !identity) throw new Error("room and identity required");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: apiKey,
    sub: identity,
    ...(name ? { name } : {}),
    nbf: now,
    exp: now + Math.max(60, ttlSec),
    video: { roomJoin: true, room, canPublish: true, canSubscribe: true },
  };
  const h = `${b64url(header)}.${b64url(payload)}`;
  const sig = crypto.createHmac("sha256", apiSecret).update(h).digest("base64url");
  return `${h}.${sig}`;
}
