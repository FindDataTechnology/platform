// PackCard — the market's five-slot card (overhaul-market-catalog-presentation
// P2): ONE component renders the plain card, the featured rail row, and the
// official gallery tile, so the strip, the badges, and the degradation chain
// can never drift between them. The card is a single focusable region — a
// nested clickable (the gallery's fork link) would break the keyboard path;
// that affordance lives in the detail dialog (`packs.detail.fork`).
//
// Slots (specs/pack-marketplace, 市场卡片按五槽位呈现):
//   1 identity   — seal mark, name, provenance + structure badges, version
//   2 promise    — `promise` (P3) → first sentence of the description → name
//   3 signals    — skills / roles / tools counts; unknown counts are OMITTED
//                  (unknown ≠ zero)
//   4 audience   — `audience` (P3); until then the tag row, capped, same slot
//   5 boundary   — `notes` first sentence (manifest-only, P3); until then
//                  absent → the slot renders nothing
//
// testIds: the host passes the anchor (`pack-card-…`, `pack-featured-card-…`,
// `pack-gallery-card-…`) so existing e2e/anchors keep working verbatim; the
// badge anchors keep their historical names (pack-official-badge-… etc.).

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PackSummary } from "@/lib/packs-api";
import { Badge } from "@/components/packs/Badge";
import { StatusPill } from "@/components/ui/status-pill";
import { SiteMark } from "@/components/ui/site-mark";
import { firstSentence, markCharOf } from "@/lib/packIdentity";
import type { PackRelation } from "@/lib/packRelation";

export function PackCard({
  pack,
  onOpen,
  testId,
  tone = "plain",
  index,
  audienceLabels,
  relation,
  children,
  extra,
  layout = "row",
}: {
  pack: PackSummary;
  onOpen: () => void;
  testId: string;
  /** Presentation shape (overhaul-facet-shell-ia-and-space D2):
   *  `row` — the original horizontal card (seal beside the slots), what 壹座
   *          renders and what this component rendered before the parameter
   *          existed; the default keeps that surface byte-identical.
   *  `tile` — the stacked card for a multi-column grid: seal above the slots,
   *          promise clamped to two lines so a grid row stays even. Same five
   *          slots, same anchors — only the flow direction and the promise
   *          clamp differ. */
  layout?: "row" | "tile";
  // Gallery tiles ride the primary tint; the featured rail keeps the plain
  // border but is reachable through the same component.
  tone?: "plain" | "gallery";
  // Slug→label map for the audience slot (the facets vocabulary, already
  // locale-projected by the server): a declared v2 `display.audience` renders
  // as chips ONLY when its slugs resolve here — an unresolved slug would leak
  // a raw identifier, so the slot falls back to the tag row instead.
  audienceLabels?: Record<string, string>;
  /** The viewer's own state (polish-material-market-tabs 1.2): the installed
   *  snapshot's version and whether the listing is ahead. Null on either side
   *  renders nothing — a failed install read must never read as "not
   *  installed", and the state gates nothing. */
  relation?: PackRelation;
  // Position in the grid — the entrance stagger lives HERE so the three host
  // branches (featured / gallery / plain) can never drift on the timing
  // (facet/web/DESIGN.md 入场: rise-in ≤200ms, list stagger allowed). The
  // cascade caps at 200ms regardless of grid length; `prefers-reduced-motion`
  // is honored globally by the stylesheet, so this is pure enhancement.
  index?: number;
  // Host-chosen presentation extras (starter marker, compact spec sheet).
  children?: ReactNode;
  // The action row (official gallery's fork deep link) — rendered OUTSIDE the
  // clickable content region as a sibling inside the tile: the card body stays
  // a single focusable click target (specs/pack-marketplace 五槽位), the
  // clone affordance (official-pack-showcase) keeps its own keyboard stop.
  extra?: ReactNode;
}) {
  const { t } = useTranslation();
  // Slot 2 promise (P3 4.5): the author's declared v2 promise rides the card
  // verbatim (the validator capped it at the slot's own display width, so no
  // clipping is needed); without one, the degradation chain is exactly the
  // pre-P3 behavior — first sentence of the description.
  const declaredPromise = (pack.display?.promise ?? "").trim();
  const promise = declaredPromise || firstSentence(pack.description);
  // Slot 1 seal: identity.mark overrides the server-generated line seal for
  // glyph/emoji marks only — an image reference has no client asset face yet,
  // and inventing one would render the raw reference string.
  const mark = pack.display?.identity?.mark;
  const sealChar =
    mark && (mark.kind === "glyph" || mark.kind === "emoji") && mark.value.trim()
      ? mark.value.trim()
      : markCharOf(pack.line, pack.name);
  // Signal anchors must NOT start with "pack-card-" — the e2e suite counts
  // cards by the prefix selector [data-testid^="pack-card-"]; a child anchor
  // on that prefix inflates the count (caught by facet-shell, 2026-11-03).
  // Unknown (no server projection) omits the segment; a real zero renders the
  // explicit zero word (the compact sheet's own discipline — "0" is a
  // statement, silence is an absence).
  const signals = (
    <>
      {pack.skillCount !== undefined && (
        <span data-testid={`pack-signals-${pack.id}-skills`}>
          {pack.skillCount > 0 ? t("packs.specSheet.compactSkills", { n: pack.skillCount }) : t("packs.specSheet.compactSkillsZero")}
        </span>
      )}
      {pack.agentCount !== undefined && (
        <span data-testid={`pack-signals-${pack.id}-roles`}>
          {pack.agentCount > 0 ? t("packs.specSheet.compactRoles", { n: pack.agentCount }) : t("packs.specSheet.compactPersonaMissing")}
        </span>
      )}
      {pack.mcpCount !== undefined && (
        <span data-testid={`pack-signals-${pack.id}-tools`}>
          {pack.mcpCount > 0 ? t("packs.specSheet.compactTools", { n: pack.mcpCount }) : t("packs.specSheet.compactToolsZero")}
        </span>
      )}
    </>
  );

  const stagger = index === undefined ? undefined : `${Math.min(Math.max(index, 0) * 20, 200)}ms`;
  const tiled = layout === "tile";

  return (
    <div
      data-testid={testId}
      data-layout={layout}
      className={`rise-in text-left border rounded-lg p-4 transition-colors ${
        tiled ? "flex flex-col " : ""
      }${tone === "gallery" ? "border-primary/40 bg-primary/5 hover:border-primary/70" : "border-border hover:border-primary/50"}`}
      style={stagger ? { animationDelay: stagger } : undefined}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        className={tiled ? "flex flex-1 cursor-pointer flex-col" : "cursor-pointer"}
      >
      <div className={tiled ? "flex flex-1 flex-col gap-2.5" : "flex gap-3"}>
        {/* Slot 1 · identity — the line seal gives 70 same-shaped cards a
            one-glance fingerprint (the brand asset, no upload/audit surface). */}
        <SiteMark chars={sealChar} size="sm" />
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-foreground flex items-center gap-1.5 min-w-0">
              <span className="truncate">{pack.name}</span>
              {/* Adopted provenance needs BOTH official and the adopted record
                  (add-official-adopted-agents): an adopted record alone never
                  grants official status; the three sources stay distinguishable. */}
              {pack.official === true && pack.adopted === true ? (
                <Badge data-testid={`pack-adopted-badge-${pack.id}`}>{t("packs.market.officialAdoptedBadge")}</Badge>
              ) : pack.official === true ? (
                <Badge data-testid={`pack-official-badge-${pack.id}`}>{t("packs.market.officialBadge")}</Badge>
              ) : null}
              {pack.badge ? (
                <Badge data-testid={`pack-type-badge-${pack.id}`}>{t(`packs.badge.${pack.badge}`)}</Badge>
              ) : (
                pack.facade && <Badge data-testid={`pack-facade-badge-${pack.id}`}>{t("packs.market.facade")}</Badge>
              )}
              {/* The viewer's relation to this material (1.2). Words carry it —
                  the pill's tint is decoration, never the message. Both are
                  absent when the install read failed or the listing has no
                  version, so "unknown" never renders as "not installed". */}
              {relation?.installedVersion != null && (
                <StatusPill
                  status="neutral"
                  dot={false}
                  data-testid={`pack-installed-badge-${pack.id}`}
                  label={t("packs.market.installedBadge", { version: relation.installedVersion })}
                />
              )}
              {relation?.updateVersion != null && (
                <StatusPill
                  status="waiting"
                  dot={false}
                  data-testid={`pack-update-badge-${pack.id}`}
                  label={t("packs.market.updateBadge", { version: relation.updateVersion })}
                />
              )}
            </span>
            <span className="text-xs text-muted-foreground shrink-0">v{pack.version}</span>
          </div>

          {/* Slot 2 · promise — the degradation chain never renders a
              half-clipped paragraph; long descriptions reach the reader in the
              detail dialog. In tile mode the clamp is explicit (two lines) so
              a grid row keeps an even baseline. */}
          {promise ? (
            <p className={`text-sm text-muted-foreground mt-1 ${tiled ? "line-clamp-2" : ""}`}>{promise}</p>
          ) : null}

          {/* Slot 3 · obtainable signals — unknown counts omit the segment. */}
          {(pack.skillCount !== undefined || pack.agentCount !== undefined || pack.mcpCount !== undefined) && (
            <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">{signals}</div>
          )}

          {/* Slot 4 · audience — the declared v2 audience renders when every
              slug resolves through the facets vocabulary (an unresolved slug
              would leak a raw identifier into a display slot); otherwise the
              tag row stands in (capped at 3: the vocabulary is free-form). */}
          {(() => {
            const audience = pack.display?.audience ?? [];
            const labels = audience.map((slug) => audienceLabels?.[slug]).filter((l): l is string => !!l);
            if (audience.length > 0 && labels.length === audience.length) {
              return (
                <div className="flex items-center gap-1.5 mt-2 flex-wrap" data-testid={`pack-audience-${pack.id}`}>
                  {labels.slice(0, 3).map((label) => (
                    <Badge key={label}>{label}</Badge>
                  ))}
                </div>
              );
            }
            return pack.tags.length > 0 ? (
              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                {pack.tags.slice(0, 3).map((tag) => (
                  <Badge key={tag}>{tag}</Badge>
                ))}
              </div>
            ) : null;
          })()}

          {children}
        </div>
      </div>
      </div>
      {extra && (
        <div className="flex items-center gap-2 mt-2 border-t border-border/40 pt-2">{extra}</div>
      )}
    </div>
  );
}
