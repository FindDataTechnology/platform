// The shell footer, carried on all three views (facet-platform spec: "The
// shell footer carries the five-line ladder" + "…brand, contact, mission, and
// filing statements"): brand block, contact block, ladder figure, entries,
// the company mission line, and both filing statements. Contact details and
// filing numbers are facts — constants, not i18n keys; only the mission line
// and the labels are localized.
import { useTranslation } from "react-i18next";
import { FACET_HELP_COMMAND } from "./cliFacts";
import { LineLadder } from "./LineLadder";
import { SiteMark } from "./SiteMark";

const CONTACT_EMAIL = "1253774197@qq.com";
const CONTACT_PHONE = "17753221425";
const CONTACT_PHONE_TEL = "tel:+8617753221425";
const ICP_FILING = { label: "粤ICP备2026118740号-1", href: "https://beian.miit.gov.cn/" };
const MPS_FILING = {
  label: "粤公网安备44030002016558号",
  href: "https://beian.mps.gov.cn/#/query/webSearch?code=44030002016558",
};

export function PageFooter() {
  const { t, i18n } = useTranslation();
  const lang = (i18n.resolvedLanguage ?? i18n.language ?? "").toLowerCase();
  const lineHref = lang.startsWith("zh")
    ? "https://www.finddatatech.cloud/zh/products/facet/"
    : "https://www.finddatatech.cloud/products/facet/";

  return (
    <footer data-testid="facet-footer" className="mt-12 border-t border-border pt-8">
      <div className="grid gap-8 md:grid-cols-3">
        <div>
          <div className="flex items-center gap-2.5">
            <SiteMark chars="谦面" size="lg" />
            <span className="text-base font-semibold">谦面 Facet</span>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">{t("facetFooter.tagline")}</p>
          <h3 className="mt-6 text-xs font-medium text-muted-foreground">
            {t("facetFooter.contactLabel")}
          </h3>
          <p className="mt-1.5 text-sm text-muted-foreground">
            <a className="hover:text-foreground" href={`mailto:${CONTACT_EMAIL}`}>
              {CONTACT_EMAIL}
            </a>
            <span className="mx-1.5">·</span>
            <a className="hover:text-foreground" href={CONTACT_PHONE_TEL}>
              {CONTACT_PHONE}
            </a>
          </p>
        </div>

        <div>
          <h3 className="text-xs font-medium text-muted-foreground">{t("facetFooter.linesLabel")}</h3>
          <div className="mt-2.5">
            <LineLadder />
          </div>
        </div>

        <div>
          <h3 className="text-xs font-medium text-muted-foreground">{t("facetFooter.entriesLabel")}</h3>
          <ul className="mt-2.5 space-y-1.5 text-sm text-muted-foreground">
            <li>
              <a className="hover:text-foreground" href="#/packs">
                {t("facetFooter.entries.packs")}
              </a>
            </li>
            <li>
              <a className="hover:text-foreground" href="#/mcp">
                {t("facetFooter.entries.mcp")}
              </a>
            </li>
            <li>
              <a className="hover:text-foreground" href={lineHref} target="_blank" rel="noopener noreferrer">
                {t("facetFooter.entries.line")}
              </a>
            </li>
            <li>
              <code className="font-mono text-xs">{FACET_HELP_COMMAND}</code>
            </li>
          </ul>
        </div>
      </div>

      <p className="mt-8 text-sm text-muted-foreground">{t("facetFooter.mission")}</p>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-4 text-xs text-muted-foreground">
        <span>{t("facetFooter.copyright")}</span>
        <a className="hover:text-foreground" href={ICP_FILING.href} target="_blank" rel="noopener noreferrer">
          {ICP_FILING.label}
        </a>
        <a className="hover:text-foreground" href={MPS_FILING.href} target="_blank" rel="noopener noreferrer">
          {MPS_FILING.label}
        </a>
      </div>
    </footer>
  );
}