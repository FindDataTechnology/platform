## Context

The React chat sidebar (`web/src/components/Sidebar.tsx`) hardcodes `href="/"` for Dashboard, Documents, and OpenConnector. The server redirects `/` to `/chat/`, so every non-chat nav click round-trips back to Chat — the legacy vanilla views are unreachable through the new UI even though `server.js` still serves them at `/dashboard`, `/documents`, `/openconnector`, `/litellm` (see `server.js:863`).

## Goals / Non-Goals

**Goals:**
- Make Dashboard / Documents / OpenConnector reachable from the React sidebar again.
- Preserve chat-ui-shell's migration contract: React chat at `/chat`, legacy views at their own paths.
- Gate the LiteLLM link on `litellmEnabled` so it does not appear when unconfigured (same graceful-degradation rule the legacy nav follows).

**Non-Goals:**
- Porting the legacy views into React. That is separate follow-up work with its own OpenSpec changes.
- Any server-side routing changes; the legacy paths already work.

## Decisions

- **Link to legacy paths directly, don't SPA-route them.** The React app owns `/chat`; the legacy views own their own routes. A plain `<a href="/documents">` triggers a full page load, which is exactly what we want — the vanilla client reads `location.pathname` to open its tab. Alternative (client-side prefetch/proxy through `/chat`) buys nothing and re-invites the same class of bug.
- **Read `litellmEnabled` from `/api/config`.** The endpoint already publishes it (`server.js:871`). Sidebar hides the LiteLLM link when false — matches the legacy `public/app.js` behavior and avoids dead links.

## Risks / Trade-offs

- [Risk] The legacy `public/index.html` may drift and stop honoring the pathname-to-tab mapping. → Mitigation: covered by the existing `chat-ui-shell` "Legacy views remain reachable" scenario; no new risk from this change.
- [Risk] Full page navigation loses in-flight React state. → Trade-off accepted: users switching to a legacy view are leaving the React app on purpose; state loss is expected until the views are ported.
