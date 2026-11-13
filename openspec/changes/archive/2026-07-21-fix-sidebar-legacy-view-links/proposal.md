## Why

The React chat sidebar links Dashboard, Documents, and OpenConnector to `/`, but `/` now redirects to `/chat/`, so clicking any of those tabs bounces the user right back to Chat. The legacy vanilla views under `/dashboard`, `/documents`, `/openconnector` (and `/litellm`) are still served by `server.js` — they're just unreachable from the new UI, which contradicts the `chat-ui-shell` spec's guarantee that legacy views remain reachable during migration.

## What Changes

- Point the React sidebar's non-chat nav links to their real legacy paths (`/dashboard`, `/documents`, `/openconnector`) instead of `/`.
- Add a `LiteLLM` sidebar link when `LITELLM_BASE_URL` is configured, wired to `/litellm` (parity with the legacy nav and closes the gap surfaced while auditing).

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `chat-ui-shell`: tighten the "Legacy views remain reachable" requirement to state that the React sidebar SHALL link each non-chat nav item to its own legacy path, not to `/`.

## Impact

- `web/src/components/Sidebar.tsx` — fix hardcoded `href="/"` for Dashboard, Documents, OpenConnector; add LiteLLM link gated on config.
- `web/src/hooks/useChatStore.ts` (or wherever `/api/config` is consumed) — expose `litellmEnabled` if not already, to gate the LiteLLM link.
- No server-side changes: `server.js:863` already serves `/documents`, `/openconnector`, `/dashboard`, `/litellm` from `public/index.html`.
- Requires `npm run web:build` (or the postinstall) to ship the fix.
