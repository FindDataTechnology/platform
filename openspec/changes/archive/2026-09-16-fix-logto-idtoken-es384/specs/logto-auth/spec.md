## ADDED Requirements

### Requirement: ID-token verification accepts the tenant's signing algorithms

ID-token verification SHALL accept the JWS algorithms a Logto tenant can be
configured to issue — `RS256`, `ES256`, `ES384`, and `ES512` — verifying each with
the hash matching that algorithm and with the JWS signature encoding (ECDSA
signatures are raw `r||s`, not DER). An algorithm outside this set SHALL be rejected.

#### Scenario: ES384 verifies
- **WHEN** the ID token is signed `ES384` and every claim check passes
- **THEN** verification succeeds and the signed session cookie is issued

#### Scenario: unknown algorithm is rejected
- **WHEN** the ID token header names an algorithm outside the accepted set
- **THEN** verification fails and the user is redirected to `/?auth_error=token`
