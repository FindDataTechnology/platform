// Per-cell credential (harden-cell-isolation 1.1): the gateway mints a token
// that names exactly one cell; a cell accepts only its own, so a stolen token
// impersonates nobody else. Also pins the auth gate's cell-id check and the
// "legacy master is off unless explicitly enabled" rule.

import assert from "node:assert/strict";
import { test } from "node:test";
import { cellCredential, legacyMasterMatches, verifyCellCredential } from "../gateway/cell-credential.js";
import { GATEWAY_SECRET_HEADER, userFromHeaders } from "../server/auth.js";

const MASTER = "master-secret";
const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";

test("a token verifies only for the cell it names", () => {
  const tokenA = cellCredential(MASTER, A);
  assert.equal(verifyCellCredential(tokenA, MASTER), A);
  // A sibling cell's token is not A's credential.
  assert.equal(verifyCellCredential(cellCredential(MASTER, B), MASTER), B);
  // Tampering / foreign master mints nothing.
  assert.equal(verifyCellCredential(tokenA.replace(/.$/, "0"), MASTER), null);
  assert.equal(verifyCellCredential(cellCredential("other-master", A), MASTER), null);
  assert.equal(verifyCellCredential("not-a-token", MASTER), null);
});

test("a cell's auth gate refuses a token minted for another cell", () => {
  const tokenA = cellCredential(MASTER, A);
  const headersA = { [GATEWAY_SECRET_HEADER]: tokenA, "x-forwarded-email": "victim@corp.com" };
  // Cell A accepts its own credential…
  assert.equal(userFromHeaders(headersA, { secret: tokenA, cellId: A })?.email, "victim@corp.com");
  // …and cell B refuses it even when the header value somehow matched.
  assert.equal(userFromHeaders(headersA, { secret: tokenA, cellId: B }), null);
});

test("the shared master is never accepted alongside per-cell tokens", () => {
  const saved = process.env.CELL_CREDENTIAL_LEGACY;
  delete process.env.CELL_CREDENTIAL_LEGACY;
  try {
    assert.equal(legacyMasterMatches(MASTER, MASTER), false, "grey switch is off by default");
    assert.equal(legacyMasterMatches(cellCredential(MASTER, A), MASTER), false);
    process.env.CELL_CREDENTIAL_LEGACY = "1";
    assert.equal(legacyMasterMatches(MASTER, MASTER), true, "explicit rollback still works");
    assert.equal(legacyMasterMatches("wrong", MASTER), false);
  } finally {
    if (saved === undefined) delete process.env.CELL_CREDENTIAL_LEGACY;
    else process.env.CELL_CREDENTIAL_LEGACY = saved;
  }
});
