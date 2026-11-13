# Proposal: redesign-mp-home

## Why

The mini-program's entry page serves three audiences — WeChat reviewers,
newcomers, and daily users — but today it reads as a system console: stacked
status banners above a generic chat box, with the vertical-pack agents (the
product's actual differentiation) invisible until you open a picker. The
welcome state has no product positioning, unbound users hit a dead-end on the
suggested prompts, and the three-zone header's combined chip is cryptic. The
homepage should sell the product in three seconds and stay a good tool all
day.

The audience split makes both goals compatible: daily users land in their
restored session and almost never see the welcome state, so the welcome can
be a showcase without taxing density, while daily ergonomics live in the
header/status/composer details.

## What Changes

- **Welcome → product showcase**: positioning line, an agent-card grid built
  from the existing `agents` roster (`name/description/icon` already arrive
  via `list_agents` — no protocol change), a general-chat quick start,
  retained suggested prompts, and a recent-sessions strip (top sessions from
  the session list the store already holds; mirrors the web welcome's
  "recent chats" concept). Graceful fallback to a prompts-only layout when
  the roster is empty (e.g. bare self-hosted deployments).
- **Status consolidation**: the unbound state moves INTO the welcome as its
  primary call-to-action ("先体验" with "去登录" secondary) instead of a
  full-width banner; the demo-origin notice becomes one lightweight line;
  connection trouble degrades from a banner to a slim top indicator with
  tap-to-retry. No stacked banners on the first screen.
- **Dead-end prompts fixed for unbound users**: tapping a suggested prompt
  while unbound enters the demo sandbox directly, carrying that prompt into
  the demo draft — one hop from "see" to "try".
- **Header micro-interactions**: the collapsed chip shows the agent name
  only (model moves inside the selection panel); plus small composer/header
  polish items.
- **Release**: ships as client version 0.4.0 and goes through a normal
  WeChat review pass (every client release does; no extra cost beyond the
  cycle).

Non-goals: no server/protocol changes (all data is already client-side); no
changes to the sign-in contract or the demo-sandbox mechanics (review-critical
affordances — browsable-before-login, voluntary sign-in, zero popups — are
preserved verbatim); no web-app changes (the web welcome is a separate
surface with its own spec).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `miniprogram-client`: the empty-session welcome requirement changes from a
  prompts-only block to the showcase layout (agent cards, positioning,
  recent-sessions strip, unbound prompt behavior); the three-zone header
  requirement's chip label and banner-independence wording change; a new
  requirement covers the consolidated status/sign-in area.

## Impact

- `miniapp/src/pages/chat/index.tsx` (welcome section, banners → status
  area, unbound CTA wiring), `miniapp/src/app.css` (showcase + status
  styles), possibly `miniapp/src/components/` for an agent-card component.
- Store data already present: `agents`, `sessions`, `turns` (via the
  INITIAL_QUERIES the runtime replays on connect).
- Spec deltas only in `miniprogram-client`; no other capability touched.
- Release: wechatide upload 0.4.0 → console resubmission (user's final step,
  as with 0.3.0).
