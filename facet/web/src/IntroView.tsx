// The mechanism-first intro view, served at the hash root `#/` (facet-platform
// spec: "The facet web shell carries a product intro view"). It describes what
// the product itself does — what a pack holds, why subscribing and installing
// are two acts, how snapshots work, and the three install paths — not the
// product-line family (that lives in the footer). Static: no market or catalog
// live data, no loading states. Copy is fully keyed (five locales, parity
// enforced); the CLI command is a constant from cliFacts, never re-typed.
//
// Two sections carry what the mechanisms are FOR (facet-shell-entry-and-
// narrative): the team-template section (a pack can be a fleet of scheduled
// posts) and the creation-path section (the studio's four stages, with the
// human's adoption named as the gate). Without them the page explained the
// packaging and never the outcome — a visitor could not tell that this market
// also sells teams, or that they can build one here.
import { useTranslation } from "react-i18next";
import { Container } from "./Container";
import { FACET_HELP_COMMAND, FACET_INSTALL_COMMAND, FACET_TARGETS } from "./cliFacts";

const CARDS = ["contents", "install", "version"] as const;
const CREATION_STAGES = ["stage1", "stage2", "stage3", "stage4"] as const;
/** The team-template section's feature rows: a fleet's declaration surface. */
const TEAM_FACETS = ["roles", "cadence", "slots", "edges", "acceptance"] as const;

/** One node→node edge row: [node] —edge→ [node], with an optional note under the edge. */
function PathRow({
  from,
  edge,
  to,
  note,
}: {
  from: "creator" | "market";
  edge: "edgePublish" | "edgeSubscribe" | "edgeCli";
  to: "market" | "platform" | "editors";
  note?: "edgeSubscribeNote" | "edgeCliNote";
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
      <span className="shrink-0 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium">
        {t(`facetIntro.pathGraph.${from}`)}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        <span aria-hidden className="mr-1">—</span>
        {t(`facetIntro.pathGraph.${edge}`)}
        <span aria-hidden className="ml-1">→</span>
      </span>
      <span className="shrink-0 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs text-primary">
        {t(`facetIntro.pathGraph.${to}`)}
      </span>
      {note && (
        <span className="text-xs text-muted-foreground sm:ml-1">
          {t(`facetIntro.pathGraph.${note}`)}
        </span>
      )}
    </div>
  );
}

export function IntroView({ signedIn = false }: { signedIn?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const lang = (i18n.resolvedLanguage ?? i18n.language ?? "").toLowerCase();
  const lineUrl = lang.startsWith("zh")
    ? "https://www.finddatatech.cloud/zh/products/facet/"
    : "https://www.finddatatech.cloud/products/facet/";

  return (
    <Container className="space-y-10 pb-10">
      {/* Hero + path figure share the first screen: the copy keeps a reading
          measure on the left, the three-node graph fills the right. Capping the
          whole page at 768px (the pre-overhaul shape) left half a 1920 screen
          empty on both sides while the figure wrapped in the narrow column. */}
      <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:items-start">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("facetIntro.title")}</h1>
          <p className="mt-3 max-w-3xl text-sm text-muted-foreground">{t("facetIntro.subtitle")}</p>
          <p className="mt-2 text-xs text-muted-foreground">{t("facetIntro.factRow")}</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href="#/packs"
              data-testid="intro-cta-packs"
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition-opacity hover:opacity-90"
            >
              {t("facetIntro.ctaPacks")}
            </a>
            <a
              href="#/mcp"
              data-testid="intro-cta-mcp"
              className="rounded-md border border-border px-4 py-2 text-sm transition-colors hover:bg-muted"
            >
              {t("facetIntro.ctaMcp")}
            </a>
          </div>

          <div className="mt-8">
            <h2 className="text-sm font-semibold">{t("facetIntro.quickTitle")}</h2>
            <pre className="mt-3 overflow-x-auto rounded-lg border border-border bg-muted/40 p-4 text-xs">
              <code>{`${FACET_INSTALL_COMMAND} ${t("facetIntro.quickArg")}`}</code>
            </pre>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("facetIntro.quickNote")} {t("facetIntro.quickHelpPrefix")}{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono whitespace-nowrap">{FACET_HELP_COMMAND}</code>
            </p>
            {/* Which editors, rendered from cliFacts (the CLI's own table), not
                typed into five locale files: the target list is the CLI's
                contract, so it has one source and the copy cannot claim an
                editor the CLI cannot install into. Naming them is not a "count"
                under the spec — see the intro requirement's facts clause. */}
            <p className="mt-2 text-xs text-muted-foreground" data-testid="intro-targets">
              {t("facetIntro.targetsLabel")}{" "}
              <span className="font-mono">{FACET_TARGETS.map((x) => x.id).join(" · ")}</span>
            </p>
          </div>
        </div>

        <div>
          <h2 className="text-sm font-semibold">{t("facetIntro.pathTitle")}</h2>
          {/* Path figure (polish-facet-usability): the ASCII text lines became a
              three-node graph. Fully static, copy keyed, mobile-wrappable — the
              flex layout is the diagram; no SVG asset, no live data. */}
          <div className="mt-3 rounded-lg border border-border bg-muted/40 p-4 space-y-4">
            <PathRow from="creator" edge="edgePublish" to="market" />
            <div className="pl-4 sm:pl-6 space-y-3 border-l-2 border-border">
              <PathRow from="market" edge="edgeSubscribe" to="platform" note="edgeSubscribeNote" />
              <PathRow from="market" edge="edgeCli" to="editors" note="edgeCliNote" />
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {CARDS.map((card) => (
          <div key={card} className="rounded-lg border border-border p-4">
            <h2 className="text-sm font-semibold">{t(`facetIntro.card.${card}.title`)}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {t(`facetIntro.card.${card}.body`)}
            </p>
          </div>
        ))}
      </section>

      {/* What the mechanisms are FOR. Both sections are unconditional: the
          team-template one must not disappear on the grounds that not every
          pack is a team (spec: "team templates are presented as a first-class
          use"), and the creation path names the human gate explicitly so the
          studio does not read as "the AI writes it for you". */}
      <section className="rounded-lg border border-border p-6" data-testid="intro-team-templates">
        <h2 className="text-lg font-semibold">{t("facetIntro.teamTemplates.title")}</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {t("facetIntro.teamTemplates.body")}
        </p>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {TEAM_FACETS.map((f) => (
            <div key={f} className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
              <dt className="text-sm font-medium">{t(`facetIntro.teamTemplates.facet.${f}.title`)}</dt>
              <dd className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t(`facetIntro.teamTemplates.facet.${f}.body`)}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="rounded-lg border border-border p-6" data-testid="intro-creation-path">
        <h2 className="text-lg font-semibold">{t("facetIntro.creationPath.title")}</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {t("facetIntro.creationPath.body")}
        </p>
        <ol className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {CREATION_STAGES.map((s, i) => (
            <li key={s} className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
              <span className="text-xs font-mono text-muted-foreground">{i + 1}</span>
              <p className="mt-1 text-sm font-medium">{t(`facetIntro.creationPath.${s}`)}</p>
            </li>
          ))}
        </ol>
        {/* The gate is the point: the model drafts, a human adopts. Saying it
            here keeps the studio from reading as automation. */}
        <p className="mt-3 text-xs text-muted-foreground" data-testid="intro-creation-gate">
          {t("facetIntro.creationPath.gate")}
        </p>
        {/* Visibility follows the CONFIRMED login state — the caller passes
            `signedIn` only once the identity probe has answered, so the entry
            never paints and then vanishes. Not a redirect: `#/` is the public
            front door and a signed-in visitor opening it should still see it. */}
        {signedIn && (
          <a
            href="#/studio"
            data-testid="intro-cta-studio"
            className="mt-5 inline-block rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition-opacity hover:opacity-90"
          >
            {t("facetIntro.creationPath.cta")}
          </a>
        )}
      </section>

      <a
        className="inline-block text-xs text-muted-foreground underline hover:text-foreground"
        href={lineUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t("facetIntro.lineLink")}
      </a>
    </Container>
  );
}