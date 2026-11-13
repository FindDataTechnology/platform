# Design: redesign-mp-home

## Context

The MP chat page (entry page) currently stacks up to two full-width status
banners above a three-zone header and a generic welcome (greeting + four
prompt cards). The store already receives everything a showcase needs on
every connect: `agents` (AgentInfo: name/description/icon/tags, incl. the
vertical-pack agents), `sessions` + current, `presets`. The reviewer path
(先体验/退出演示, voluntary sign-in) landed in 0.3.0 and is review-critical.
Web has its own welcome spec (recent-chats strip included); the MP welcome
spec is the one changing here.

## Goals / Non-Goals

**Goals:** one homepage that sells to reviewers/newcomers (showcase + one-hop
try) and stays a good tool (quiet status area, clearer chip); client-only
work; ship as 0.4.0 through a normal review pass.

**Non-Goals:** server/protocol changes; touching the sign-in/demo contracts;
web welcome changes; new i18n machinery (the MP keeps zh literals).

## Decisions

### D1 — Audience split licenses the showcase

Daily users land in their restored session and rarely see the empty state;
the welcome is effectively the newcomer/reviewer/new-session surface. So the
welcome goes showcase-heavy without density guilt, and daily ergonomics are
addressed in the header/status details instead.

### D2 — Showcase built from the live roster, with fallback

Agent cards render from the store's `agents` (chat-mode entries): name +
description, tap = `set_agent` (stays on page). General chat stays a
first-class quick start so the showcase never hides the plain assistant.
When the roster has no catalog agents (bare self-host), the grid is omitted
— prompts + recent strip still render, so the page degrades gracefully.
Card copy comes from `AgentInfo` verbatim; no client-side curation.

### D3 — Unbound state becomes the welcome's primary CTA

The auth banner dissolves into the welcome: primary "先体验" (demo entry),
secondary "去登录". This removes the system-console first screen and puts the
reviewer's conversion path center-stage. The demo-origin notice becomes one
line (演示环境 · 退出) above the welcome content. Connection state degrades
to a slim tap-to-retry indicator — it is diagnostics, not a first-class
citizen of the entry screen. The sign-in contract is untouched: all
navigation to login stays behind user taps.

### D4 — Unbound prompt taps carry context into the demo

An unbound user tapping a suggested prompt enters the demo with that prompt
prefilled (the prompt text is stashed before `switchBase` and applied to the
draft once the demo connects). This turns the showcase's dead-end cards into
one-hop try-outs for exactly the use case the reviewer is looking at.

### D5 — Chip shows agent only; model lives in the panel

The collapsed chip reads the agent name (e.g. "合同审查官 ▾" / "FD ▾"); the
model remains selectable inside the half-screen panel. Rationale: agent
identity is the user's mental model of "who am I talking to"; the model is a
power-user setting. Aligns the MP with the web's agent-first framing without
touching the selection protocol.

### D6 — Recent strip from the store's session list

The welcome lists the top 3 recent sessions (title + relative time) from the
`sessions` the store already holds; tapping loads the session (existing
switch_session path). Mirrors the web welcome's recent-chats concept at MP
density. Hidden when the list is empty (true first-run).

### D7 — Release vehicle

Client-only change → version 0.4.0 via the established wechatide upload +
console resubmission flow. No coordination with server deploys; the server
today already serves everything the new homepage renders.

## Risks / Trade-offs

- [Showcase depends on roster quality] → cards render AgentInfo verbatim; a
  deployment with poor descriptions shows poor cards — acceptable (operator
  curates agents.json), fallback handles emptiness.
- [Welcome grows tall on small screens] → positioning line + cards live
  above the fold, prompts/recent below it; ScrollView already hosts the
  welcome; worst case scrolls.
- [Unbound CTA emphasis vs WeChat rules] → "先体验" is a voluntary tap, not
  forced; browsability preserved; no popups. Strictly within the rule that
  0.2.0's rejection articulated.
- [Another review cycle] → inherent to any client release; the showcase is
  expected to help, not hurt, review outcomes.

## Migration Plan

Pure client change: build, verify bundle, upload 0.4.0, resubmit. Rollback =
previous client version (0.3.0) selectable in the console. No server state,
no flags.

## Open Questions

- Card grid columns (2 vs adaptive) — a visual call at implementation time;
  spec only demands name+description per card.
