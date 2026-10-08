---
name: Platform Mini Program
description: The Daylight Pocket — the workbench carried outside: paper ground, white hairline cards, one Pocket Blue, WeChat-native manners.
colors:
  paper: "#f3f4f6"
  card: "#ffffff"
  card-muted: "#f9fafb"
  ink: "#111827"
  ink-secondary: "#374151"
  ink-tertiary: "#4b5563"
  ink-muted: "#6b7280"
  ink-placeholder: "#9ca3af"
  hairline: "#e5e7eb"
  hairline-whisper: "#f3f4f6"
  pocket-blue: "#2563eb"
  pocket-blue-deep: "#1d4ed8"
  pocket-blue-tint: "#eff6ff"
  pocket-blue-line: "#bfdbfe"
  pocket-blue-wash: "rgba(37, 99, 235, 0.12)"
  pocket-blue-faint: "rgba(37, 99, 235, 0.04)"
  code-surface: "#111827"
  code-text: "#e5e7eb"
  error: "#dc2626"
  error-deep: "#b91c1c"
  error-surface: "#fef2f2"
  error-border: "#fecaca"
  success: "#15803d"
  success-surface: "#f0fdf4"
  success-state: "#059669"
  warning: "#92400e"
  warning-surface: "#fef3c7"
  warning-dot: "#f59e0b"
  expired: "#b45309"
  expired-surface: "rgba(217, 119, 6, 0.14)"
typography:
  display:
    fontSize: "44rpx"
    fontWeight: 600
    lineHeight: 1.3
  headline:
    fontSize: "38rpx"
    fontWeight: 600
    lineHeight: 1.4
  title:
    fontSize: "30rpx"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontSize: "28rpx"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontSize: "24rpx"
    fontWeight: 500
    lineHeight: 1.5
  micro:
    fontSize: "22rpx"
    fontWeight: 400
    lineHeight: 1.5
  mono:
    fontFamily: "monospace"
    fontSize: "22rpx"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "6rpx"
  sm: "8rpx"
  md: "10rpx"
  lg: "12rpx"
  bubble: "16rpx"
  card: "20rpx"
  shell: "24rpx"
  cta: "48rpx"
  full: "999rpx"
spacing:
  xs: "4rpx"
  sm: "8rpx"
  md: "12rpx"
  lg: "16rpx"
  xl: "24rpx"
  xxl: "32rpx"
components:
  user-bubble:
    backgroundColor: "{colors.pocket-blue}"
    textColor: "#ffffff"
    typography: "{typography.body}"
    rounded: "{rounded.bubble}"
    padding: "16rpx 20rpx"
  composer-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.shell}"
    padding: "16rpx 20rpx"
  send-button:
    backgroundColor: "{colors.pocket-blue}"
    textColor: "#ffffff"
    rounded: "{rounded.full}"
    size: "64rpx"
  block-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "12rpx 16rpx"
  activity-group:
    backgroundColor: "{colors.card-muted}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "12rpx 16rpx"
  chip-muted:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"
    padding: "8rpx 14rpx"
  sheet-panel:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.shell}"
    padding: "24rpx 28rpx 8rpx"
  session-group-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.bubble}"
    padding: "20rpx 24rpx"
  showcase-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "22rpx"
  cta-primary:
    backgroundColor: "{colors.pocket-blue-deep}"
    textColor: "#ffffff"
    typography: "{typography.title}"
    rounded: "{rounded.cta}"
    padding: "22rpx 0"
---

# Design System: Platform Mini Program

> The WeChat-native dialect of Platform, documented separately from the web workbench (`../DESIGN.md`, "The Night Workbench"). Same product truth, same one-lamp doctrine, different world: this one lives in daylight, on paper, inside WeChat.

## Overview

**Creative North Star: "The Daylight Pocket"**

The web app is a dark room with one lamp on; the mini-program is that same assistant carried outside into daylight. The screen is a sheet of gray paper; everything with structure is a white card laid on it, edged by a 1px hairline; depth is never more than that. One blue — Pocket Blue — is the only saturated voice, and it says exactly one thing: *this is live, this is yours, this acts*. The send button, your own words in their bubble, the link you can tap, the option currently chosen, the tool still running — blue. Everything else is ink on paper.

The manners are WeChat's, not the web's: half-screen sheets slide up over a dimmed page instead of center modals; selectors are pills; the header is a slim white bar with a center chip that knows the capsule sits top-right; the composer respects `safe-area-inset-bottom`. Pages are one vertical stack — chat, login, share, cron — reached by header buttons and back, with no tab bar; **history is not a page** — it is the 85vh drawer that slides up on the chat page (the ☰ surface), sessions capped at 5 visible with 加载更多 so a long history can never push the utility groups (我的分享 / 定时任务 / 服务器) out of reach. Touch targets follow one bar — an **88rpx hit height (44px at 375pt) on every tappable** — because thumbs, not cursors, drive everything; compact inline controls (the chip ✕) extend their hit box with padding rather than growing visually.

Styling is **plain CSS on purpose** (`miniapp/src/app.css`, one file, ~250 classes): weapp-tailwindcss would add a build-layer dependency for a thin client, and literal hex keeps the palette closed and greppable. The client shares contracts and state logic with the web app through `@platform/core` — never styles or tokens.

**Key Characteristics:**

- Light-only paper world: `#f3f4f6` ground, white cards, hairline `#e5e7eb` borders — the inverse staging of the web's dark workbench
- One accent (Pocket Blue `#2563eb`) for action and live work only, in tint/wash/deep steps
- rpx everywhere (750-design-width units; 2rpx = 1css px at 375pt) — never px, never rem
- WeChat-native chrome: half-screen sheets, pills, capsule-aware header, safe-area insets, no tab bar
- Plain CSS, one file, literal hex, closed palette — no Tailwind, no CSS variables, no web tokens
- Two shadows in the whole system, both on floating layers (the outline rail's tab and card)
- Icons are text glyphs (`↗` `↑`) — no icon font, no SVG, no image assets
- Taro 4 + React 18 over the same WS/REST contracts as web; backgrounding kills sockets, so state must survive resume

## Colors

A Tailwind-gray paper-and-ink scale with one blue accent and paired status surfaces; canonical values are the literal hex strings in `miniapp/src/app.css`.

### Primary

- **Pocket Blue** (#2563eb): The only saturated color on any screen. The send button, the user bubble, links, active option rows and checkmarks, running state text, session unread dots, the cron "running" chip. Same one-lamp semantics as the web's Workbench Blue, at the light world's value.
- **Deep Pocket Blue** (#1d4ed8): The hero CTA fill (the unbound welcome's primary button), tint-chip text, and the read-only share banner's text — the one step darker than Pocket Blue the product uses.
- **Pocket Blue Tint / Wash** (#eff6ff / rgba(37,99,235,0.12)): The accent at rest — active option fills, selected segment pills, cron-status chips, the share banner's ground, the in-chat cron card's 0.04 wash. Blue says less when it whispers.
- **Pocket Blue Line** (#bfdbfe): The accent's faintest step — the border of the general showcase card (the tint-filled "you are here" affordance).

### Neutral

- **Paper** (#f3f4f6, `page` background): The ground every card sits on; also whisper dividers between rows and the chip fill at rest.
- **Card** (#ffffff): Every structured surface — blocks, composer, header, group cards, forms.
- **Muted Card** (#f9fafb): The activity-group container, thinking text, quote fills, connection line — a card one breath quieter.
- **Ink** (#111827): Primary text — titles, session rows, option labels, the brand line.
- **Ink Secondary / Tertiary** (#374151 / #4b5563): Block titles, field labels, list body, quote and thinking text.
- **Ink Muted** (#6b7280): Actions, meta, section titles, close buttons, timestamps' siblings — the workhorse quiet voice.
- **Ink Placeholder** (#9ca3af): Placeholders, timestamps, carets, outline indices — the faintest ink that still reads.
- **Hairline** (#e5e7eb): Every 1px border and divider that matters; **Whisper** (#f3f4f6): row separators inside white cards.

### Tertiary

- **Error Red** (#dc2626) on **Error Surface** (#fef2f2) with **Error Border** (#fecaca); deep error text #b91c1c. Failed blocks, revoked shares, the stop button, form errors.
- **Success Green** (#15803d on #f0fdf4) for demo/notice banners; #059669 for the tool "done" state.
- **Warning Amber** (#f59e0b dot) for the quiet connection line; the loud pair (#92400e on #fef3c7) is reserved for blocking banners — none live today; **Expired** (#b45309 on rgba(217,119,6,0.14)) for cron chips.
- **Code Surface** (#111827 with #e5e7eb text): see The Inverted Ink Rule.

### Named Rules

**The One Pocket Rule.** Pocket Blue marks action and live work only — send, the user's bubble, tappable links, the chosen option, running tools, unread dots. If blue decorates, it stops meaning anything. Blue fills with white text stay ≥ AA because the fill is the dark step; quiet blue needs the tint or wash, not a paler solid.

**The Closed Palette Rule.** The palette is exactly this document's hex set. A new screen takes colors from here; it does not introduce a new hex. The one-file plain-CSS setup makes every deviation greppable — keep it that way.

**The Inverted Ink Rule.** Code surfaces flip the world's staging: Ink (#111827) becomes the ground and a paper gray (#e5e7eb) the text. It is the only dark surface in the product — a deliberate "the machine talks here" exception, never a theme, never a second dark mode.

## Typography

**Display Font:** none declared — WeChat's system face (PingFang SC / SF / HarmonyOS Sans per device) inherits everywhere.
**Body Font:** same system face.
**Label/Mono Font:** `monospace` (device default mono) for code and identifiers.

**Character:** The type is the phone's own voice at the phone's own sizes — no font-family declaration exists in the client and none may be added. Size is written in rpx (750-design-width units; 2rpx = 1px at a 375pt screen), so hierarchy survives every device width without media queries.

### Hierarchy

- **Display** (600, 44rpx): Login title and the bind-code input (letter-spacing 16rpx, centered) — the only 40rpx+ text.
- **Headline** (600, 38/34rpx): Markdown `h1`/`h2` and the welcome brand line — the transcript's ceiling.
- **Title** (600, 30rpx): Panel and sheet titles, login submit, cron card schedules, share title.
- **Body** (400, 28rpx): The page base (set on `page`) — transcripts, inputs, session titles, option labels.
- **Label** (500–600, 24–26rpx): Secondary actions, block titles, field labels, section titles, turn actions.
- **Micro** (400, 22rpx, down to 20rpx for code-language tags): Timestamps, states, banners, meta — never below 20rpx.
- **Mono** (400, 22–24rpx): Code blocks, inline code, tool names.

### Named Rules

**The System Voice Rule.** Never declare `font-family` (WeChat's system stack is the voice), never load a webfont, never size in px or rem — rpx only.

**The Content-First Rule.** The transcript is the loudest thing on screen: markdown headings stop at 38rpx and no chrome label (header, banner, sheet title) exceeds 30rpx.

## Layout

Pages are single full-height columns (`100vh` flex, `page` sets the paper ground). The chat page stacks three fixed zones: white header, transcript on paper, composer dock. The header is three regions — left/back button, a center pill chip (session or model+agent, ellipsized, tappable for its sheet), right actions (share ↗, history, cron) — laid out to coexist with WeChat's capsule. Banners (reconnect amber, sign-in blue, demo green) sit directly under the header as full-width tinted strips.

The transcript is a scroll-view whose **children carry the horizontal padding** (turn-wrap 24rpx) — WeChat scroll-views drop side paddings, so padding the scroller produces edge-hugging content. Turns stack with 20rpx between; the user turn is a right-aligned bubble (max-width 560rpx); the assistant turn is full-width text and block cards on paper. An outline rail can hug the right edge (below).

The composer docks at the bottom with `calc(env(safe-area-inset-bottom) + 20rpx)` below it — every bottom-docked surface (composer, sheet scroll, server row) carries the inset. The welcome (unbound or empty state) centers brand + sub-line, a 2-column showcase grid (48% cards, 18rpx gap), a demo-first CTA (48rpx-radius pill), and a recent strip.

### History Drawer

History is a sheet on the chat page, not a destination (`HistoryDrawer`, the ☰ / 查看历史 surface): an 85vh paper-ground panel (24rpx top corners) over the 45% ink mask, white head (「历史」 + 88rpx ✕) and a scroll body carrying the four group cards — 历史会话 (default open), 我的分享, ⏰ 定时任务, 服务器与高级设置. The session list renders **5 rows by default**; 加载更多 (full-width 88rpx row, blue) reveals 15 at a time with an 「已显示 n/总数」 counter, so the groups below stay reachable no matter how long the history grows. Rows are the session-item pattern (unread dot + 28rpx ellipsized title + 22rpx timestamp + per-row ↗ share, all hit-barred); a row tap switches the session in place (`switch_session`) and closes the drawer — no navigation. The list fetches over REST on every open, so the drawer works with the socket down (a failed switch toasts and the drawer stays). The login page is a centered card: 44rpx title, label-over-input fields, a 6-digit spaced code input, the blue submit, and — because WeChat forbids forcing login before value — a visible skip into the demo. The share page (recipient side) is read-only on Muted Card paper with a Pocket Blue Tint info banner.

### Named Rules

**The Scroller Padding Rule.** Horizontal padding lives on the scroll-view's children, never the scroll-view — WeChat drops the latter. Every new scrolling region follows `.turn-wrap`/`.share-body`.

## Elevation & Depth

Depth is cards on paper: a white surface with a hairline is "raised," and that is the entire system. Exactly **two** box-shadows exist — the outline rail's edge tab (`-2px 2px 8px rgba(0,0,0,0.08)`) and its expanded card (`0 4px 16px rgba(0,0,0,0.1)`) — both on a floating layer that appears and disappears.

### Named Rules

**The Floating-Only Shadow Rule.** A shadow asserts "this layer floats and will leave" (the outline rail). Resting cards, blocks, rows, inputs, and buttons are flat hairline surfaces. Emphasis comes from a tint fill or a heavier border — never a shadow.

## Shapes

A radius ladder with meaning: **12rpx** is the workhorse (block cards, inputs, buttons, code blocks, option rows' inner items); **16rpx** for conversational containers (the user bubble, option rows, activity-group and session-group cards, cron cards); **20rpx** for welcome/showcase cards; **24rpx** for the composer card and the half-screen sheet's top corners (`24rpx 24rpx 0 0`); **48rpx** reserved for the hero CTA pill; **999rpx** for every pill (chips, header chip, segment selectors, count pills) and **50%** for circles (send button, dots). Small steps exist for tiny things: 6rpx inline code, 8rpx tables, 10rpx small buttons and the outline tab's asymmetric `10rpx 0 0 10rpx`.

Borders carry state on exactly one component: the in-chat cron card's 6rpx Pocket Blue left edge (with a 0.35-alpha blue border) — the same state-edge idea as the web's tool blocks. Everything else is the neutral hairline.

### Named Rules

**The Soft Mouth Rule.** The composer card (24rpx) and the user bubble (16rpx) are the softest shapes on their page — the surfaces you speak through. Machine content tops out at 12rpx.

## Components

### Chat Header

Navigation is `navigationStyle: "custom"` app-wide — the world owns its top chrome, and the dark native bar is gone. The chat page's slim white bar (hairline bottom) is THE header: three zones — side buttons (back/history glyph Text, 40rpx glyphs), the center pill chip (Paper fill, 999rpx, ellipsized label + caret, max-width 440rpx; disabled at 50% opacity), and right actions. The status bar pads above it and the capsule's lane is reserved on the right (real-px device metrics from `lib/top-insets`), so no control ever sits under the capsule; the conn/demo notice lines render below the bar, never above it. Tapping the chip opens its selection sheet; a "manage" link inside a sheet routes to the full page. Unread badges are dots (12rpx) beside header buttons.

### Page Header

Subpages (history, cron, login, share) share one `PageHeader` primitive: white bar, hairline bottom, status-bar padding above, capsule lane reserved right; a centered 30rpx/600 ellipsized title between an 88rpx back zone (‹, falling back to the chat root when the stack is shallow) and a balancing spacer. The share page — an entry point, not a subpage — takes the header without back and carries the brand (「FD」) so an outsider's first sight names the product.

### Selection Sheet (signature)

The MP's modal: a fixed full-screen root (invisible, delayed 0.25s on close) over a `rgba(17,24,39,0.45)` mask, from which a white panel slides up (0.25s transform) capped at 75vh with `24rpx 24rpx 0 0` top corners. Head is title + close; body scrolls (children-padded) with grouped sections — quiet 24rpx section titles over 28rpx option rows (16rpx radius, active = Pocket Blue Tint fill + blue 600 label + check glyph). Sections separate low-frequency choices; the sheet, not the page, is where settings live.

### Turns

**User:** right-aligned Pocket Blue bubble (16rpx radius, max 560rpx, white text), long-press or tap targets for copy. **Assistant:** full-width stack on paper — plain text (28rpx, Pocket Blue streaming cursor), markdown (flex column, headings per hierarchy, links blue-underlined, code on the Inverted Ink surface, tables as hairline cards, quotes as Muted Card with 6rpx gray left bar, charts as white cards), and block cards. **Turn actions** sit under an assistant turn as 24rpx Ink Muted text buttons (复制 / 重新生成), gap 32rpx. An interrupted turn ends in a 22rpx gray 「已中断」 line — a truncation never masquerades as finished.

### Block Cards & Activity Group

Tool/thinking/cron blocks are white cards (12rpx, hairline) with a head row — glyph icon (26rpx), 25rpx ellipsized title, state text (*running* Pocket Blue / *done* #059669 / *error* Error Red), chevron toggle — expanding to pre-wrap mono detail on the Code Surface. Contiguous tool/thinking work collapses into the **activity group**: a Muted Card container (12rpx, hairline, error variant swaps the border to #fecaca) whose bare header row carries the group title (25rpx, Ink Muted; blue while live, red on error) and whose white body (hairline top divider) stacks the inner block cards. Error groups auto-expand.

### Composer (signature)

One white card (24rpx radius, hairline) on the paper — the page's softest object: attachment/error chips above (999rpx pills, Paper fill; errors on Error Surface), a borderless autogrowing textarea (28rpx, max 240rpx), and a bottom row of ghost attach glyph (40rpx) and the 88rpx round send — Pocket Blue with a white `↑`, swapping in place to Error Red with a white `⏹` stop while streaming; disabled at 30% opacity. Enter never submits during IME composition.

### Chips & Pills

Paper-fill 999rpx pills (22rpx text) for attachments, models, agents; Pocket Blue Wash fills with blue text for selected segments (cron day/segment selectors) and status chips (running); gray pills for paused/completed; Expired and Error surfaces for their statuses. The counted pill on history group headers is Tint fill with Deep Pocket Blue text.

### History Groups

Per time-group white cards (16rpx, hairline): header = 26rpx/600 title + counted pill + caret; body full-bleed with white rows (22/32rpx padding, roomier right for the ↗ glyph), whisper separators, 28rpx ellipsized titles with blue unread dots and 22rpx timestamps, and a per-row share action (Ink Muted glyph). Empty groups say so in Placeholder gray; a blue link fetches more.

### Welcome / Showcase

Centered brand (36rpx/700) + sub-line, then the showcase grid: 2 columns of white 20rpx cards (min-height 140rpx) — name 28rpx/600 over a 2-line-clamped 22rpx description; the "general" card is Tint-filled with a #bfdbfe border. Below: the demo-first CTA (Deep Pocket Blue, 48rpx pill, 30rpx/600 white) with a gray secondary line beneath, and a recent strip (title + time rows over a whisper divider). A slim connection line (Muted Card, amber dot, 22rpx text) or demo line (Success surface) rides the bottom.

### Outline Rail

Collapsed: a 22×56rpx white tab hugging the right edge at ~30% viewport height (asymmetric `10rpx 0 0 10rpx`, the smaller shadow). Expanded: a 60vw (max 320rpx) white card (12rpx, the larger shadow) listing every user turn (Placeholder index + 24rpx ellipsized first line). Jumping scrolls to the turn and flashes it — a 1.2s Pocket Blue wash (14% alpha fading out), the tap-for-everything translation of the web's hover rail.

### Login & Demo

Centered card on paper: 44rpx/600 title, 24rpx gray sub-line, label-over-field stacks (white 12rpx inputs, hairline strokes, Placeholder text), the 6-digit code input (44rpx, letter-spaced, centered), a full-width Pocket Blue submit (12rpx radius, 30rpx white; 50% when disabled), an underline unbind action, and the blue 「先逛逛」 skip — WeChat's forced-login rule means this page must never be a dead end.

## Do's and Don'ts

### Do:

- **Do** keep Pocket Blue for action and live work only — send, bubbles, links, active options, running state, unread dots (The One Pocket Rule).
- **Do** take every color from the Closed Palette; write it as the literal hex from this document.
- **Do** size everything in rpx and let the 750-design scale do the adapting; pad bottom-docked surfaces with `env(safe-area-inset-bottom)`.
- **Do** put horizontal padding on scroll-view children, never the scroll-view (The Scroller Padding Rule).
- **Do** use WeChat's own patterns — half-screen sheets for choices, pills for selectors, the header chip for context — before inventing chrome.
- **Do** mirror the web's doctrine where it costs nothing: flat hairline cards, floating-only shadows, mono for machine identifiers, interrupted turns marked, IME composition sacred.
- **Do** keep every tappable at the 88rpx (44px) hit bar: send, header buttons, option rows, list rows, form buttons; compact inline conveniences (chip ✕, quiet notice links) extend padded hit boxes to ≥ 79rpx (40px) rather than growing visually.

### Don't:

- **Don't** import web tokens (oklch values, dark surfaces, Tailwind classes) into the MP — the worlds share contracts, never styles.
- **Don't** declare `font-family`, load webfonts, or size in px/rem (The System Voice Rule).
- **Don't** add a box-shadow to anything that rests, a gradient, or a second accent hue.
- **Don't** introduce a tab bar or web-style center modals — one vertical stack, header-button navigation, half-screen sheets.
- **Don't** put any control under the status bar or the capsule — every top row pads with the status bar and reserves the capsule lane (`lib/top-insets`), and every page renders its own bar (`PageHeader` / the chat topbar); the native bar never comes back.
- **Don't** let markdown headings exceed 38rpx or chrome labels exceed 30rpx (The Content-First Rule).
- **Don't** use anything but text glyphs for icons — no icon fonts, no SVG assets, no image sprites.
- **Don't** build a dark mode or theme switch — daylight is this world's identity; the dark room is the web's.
