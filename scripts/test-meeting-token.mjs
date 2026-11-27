// Meeting join token (openspec: add-ai-native-meeting 3.2).
//
// The token is the browser's only way into a meeting's media room, so its gates
// matter: room membership, meeting open, joined-that-meeting, and it must carry
// the caller's seat as the LiveKit identity (so the worker's attribution lines
// up). Also pins the zero-dep JWT actually verifies as HS256.
//
//   node --test scripts/test-meeting-token.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mintLivekitToken } from "../gateway/zhiyu/livekit-token.js";

test("minted token is a verifiable HS256 JWT carrying the room grant", () => {
  const jwt = mintLivekitToken({ apiKey: "devkey", apiSecret: "s3cr3t", room: "mtg-x", identity: "a@b.c", name: "A" });
  const [h, p, sig] = jwt.split(".");
  const want = crypto.createHmac("sha256", "s3cr3t").update(`${h}.${p}`).digest("base64url");
  assert.equal(sig, want, "signature verifies");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(header.alg, "HS256");
  assert.equal(payload.iss, "devkey");
  assert.equal(payload.sub, "a@b.c", "identity is the seat");
  assert.equal(payload.video.room, "mtg-x");
  assert.equal(payload.video.roomJoin, true);
});

test("a different secret does NOT verify (the secret is load-bearing)", () => {
  const jwt = mintLivekitToken({ apiKey: "devkey", apiSecret: "right", room: "r", identity: "i" });
  const [h, p, sig] = jwt.split(".");
  const wrong = crypto.createHmac("sha256", "wrong").update(`${h}.${p}`).digest("base64url");
  assert.notEqual(sig, wrong);
});

test("missing key/secret/room/identity is refused, not minted blank", () => {
  assert.throws(() => mintLivekitToken({ apiKey: "", apiSecret: "s", room: "r", identity: "i" }));
  assert.throws(() => mintLivekitToken({ apiKey: "k", apiSecret: "", room: "r", identity: "i" }));
  assert.throws(() => mintLivekitToken({ apiKey: "k", apiSecret: "s", room: "", identity: "i" }));
  assert.throws(() => mintLivekitToken({ apiKey: "k", apiSecret: "s", room: "r", identity: "" }));
});

test("ttl is clamped to a sane floor (a 1s token would be useless)", () => {
  const jwt = mintLivekitToken({ apiKey: "k", apiSecret: "s", room: "r", identity: "i", ttlSec: 1 });
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
  assert.ok(payload.exp - payload.nbf >= 60, "at least 60s");
});
