// Hermetic tests for the shared visitor identity (chatwoot-ai-handoff 5.x).
//
// The property that matters: an identity is only as good as its hash. Chatwoot's
// widget will accept a bare identifier when the inbox is not hmac_mandatory, so
// producing one without a hash would turn "know the id" into "read the history".
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mintVisitorId, isValidVisitorId, identityForWidget } from "./visitor-identity.js";

test("mint: a fresh id is 32 lowercase hex chars", () => {
  const id = mintVisitorId();
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.ok(isValidVisitorId(id));
});

test("mint: two ids differ (CSPRNG, not a counter)", () => {
  assert.notEqual(mintVisitorId(), mintVisitorId());
});

test("validate: malformed ids are refused", () => {
  for (const bad of ["", "abc", "A".repeat(32), "g".repeat(32), null, undefined, 123]) {
    assert.equal(isValidVisitorId(bad), false, `${String(bad)} must be invalid`);
  }
});

test("identity: the hash is HMAC-SHA256(widget token, id) — the shape Chatwoot verifies", () => {
  const id = mintVisitorId();
  const token = "widget-hmac-token";
  const { identifier, identifier_hash } = identityForWidget(id, token);
  assert.equal(identifier, id);
  const expected = crypto.createHmac("sha256", token).update(id).digest("hex");
  assert.equal(identifier_hash, expected);
});

test("identity: a different token produces a different hash (so a leaked token is scoped)", () => {
  const id = mintVisitorId();
  assert.notEqual(
    identityForWidget(id, "token-a").identifier_hash,
    identityForWidget(id, "token-b").identifier_hash,
  );
});

test("identity: no token is refused, never a silent unsigned identity", () => {
  assert.throws(() => identityForWidget(mintVisitorId(), ""), /no widget hmac token/);
  assert.throws(() => identityForWidget(mintVisitorId(), null), /no widget hmac token/);
});

test("identity: a malformed id is refused before it reaches Chatwoot", () => {
  // A junk id would mint a fresh junk contact on every typo.
  assert.throws(() => identityForWidget("not-an-id", "token"), /malformed visitor id/);
});