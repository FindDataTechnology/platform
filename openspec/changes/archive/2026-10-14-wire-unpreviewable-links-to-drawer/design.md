## Context

See proposal.md — Why. Two facts from the current implementation shape the approach:

- The shared rule already exists. `packages/core/src/lib/file-ref.ts` exports both `linkRef` (admits only renderable types, via `EXT_KIND`) and `fileLinkRef` (admits every produced-file type, via `FILE_EXTENSIONS`, which already includes `zip`). The mini program's chip already resolves through `fileLinkRef`; the web's `MarkdownLink` (`web/src/components/Markdown.tsx:136`) resolves through `linkRef`. The web is the narrow side.
- The server is already correct. Probed against the live route: a `.zip` returns `200`, `application/octet-stream`, `Content-Disposition: attachment`. A missing file returns `404`. `HEAD` returns the same status with zero body bytes, so existence is checkable without transferring the file.

## Goals / Non-Goals

**Goals:**

- One link-resolution rule across both clients, so a produced file behaves the same on web and mini program.
- A link to an unrenderable produced file opens the drawer and offers the file.
- No dead-end affordance: a download action is not presented for a file the server cannot serve.

**Non-Goals:**

- No server route change; no new renderer.
- No change to what the turn artifact strip captures (that is the separate follow-up change).
- No change to mini program behavior — it already follows the broader rule.

## Decisions

**Decision: the web adopts `fileLinkRef`; `linkRef` stops gating the chat link path.**

`Markdown.tsx` switches its resolver from `linkRef` to `fileLinkRef`. Alternatives considered: (a) add the missing types to `EXT_KIND` as a `"none"` kind — rejected because `EXT_KIND` maps a type to a renderer, and inventing renderer entries for types with no renderer corrupts the meaning of that table; (b) build a third list for the web — rejected, a third list is what produced this divergence and would produce the next one.

`linkRef` itself is left in place unless it has no remaining callers after the switch (verify during implementation; its current consumers are the web link path and its own re-export). If it becomes unused, removing it is part of this change; if it retains a caller, it stays.

**Decision: the existence check lives in the drawer, not in the link.**

`MarkdownLink` stays synchronous. The drawer's unrenderable-type state confirms the file before presenting download, and reports it unavailable when the check fails. Alternatives considered: (a) check in `MarkdownLink` — rejected: it would put async state and one request per link into a react-markdown renderer that mounts once per link, so a turn linking the same archive twice pays twice; (b) no check — rejected: it leaves the exact dead-end the change is meant to remove, only moved one click later.

The drawer already owns several async states (external-service lookup, busy, failed), and only one drawer is open at a time, so the request count is bounded at one. The check reuses the drawer's existing mount effect rather than adding a second one.

**Decision: the check is a `HEAD` on the same file route.**

Probed: `HEAD` returns `200` for a present file and `404` for an absent one, with no body either way. This keeps the check on the same route and root the download will use, so the answer cannot disagree with the download. Alternatives considered: (a) `POST /api/resources/lookup` — it answers "is this saved as a resource", a different question, and would add a second notion of "exists" to the drawer; (b) a `GET` — reads the whole file to answer a yes/no question.

**Decision: only newly-admitted types pay for the check.**

Types that already had a renderer keep today's optimistic open: their renderers already degrade to the download state on failure, and adding a check would make every image/PDF/markdown link wait on a request it does not need. The check applies exactly to the types the broader rule newly admits.

## Risks / Trade-offs

- **The broader rule changes which chat links intercept the click.** Today a `.json`/`.yaml`/`.xml` link in assistant text navigates; after this change it opens the drawer. A link that happens to name a produced-file extension but that the user wanted to follow as a URL now behaves differently. → Accepted: navigation to a workspace-relative path from the chat origin is already broken (it resolves against the web app's route, not the file route), so the change replaces a broken navigation with a working affordance. The `ordinary links keep their behavior` scenario pins that external URLs are untouched.
- **A link to a file that exists but is not servable for another reason** (outside the allowlisted root) still reaches the drawer and fails at download. → The route's containment rules are unchanged and its rejections remain honest `403`/`404`; the check covers the common case (file gone), not every rejection class.
- **An existing e2e asserts behavior that depends on the current narrowing.** `e2e/session-open.spec.js:384` drives a `.zip` link through the raw route href and its comment states that `linkRef`'s previewable-extension rule does not gate route hrefs. The assertion itself (drawer opens, fallback download works) stays valid under the new rule; the comment becomes wrong and the test gains a sibling case for the relative-path form. → Update the comment and add the relative-path case; do not weaken the existing assertion.
- **Unit tests do not exist for the shared rule**, so the change's blast radius is currently unpinned by fast tests. → Add them as part of this change (see tasks).

## Migration Plan

Client-only change: it ships with the web bundle, no server deploy, no data migration, no version skew (an older cell and a newer client are compatible — the client asks the same route it already asks). Rollback is reverting the client change; the server never changed.
