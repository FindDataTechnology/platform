## 1. Fix

- [x] 1.1 In `server/logto-auth.js`, accept `RS256`/`ES256`/`ES384`/`ES512` and verify with the per-algorithm hash plus `dsaEncoding: "ieee-p1363"`. Verify: unit test — an ES384-signed token whose claims are valid verifies true; the same token with a flipped signature byte verifies false; an unsupported `alg` is rejected.
- [x] 1.2 Keep the RS256 path working. Verify: unit test — an RS256 token still verifies true after the change.

## 2. Verify online

- [x] 2.1 Sign in at `https://craw.finddatatech.cloud`. Verify: the app shell renders authenticated (no `?auth_error=`) and `/api/auth/me` reports `authenticated: true` with the signed-in email. **Verified 2026-09-16** — the rebuild/redeploy was already done (`platform` Deployment runs `sha-db713c5`, this fix's own commit). Sign-in lands on `/chat`, no `auth_error`, and `/api/auth/me` → `{"mode":"logto","email":"lawbench-test-admin@findmail.com","authenticated":true}`. (The public URL was 502 first — a stale tunnel, fixed below; not an app fault.)
- [x] 2.2 Drive a real signed-in LLM turn that emits an `echarts` fence. Verify: the chart renders (canvas present) and no stray `pre` code block remains. **Verified 2026-09-16** — `e2e/live-functional.spec.js` against the public URL: `✓ a real signed-in turn renders an echarts fence as a live chart` (canvas present, no `pre`).
