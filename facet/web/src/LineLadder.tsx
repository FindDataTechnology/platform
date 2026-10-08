// The five-line ladder as a text figure (facet-platform spec: "The shell
// footer carries the five-line ladder"): two-character mark + Chinese numeral
// + contract line name, the facet row marked 当前站点, every row a link to
// that line's official page. Marks and numerals are brand characters — never
// translated; the line-name column follows the locale (contract Chinese names
// under zh, English concept names elsewhere).
import { useTranslation } from "react-i18next";
import { SiteMark } from "./SiteMark";

const LADDER = [
  { slug: "base", mark: "壹座", numeral: "一" },
  { slug: "lex", mark: "识律", numeral: "十" },
  { slug: "wire", mark: "柏讯", numeral: "百" },
  { slug: "facet", mark: "谦面", numeral: "千" },
  { slug: "constellation", mark: "萬星", numeral: "万" },
] as const;

export function LineLadder() {
  const { t, i18n } = useTranslation();
  const lang = (i18n.resolvedLanguage ?? i18n.language ?? "").toLowerCase();
  const prefix = lang.startsWith("zh") ? "/zh" : "";

  return (
    <ul className="space-y-2">
      {LADDER.map(({ slug, mark, numeral }) => {
        const current = slug === "facet";
        return (
          <li key={slug}>
            <a
              href={`https://www.finddatatech.cloud${prefix}/products/${slug}/`}
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center gap-2.5 text-sm transition-colors ${
                current ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <SiteMark chars={mark} size="sm" variant={current ? "seal" : "outline"} />
              <span className="w-4 text-center text-xs text-muted-foreground">{numeral}</span>
              <span>{t(`facetFooter.lines.${slug}`)}</span>
              {current && (
                <span className="rounded-full border border-border px-2 py-px text-[10px] leading-4 text-muted-foreground">
                  {t("facetFooter.current")}
                </span>
              )}
            </a>
          </li>
        );
      })}
    </ul>
  );
}