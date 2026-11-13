# Design

## Approach

Map each accepted `alg` to the hash Node needs and pass it to `crypto.verify`, with
`dsaEncoding: "ieee-p1363"` so the raw JWS signature is read the way JOSE encodes it:

```js
const hash = { RS256: "sha256", ES256: "sha256", ES384: "sha384", ES512: "sha512" }[header.alg];
verify(hash, signingInput, { key, dsaEncoding: "ieee-p1363" }, signature)
```

`dsaEncoding` is ignored for RSA keys, so one call shape serves both families and the
existing RS256 path keeps its behavior.

## Alternatives rejected

- **Reconfigure Logto to sign RS256.** Couples the app to one tenant's key choice and
  leaves the identical bug for the next ES* tenant. The verifier should accept what
  the tenant legitimately issues.
- **Convert the raw signature to DER by hand.** Reimplements what `dsaEncoding`
  already provides.

## Notes

The JWKS is fetched once at process start and reused; `keyForHeader` already resolves
by `kid`, so key rotation is out of scope here and unchanged.
