# Fix Logto ID-token verification for ES* algorithms

## Why

Production sign-in at `https://craw.finddatatech.cloud` is broken: every user who
completes Logto sign-in is bounced back to `/?auth_error=token`. Root cause,
confirmed against the live tenant by replaying the app's own callback with a freshly
minted authorization code:

- The token exchange itself succeeds (HTTP 200; `iss`/`aud`/`exp`/`email` all valid),
  so the failure is purely in local ID-token verification.
- Logto signs ID tokens with **ES384**, but `verifyIdToken` allows only `RS256`/`ES256`
  and throws `Unsupported ID token algorithm` before any signature check.
- Allowing the algorithm is not enough: `crypto.verify(null, data, key, signature)` is
  wrong for ECDSA. Node needs the hash named explicitly, and a JWS signature is raw
  `r||s` rather than DER, so `dsaEncoding: "ieee-p1363"` is required.

Live evidence — the app's own flow, replayed in the deployed pod, verifies only as:

```
verify("sha384", { key, dsaEncoding: "ieee-p1363" }, sig) === true
verify(null,     key, sig)                                === false
```

## What Changes

ID-token verification accepts the algorithms a Logto tenant can actually be
configured to sign with, and verifies ECDSA signatures in their JWS encoding.

## Impact

- `server/logto-auth.js` — the algorithm allowlist and the `crypto.verify` call.
- Unit coverage for an ES384 token (positive) and a tampered signature (negative).
