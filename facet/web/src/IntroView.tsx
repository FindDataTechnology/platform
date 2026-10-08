// The mechanism-first intro view, served at the hash root `#/` (facet-platform
// spec: "The facet web shell carries a product intro view"). It describes what
// the product itself does — what a pack holds, why subscribing and installing
// are two acts, how snapshots work, and the three install paths — not the
// product-line family (that lives in the footer). Static: no market or catalog
// live data, no loading states. Copy is fully keyed (five locales, parity
// enforced); the CLI command is a constant from cliFacts, never re-typed.
import { useTranslation } from "react-i18next";
import { FACET_HELP_COMMAND, FACET_INSTALL_COMMAND } from "./cliFacts";

const CARDS = ["contents", "install", "version"] as const;

export function IntroView() {
  const { t, i18n } = useTranslation();
  const lang = (i18n.resolvedLanguage ?? i18n.language ?? "").toLowerCase();
  const lineUrl = lang.startsWith("zh")
    ? "https://www.finddatatech.cloud/zh/products/facet/"
    : "https://www.finddatatech.cloud/products/facet/";

  return (
    <div className="mx-auto max-w-3xl space-y-10 pb-10">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">{t("facetIntro.title")}</h1>
        <p className="mt-3 text-sm text-muted-foreground">{t("facetIntro.subtitle")}</p>
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
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {CARDS.map((card) => (
          <div key={card} className="rounded-lg border border-border p-4">
            <h2 className="text-sm font-semibold">{t(`facetIntro.card.${card}.title`)}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {t(`facetIntro.card.${card}.body`)}
            </p>
          </div>
        ))}
      </section>

      <section>
        <h2 className="text-sm font-semibold">{t("facetIntro.pathTitle")}</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-muted/40 p-4 font-mono text-xs text-muted-foreground">
          <p>{t("facetIntro.path.line1")}</p>
          <p className="mt-0.5 pl-4">{t("facetIntro.path.line1Note")}</p>
          <p className="mt-2">{t("facetIntro.path.line2")}</p>
          <p className="mt-0.5 pl-4">{t("facetIntro.path.line2Note")}</p>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold">{t("facetIntro.quickTitle")}</h2>
        <pre className="mt-3 overflow-x-auto rounded-lg border border-border bg-muted/40 p-4 text-xs">
          <code>{`${FACET_INSTALL_COMMAND} ${t("facetIntro.quickArg")}`}</code>
        </pre>
        <p className="mt-2 text-xs text-muted-foreground">
          {t("facetIntro.quickNote")} {t("facetIntro.quickHelpPrefix")}{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono whitespace-nowrap">{FACET_HELP_COMMAND}</code>
        </p>
      </section>

      <a
        className="inline-block text-xs text-muted-foreground underline hover:text-foreground"
        href={lineUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t("facetIntro.lineLink")}
      </a>
    </div>
  );
}