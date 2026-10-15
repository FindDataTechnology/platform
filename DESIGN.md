---
name: Platform
description: A calm, precise workbench that follows the light — one blue lamp marks the live work, from noon to night.
colors:
  primary: "light-dark(oklch(0.48 0.16 250), oklch(0.64 0.16 250))"
  primary-foreground: "oklch(0.99 0 0)"
  primary-deep: "oklch(0.53 0.16 250)"
  ring: "light-dark(oklch(0.52 0.15 250), oklch(0.55 0.15 250))"
  background: "light-dark(oklch(0.98 0 0), oklch(0.16 0 0))"
  foreground: "light-dark(oklch(0.22 0 0), oklch(0.96 0 0))"
  card: "light-dark(oklch(1 0 0), oklch(0.19 0 0))"
  muted: "light-dark(oklch(0.96 0 0), oklch(0.23 0 0))"
  muted-foreground: "light-dark(oklch(0.48 0 0), oklch(0.65 0 0))"
  secondary: "light-dark(oklch(0.96 0 0), oklch(0.24 0 0))"
  border: "light-dark(oklch(0.90 0 0), oklch(0.28 0 0))"
  scrim: "light-dark(oklch(0.44 0 0 / 0.40), oklch(0 0 0 / 0.60))"
  destructive: "light-dark(oklch(0.52 0.22 25), oklch(0.62 0.22 25))"
  destructive-deep: "light-dark(oklch(0.52 0.22 25), oklch(0.55 0.22 25))"
  destructive-foreground: "oklch(0.99 0 0)"
  success: "light-dark(oklch(0.52 0.15 145), oklch(0.72 0.17 145))"
  warning: "light-dark(oklch(0.52 0.14 85), oklch(0.80 0.15 85))"
typography:
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 2
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.75
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.625
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.5
  mono:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "16px"
  base: "10px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary-deep}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "8px 16px"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "8px 16px"
  button-ghost:
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "8px 16px"
  input-default:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "8px 12px"
  chip-muted:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  card-panel:
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "16px"
  nav-item-active:
    backgroundColor: "{colors.primary-deep}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  user-bubble:
    backgroundColor: "{colors.primary-deep}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    padding: "8px 16px"
  composer-shell:
    backgroundColor: "{colors.background}"
    rounded: "{rounded.xl}"
    padding: "8px 12px"
  tool-block:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
---

# Design System: Platform (web)

> This file documents the **web workbench** (browser + Electron, one identical UI). The WeChat mini-program is a second design language documented separately in `miniapp/DESIGN.md` ("The Daylight Pocket"). The two worlds share product truth and the one-lamp doctrine, not values.

## Overview

**Creative North Star: "The Night Workbench"**

Platform is a workbench with one lamp on. The interface is the surface the owner keeps open all day: quiet neutral surfaces, hairline borders, and a single blue accent that means exactly one thing — *work is happening here*. When the assistant streams, when a field takes focus, when the user speaks (the blue bubble), the lamp is on. Everything else recedes so the work is the brightest thing on screen.

The room now has windows: every color token is a `light-dark()` pair and `color-scheme` decides which half applies — follow the OS by default (no JavaScript, no flash), or one `data-theme` attribute on `<html>` for an explicit choice. The dark half is the original palette, unchanged; the light half is its daylight translation, with `card` above `background` in both themes so a raised surface reads raised anywhere. Contrast is enforced, not eyeballed: `scripts/test-palette-contrast.mjs` parses the token file and fails the pairing that drops below WCAG AA in either theme. The lamp logic survives the daylight unchanged — one blue, tonal layering, shadows only on detached layers.

The feel is calm, precise, utilitarian. Surfaces never lift or glow; state changes are decisive color swaps, not movements. Density is compact — 12–14px body text, 6px paddings on rows, tight vertical rhythm — because this is an Operate surface: the visitor completes tasks, scans status, and reads transcripts, often for hours. The chat transcript is the product's center; every panel (Knowledge, Models, Extensions, Agents, Tasks, Status) is a quiet toolshed behind it, now gathered under one Settings roof. The system runs identically in the browser and the Electron desktop app, so nothing may assume browser chrome, custom fonts, or a network-loaded asset.

**Key Characteristics:**

- Dual-theme by one mechanism: every token a `light-dark(<light>, <dark>)` pair; `color-scheme` picks the half — nothing themes any other way
- Neutral tonal layering (light: 0.98 paper → 1.00 card → 0.96 muted; dark: 0.16 → 0.19 → 0.23) plus 1px hairlines; depth is lightness, never shadow
- One accent (Workbench Blue) with strict semantic scope: live work only
- System font stacks, zero webfonts — the type is meant to be invisible
- Compact, information-dense: fixed 240px rail (or its below-md overlay drawer), centered 768px transcript
- Shadows mark *detached* layers only (menus, dialogs, toast, the mobile drawer); everything resting is flat
- Monospace is a first-class voice: tool names, code, skills, identifiers
- One icon language: Lucide everywhere, no emoji in the UI

## Colors

A neutral near-monochrome ramp with one blue accent and three status signals; OKLCH `light-dark()` pairs are the canonical format, defined once in `web/src/styles/globals.css` `@theme` under shadcn/ui naming. Dark values are the original lineage; light values are their AA-cleared translations.

### Primary

One blue in two lightness steps — same hue (250), same chroma (0.16); only the lightness differs, and the bright step itself splits per theme because one value cannot carry as text against both near-black and near-white.

- **Workbench Blue** (`light-dark(oklch(0.48 0.16 250), oklch(0.64 0.16 250))`, `primary`): The lamp's light — text, links, focus borders, running-tool edges, tints on the base surfaces. Each half clears AA as text against its own theme's surfaces.
- **Deep Workbench Blue** (oklch(0.53 0.16 250), `primary-deep`): The lamp's housing — every filled surface that carries white text: the user's message bubble, the active nav item, primary buttons, the send/stop control. One value in both themes because oklch(0.99 0 0) on it is 5.15:1 either way.
- **Focus Blue** (`light-dark(oklch(0.52 0.15 250), oklch(0.55 0.15 250))`, `ring`): The focus ring token — sits outside controls as a 2px ring with a 2px offset, clearing 3:1 against its theme's worktop.

### Neutral

- **Worktop** (`light-dark(oklch(0.98 0 0), oklch(0.16 0 0))`, `background`): The root surface — page canvas and the composer's inner field.
- **Card Surface** (`light-dark(oklch(1 0 0), oklch(0.19 0 0))`, `card` / `popover`): The raised-but-flat layer for the sidebar, headers, popovers, and toast. Deliberately above `background` in both themes.
- **Quiet Surface** (`light-dark(oklch(0.96 0 0), oklch(0.23 0 0))`, `muted`): Hover fills, session-row current state, chips, code-block inline background; at 40% opacity it backs thinking/tool blocks.
- **Raised Surface** (`light-dark(oklch(0.96 0 0), oklch(0.24 0 0))`, `secondary` / `accent`): Secondary buttons and ghost-hover fills — the top step of the neutral ramp.
- **Hairline Gray** (`light-dark(oklch(0.90 0 0), oklch(0.28 0 0))`, `border` / `input`): Every border and input stroke in the product.
- **Dim Gray** (`light-dark(oklch(0.48 0 0), oklch(0.65 0 0))`, `muted-foreground`): Secondary text — labels, timestamps, placeholders, block headers.
- **Soft White / Ink** (`light-dark(oklch(0.22 0 0), oklch(0.96 0 0))`, `foreground`): Primary text on every surface.
- **Scrim** (`light-dark(oklch(0.44 0 0 / 0.40), oklch(0 0 0 / 0.60))`, `scrim`): The backdrop behind dialogs and the below-md nav drawer — a token, not `bg-black/60`, so daylight gets a lighter veil where near-opaque black would jar.

### Tertiary

- **Error Red** (`light-dark(oklch(0.52 0.22 25), oklch(0.62 0.22 25))`, `destructive`): Error text and destructive outlines.
- **Deep Error Red** (`light-dark(oklch(0.52 0.22 25), oklch(0.55 0.22 25))`, `destructive-deep`): The fill step under white text — destructive buttons. (0.62 under white is 3.9:1, an AA fail that once shipped unnoticed on the Delete confirm; the split exists so it can't return.)
- **Done Green** (`light-dark(oklch(0.52 0.15 145), oklch(0.72 0.17 145))`, `success`): Connected status dot, completed-tool left rail.
- **Pending Amber** (`light-dark(oklch(0.52 0.14 85), oklch(0.80 0.15 85))`, `warning`): Connecting status dot.

### Named Rules

**The One Lamp Rule.** Workbench Blue appears on ≤10% of any screen and always means live work: streaming, focus, selection, active navigation, or the user's own words. If blue is used decoratively, the lamp goes out — the accent dies.

**The One Mechanism Rule.** A color themes exactly one way: a `light-dark()` pair in the `@theme` block, resolved by `color-scheme`. No per-component light variants, no `[data-theme]` forks below the token layer, no hand-written theme hex in JSX. `scripts/test-palette-contrast.mjs` gates every pair at WCAG AA in both halves — run it after touching any value.

**The Dead Navy Rule.** The 2019-era navy palette of the pre-redesign vanilla page is a confirmed anti-reference. No navy, no desaturated steel blues, no second accent hue.

## Typography

**Display Font:** none — no display tier exists.
**Body Font:** system sans (ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif)
**Label/Mono Font:** system mono (ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace)

**Character:** The pairing is deliberately anonymous — native platform type at native rendering, chosen so the chat feels like the OS it runs in (and so the Electron desktop app and browser are pixel-identical with zero font loading). Monospace carries the machine's voice: tool names, code, skill identifiers.

### Hierarchy

- **Headline** (600, 24px, line-height 2): One per panel page — the page title; the welcome screen's greeting.
- **Title** (600, 18px / 16px): Panel sub-sections; markdown `h1`/`h2` render at 18px/16px so the transcript never shouts.
- **Body** (400, 14px, line-height 1.625): Chat transcript, markdown prose, composer input, tables. The workhorse size.
- **Label** (500, 12px): Buttons, nav items, inputs, chips, tool-block headers. The most common size in the product.
- **Micro** (400–600, 10–11px): Timestamps (10px), code-block language headers (10px, uppercase, wide tracking). Never below 10px.
- **Mono** (400–600, 12px, `0.85em` inline): Tool names, code fences (Shiki), skill blocks, command tokens.

### Named Rules

**The Invisible Type Rule.** System stacks only. Never introduce a webfont, icon font, or remote-loaded type — the font swap must stay invisible and the desktop bundle stays self-contained.

**The Content-First Rule.** The transcript is the loudest thing on screen. Markdown headings top out at 18px; no panel heading, chrome label, or status line may outsize the words the agent produces.

## Layout

A fixed-rail shell: `grid-cols-[240px_1fr]` at `100dvh`, `overflow-hidden` on wide viewports. The left rail (240px, Card Surface, hairline right border) stacks brand → nav → Workspaces header → session list grouped by workspace (scrolls) → footer (agent select, model chip, status dot, locale, settings). **Below `md` (768px)** the same 240px rail becomes an off-canvas overlay drawer — scrim backdrop (click dismisses), toggle in the chat header — so mobile navigation is the same rail, floating, not a second pattern.

The chat transcript centers at `max-w-3xl` (768px) with 24px between turns; the composer docks full-width beneath it with its field matching the same 768px. Panel content now lives in two containers: the Settings modal (dialog over the chat) and standalone pages (`/agents`, `/bots`, `/trace/:turnId`, `/tasks`) centered at `max-w-4xl` (896px) with 24px page padding. The public share view (`/share/:token`) is read-only, `max-w-4xl`, and exempt from every auth posture. The chat header is sticky (`bg-card/95` + `backdrop-blur`) over the scrolling transcript.

Density is compact: 4px is the smallest gap, 8/12/16px carry most spacing, 24px separates regions. Rows are 12px-type with 6px vertical padding. The structural breakpoints are `md` (768px — rail ↔ drawer) and `sm` (welcome prompt grid 1 ↔ 2 columns).

All copy resolves through i18n bundles (zh-CN first; en/es/fr/ja follow), so labels must survive both Chinese and Latin widths — favor truncation (`truncate`) over fixed widths.

## Elevation & Depth

Depth is tonal, not optical. Each theme stacks its neutral lightness steps (dark: 0.16 → 0.19 → 0.23 → 0.24; light: 0.98 → 1.00 → 0.96 → 0.96) separated by 1px hairlines; a surface "raises" by getting lighter (dark) or whiter (light), and that is the whole depth system. Two blur effects exist as utility, not decoration: the sticky chat header (`bg-card/95 backdrop-blur`) and the dialog scrim (`backdrop-blur-sm` over the `scrim` token).

### Shadow Vocabulary

- **Floating** (`box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)` — `shadow-lg`): The only shadow in the system. Detached layers only: popovers, context menus, the settings menu, toast, dialogs.

### Named Rules

**The Floating-Only Shadow Rule.** A box-shadow asserts "this layer is detached and will disappear." Resting cards, rows, inputs, and buttons are flat. If a surface needs emphasis, shift its tone or add a hairline — never a shadow.

## Shapes

The form language is small-radius geometry: 6px (`rounded-md`) is the default for every control, row, block, and panel section; 8px (`rounded-lg`) steps up for dialogs and large empty-state frames; the shadcn base token (10px, `--radius`) backs elements that reference `var(--radius)` directly. One exception is meaningful: 16px (`rounded-2xl`) belongs exclusively to the two "mouth" surfaces of the conversation — the composer shell the user types into and the user's own message bubble. Fully-round (`rounded-full`) is reserved for dots (status, avatar), circular icon buttons (attach, send), and pills.

Borders carry structure: 1px hairlines divide regions; the assistant turn hangs its tool/thinking blocks on a 1px left rail (`border-l` + 16px indent), and tool blocks add a 2px state-accented left edge (blue = running, red = error, green = done). Dashed borders mark drop zones and empty states (`border-dashed`).

### Named Rules

**The Soft Mouth Rule.** Only the surfaces you speak through get the 16px radius — the composer and the user bubble. Everything the machine renders back stays at 6–8px: the conversation's softness belongs to the human side.

## Components

For each: character line, then shape, color, states. All controls share the focus treatment — 2px Focus Blue ring, 2px offset (via `ring`/`ring-offset` tokens).

### Buttons

Compact and certain: state changes are decisive color swaps with no travel.
- **Shape:** 6px radius; heights 40px (default), 36px (sm), 44px (lg), 40×40 (icon); label type 12–14px/500.
- **Primary:** Deep Workbench Blue fill (white text, 5.15:1 in both themes), near-white text; hover = 90% opacity blue. Used sparingly (send is the only always-visible primary in chat).
- **Secondary:** Raised Surface fill, foreground text; hover = 80% opacity.
- **Outline:** 1px Hairline stroke on the Worktop; hover fills Quiet Surface.
- **Ghost:** transparent; hover fills Quiet Surface. The workhorse for rows and icon actions.
- **Link:** blue text, underline on hover.

### Chips

- **Style:** Quiet Surface fill, 6px radius, 2px/8px padding, 12px text — attachment chips, model chip, session meta, cron-status chips.
- **State:** Removable chips carry an inline X (ghost icon button); chips never elevate.

### Cards / Containers

- **Corner Style:** 6px radius (sections), 8px (dialogs, empty states).
- **Background:** transparent on panel pages — a card is a hairline border with 16px padding, not a filled box. Filled surfaces (Card tone) belong to the rail, popovers, and toast.
- **Shadow Strategy:** none at rest (see Floating-Only Shadow Rule).
- **Border:** 1px Hairline; dashed for empty/drop states.
- **Internal Padding:** 16px standard, 40px for dashed empty-state frames.

### Inputs / Fields

- **Style:** 1px Hairline stroke on the Worktop, 6px radius, 40px height, 12px type; placeholders in Dim Gray. Textareas share the stroke; the chat composer instead uses the shell below.
- **Focus:** 2px Focus Blue ring with 2px offset; the sidebar's native selects swap their border to Workbench Blue.
- **Disabled:** 50% opacity, not-allowed cursor. Errors render as a red-bordered callout, not red fields; destructive *fills* use Deep Error Red.

### Navigation

240px left rail on Card Surface (wide viewports) / the same rail as an overlay drawer over the scrim (below `md`). Nav items: 6px radius, 8px/12px padding, 12px type; resting Dim Gray, hover Quiet Surface fill, **active = Deep Workbench Blue fill** (the only blue in the rail). Below the nav, a Workspaces header groups the session list by the workspace sessions ran in. Session rows: 12px type with 10px Dim Gray timestamps, current row Quiet Surface fill, right-click (or Shift+F10) context menu, unread dot. Footer stacks selects, the read-only model chip (navigates to Settings → models), the status dot (green/amber/red), and the locale picker. The rail collapses on desktop behind a keyboard shortcut, leaving a pinned restore tab exactly where its edge was.

### Composer (signature)

The conversation's mouth and the softest object in the product: a 16px-radius shell (1px hairline, Worktop fill) that turns Workbench Blue on `focus-within`, holding a fully-round ghost paperclip (32px), a borderless autogrowing textarea (max 200px), a control strip, and a fully-round blue send button (32px). The **control strip** carries the low-frequency, long-label controls — workspace, agent, permission preset — as compact chip-like buttons with dialogs of their own, so the composer stays one quiet line. While a run streams, the send button swaps in place to a stop control — same circle, solid square glyph — which finalizes the turn locally where it stands. Attachment chips stack inside the shell; slash-command autocomplete rises as a bordered popover (Floating shadow) above it; drag-over covers the whole dock with a dashed blue overlay at 5% blue. Enter never submits during IME composition — the draft and the pinyin candidates are sacred.

### Assistant Turn (signature)

Full-width article under a 24px avatar dot (20% blue circle) and the assistant label. Blocks hang on a 1px left rail with 16px indent: markdown prose (14px/1.625), collapsible thinking blocks (Quiet Surface at 40%, chevron rotates open), the **activity group** — the master-collapse that swallows contiguous tool/thinking work into one quiet row (spinner while live, alert glyph on error, sparkles for skills; chevron expands; error groups auto-expand, refusing to hide a failure) — and tool blocks (2px state-colored left edge, mono tool name, italic status — *running* blue / *error* red / *done* green — expanding to mono args/result). Plan progress renders as a checklist beside the transcript (Check / spinning Loader / hollow Circle, 14px icons). The user's turn is the counterpoint: right-aligned 16px-radius Deep Workbench Blue bubble, max 85% width, with hover-revealed, keyboard-accessible icon actions (copy, edit-and-resend); assistant turns carry copy and regenerate the same way. A turn cut off by a disconnect carries an amber 「已中断」 chip — a truncation must never masquerade as a finished answer.

### Code Blocks (signature)

Shiki dual-theme: `github-dark-dimmed` / `github-light` emitted as per-token custom properties (`defaultColor: false`), picked by the same `light-dark()` mechanism as every token — code follows `color-scheme`, OS preference included, with no JavaScript and no re-highlight. 6px radius, hairline top divider, 10px uppercase wide-tracked language header, copy button fading in on hover. The shell stays neutral; syntax colors do the talking.

### Outline Rail

A transcript outline (every user turn's first line) docks at the transcript's right edge above the composer; jumping applies a 1.2s primary-tint wash (12% fading to transparent) on the target turn so arrival is visible without scrolling the whole page.

### Dialog

Centered, `max-w-lg`, 8px radius, 1px border, Worktop fill, 24px padding, Floating shadow, over the blurred `scrim` token; enters with fade only. The Settings modal is the flagship: a section registry (`sections.ts`) is the single source of truth — both the modal's section list and the `/settings/:section` routes read it, sections lazy-mount, and legacy routes (`/models`, `/mcp`, `/skills`, `/dashboard`) redirect to their slugs. Section slugs are public API; they are bookmarked.

## Do's and Don'ts

### Do:

- **Do** use Workbench Blue for exactly five things: streaming, focus/selection, active nav, running tools, and the user bubble (The One Lamp Rule).
- **Do** theme every new color as a `light-dark()` pair in the `@theme` block, and run `scripts/test-palette-contrast.mjs` after touching any value — AA in both halves or it doesn't ship (The One Mechanism Rule).
- **Do** build depth with the neutral steps and 1px hairlines — a raised surface is a lighter (dark) or whiter (light) surface.
- **Do** center the transcript at 768px (`max-w-3xl`) and keep 24px between turns.
- **Do** use monospace for anything the machine emits or accepts as an identifier: tool names, code, skills, `/commands`.
- **Do** use Lucide for every icon, at the established sizes (14px in-turn actions, 16px controls) — one icon language, no emoji.
- **Do** resolve every user-visible string through the locale bundles — zh-CN lands first; design labels that survive both Chinese and English widths.
- **Do** keep state changes as instant color swaps (`transition-colors`, 150ms); the only transforms are functional (chevron rotation) and the only loops are semantic (spinner, streaming pulse, outline jump flash).

### Don't:

- **Don't** add a second accent hue, gradients, glassmorphism, or neon glow — flat tonal layering is the identity.
- **Don't** put a box-shadow on anything that rests; shadow means floating and temporary.
- **Don't** introduce webfonts, icon fonts, or remote type assets (The Invisible Type Rule).
- **Don't** hand-write light-mode or dark-mode values in components, or fork styles under `[data-theme]` — the token pair is the only theming path.
- **Don't** let markdown or panel headings exceed 18px, or add entrance/parallax/decorative motion.
- **Don't** hard-code hex colors in components — extend the `@theme` tokens instead.
- **Don't** design a second navigation pattern for mobile — the below-`md` drawer is the same rail, floating.
