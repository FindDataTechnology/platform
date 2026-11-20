// The docs view, served at `#/docs` (facet-platform spec: "The facet shell
// carries a docs view"). Four sections — install, MCP access, creation, and
// site navigation — with 壹座 leading the install section (first-citizen rule).
//
// Shape (overhaul-facet-shell-ia-and-space D7): a rail beside the reading
// measure instead of a 768px column centred in a 1920px viewport. The rail
// carries the four reader entries ("where do I start"), the table of contents
// with the current section marked as the reader scrolls, and a client-side
// search over this page's own copy. The measure carries the sections.
//
// Facts discipline: command strings, target directories, native MCP config
// paths, and the native configuration snippet all come from cliFacts
// (single-sourced; scripts/test-facet-docs-facts.mjs pins the table to the
// CLI's own). Copy comes from `facetDocs.*` i18n keys in all five locales — no
// counts of servers/tools/skills anywhere (those live on the live #/mcp
// surface), and the OAuth path is stated as client-dependent (dynamic client
// registration is not offered; see add-ecosystem-bridge 5.1).
//
// Why the snippet lives here at all: this page was answering "how do I connect
// my client" with a link into the public repository, which times out on many
// customer networks — on the exact page a stuck reader opens last. The
// in-site snippet plus two recorded pitfalls answer it without leaving.
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Container, Measure, Rail } from "./Container";
import {
  FACET_CAPABILITIES,
  FACET_CLI_PACKAGE,
  FACET_CLIENT_GUIDE_URL,
  FACET_CLIENT_MATRIX_URL,
  FACET_CONNECT_COMMAND,
  FACET_CREATING_GUIDE_URL,
  FACET_INSTALL_COMMAND,
  FACET_MARKET_URL,
  FACET_REGISTRY_URL,
  FACET_TARGETS,
  type FacetTargetId,
  mcpSample,
} from "./cliFacts";

type InstallTab = "yizuo" | FacetTargetId;

/** Section anchors, in reading order. The rail's table of contents and the
 *  search results both address these; no hash is written (the shell's hash IS
 *  its router — facet-platform: "Shell views are addressable hash routes"). */
const SECTION_IDS = ["docs-install", "docs-mcp", "docs-create", "docs-site"] as const;
type SectionId = (typeof SECTION_IDS)[number];

function Command({ children }: { children: string }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 text-xs">
      <code>{children}</code>
    </pre>
  );
}

/** Which section a copy key belongs to — the search result attribution. */
function sectionOfKey(key: string): SectionId {
  if (key.startsWith("mcp")) return "docs-mcp";
  if (key.startsWith("create")) return "docs-create";
  if (key.startsWith("site") || key.startsWith("intent")) return "docs-site";
  return "docs-install";
}

/** Flatten the facetDocs copy tree into searchable leaves. Values are what the
 *  reader sees; keys only decide which section owns them. */
function flattenCopy(node: unknown, prefix = "", out: { key: string; text: string }[] = []) {
  if (typeof node === "string") {
    if (node.trim()) out.push({ key: prefix, text: node });
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      flattenCopy(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

function SectionNav({ active }: { active: SectionId }) {
  const { t } = useTranslation();
  const labels: [SectionId, string][] = [
    ["docs-install", t("facetDocs.nav.install")],
    ["docs-mcp", t("facetDocs.nav.mcp")],
    ["docs-create", t("facetDocs.nav.create")],
    ["docs-site", t("facetDocs.nav.site")],
  ];
  return (
    <nav className="flex flex-col gap-0.5" data-testid="docs-nav">
      {labels.map(([anchor, label]) => (
        <button
          key={anchor}
          type="button"
          onClick={() => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" })}
          aria-current={active === anchor ? "true" : undefined}
          data-testid={`docs-nav-${anchor}`}
          className={`rounded-md px-2 py-1 text-left text-sm transition-colors ${
            active === anchor ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

function InstallSection() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<InstallTab>("yizuo");
  const target = FACET_TARGETS.find((x) => x.id === tab);

  return (
    <section id="docs-install" data-testid="docs-install" className="scroll-mt-4">
      <h2 className="text-lg font-semibold">{t("facetDocs.install.title")}</h2>
      <p className="mt-2 text-sm text-muted-foreground leading-6">{t("facetDocs.install.lead")}</p>

      <div className="mt-4 flex flex-wrap gap-2" data-testid="docs-install-tabs">
        {(["yizuo", ...FACET_TARGETS.map((x) => x.id)] as InstallTab[]).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            data-testid={`docs-install-tab-${id}`}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              tab === id ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {id === "yizuo" ? t("facetDocs.install.yizuoTab") : t(`facetDocs.clients.${id}.label`)}
          </button>
        ))}
      </div>

      {tab === "yizuo" ? (
        <div className="mt-4 rounded-lg border border-border p-4" data-testid="docs-install-yizuo">
          <h3 className="text-sm font-semibold">{t("facetDocs.install.yizuo.title")}</h3>
          <p className="mt-2 text-sm text-muted-foreground leading-6">{t("facetDocs.install.yizuo.body")}</p>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            {(["step1", "step2", "step3"] as const).map((s) => (
              <li key={s}>{t(`facetDocs.install.yizuo.${s}`)}</li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="mt-4 space-y-4 rounded-lg border border-border p-4" data-testid={`docs-install-client-${tab}`}>
          <div>
            <h3 className="text-sm font-semibold">{t(`facetDocs.clients.${tab}.label`)}</h3>
            <p className="mt-2 text-sm text-muted-foreground leading-6">{t(`facetDocs.clients.${tab}.body`)}</p>
            <Command>{`${FACET_INSTALL_COMMAND} <packRef> --target ${tab}`}</Command>
            {/* Self-hosted form (fix-supply-machine-faces 7.3): a self-hoster
                following this page used to install silently from the OFFICIAL
                market, because the page only ever showed the official base. */}
            <p className="mt-3 text-xs text-muted-foreground" data-testid={`docs-install-selfhost-${tab}`}>
              {t("facetDocs.install.client.selfHost")}{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                {`${FACET_INSTALL_COMMAND} <packRef> --target ${tab} --base <your-facet-url>`}
              </code>
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              {t("facetDocs.install.client.skillDir")}{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">{target?.skillsDir}</code>
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t("facetDocs.install.client.mcpFile")}{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">{target?.mcpFile}</code>
            </p>
            <p className="mt-3 text-xs text-muted-foreground" data-testid={`docs-after-install-${tab}`}>
              {t("facetDocs.client.afterInstall")}
            </p>
          </div>

          {/* In-site native configuration (D7): what the client's own file
              looks like, generated from the CLI's own entry shape. */}
          <div className="rounded-md border border-border bg-muted/20 p-3" data-testid={`docs-mcp-sample-${tab}`}>
            <h4 className="text-xs font-medium">{t("facetDocs.client.configTitle")}</h4>
            <Command>{mcpSample(tab)}</Command>
            <p className="mt-2 text-xs text-muted-foreground">{t("facetDocs.client.configNote")}</p>
          </div>

          {/* The two mistakes this client actually produces — recorded from the
              CLI's own target comments, not invented. */}
          <div className="rounded-md border border-border p-3" data-testid={`docs-pitfalls-${tab}`}>
            <h4 className="text-xs font-medium">{t("facetDocs.client.pitfallsTitle")}</h4>
            <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              <li>{t(`facetDocs.clients.${tab}.pitfall1`)}</li>
              <li>{t(`facetDocs.clients.${tab}.pitfall2`)}</li>
            </ul>
          </div>

          {/* The public-repository guide stays as a SECONDARY door — reachable,
              never the only one. */}
          <a
            className="inline-block text-xs text-muted-foreground underline hover:text-foreground"
            href={FACET_CLIENT_GUIDE_URL(tab)}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`docs-client-guide-${tab}`}
          >
            {t("facetDocs.install.client.deepGuide")}
          </a>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground" data-testid="docs-install-market">
        {t("facetDocs.install.marketNote")}{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">{FACET_MARKET_URL}</code>
      </p>

      <div className="mt-5 overflow-x-auto" data-testid="docs-capability-matrix">
        <h3 className="text-sm font-semibold">{t("facetDocs.matrix.title")}</h3>
        <table className="mt-2 w-full text-xs">
          <thead>
            <tr className="text-left border-b border-border">
              <th className="py-1.5 pr-3 font-medium">{t("facetDocs.matrix.capability")}</th>
              {FACET_CAPABILITIES.map((c) => (
                <th key={c.id} className="px-2 font-medium whitespace-nowrap">{t(`facetDocs.clients.${c.id}.label`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border/50">
              <td className="py-1.5 pr-3">{t("facetDocs.matrix.skillsUser")}</td>
              {FACET_CAPABILITIES.map((c) => (
                <td key={c.id} className="px-2">✅</td>
              ))}
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-1.5 pr-3">{t("facetDocs.matrix.skillsProject")}</td>
              {FACET_CAPABILITIES.map((c) => (
                <td key={c.id} className="px-2">✅</td>
              ))}
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-1.5 pr-3">{t("facetDocs.matrix.mcpUser")}</td>
              {FACET_CAPABILITIES.map((c) => (
                <td key={c.id} className="px-2">✅</td>
              ))}
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-1.5 pr-3">{t("facetDocs.matrix.mcpProject")}</td>
              {FACET_CAPABILITIES.map((c) => (
                <td key={c.id} className="px-2">{c.mcpProjectFile ? "✅" : "—"}</td>
              ))}
            </tr>
            <tr className="border-b border-border/50">
              <td className="py-1.5 pr-3">{t("facetDocs.matrix.marketplace")}</td>
              {FACET_CAPABILITIES.map((c) => (
                <td key={c.id} className="px-2">{c.marketplace ? "✅" : "—"}</td>
              ))}
            </tr>
            <tr>
              <td className="py-1.5 pr-3">{t("facetDocs.matrix.verified")}</td>
              {FACET_CAPABILITIES.map((c) => (
                <td key={c.id} className="px-2" data-testid={`matrix-verified-${c.id}`}>
                  {c.verified === "full" ? "✅" : c.verified === "config-only" ? "◐" : "—"}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted-foreground">
          {t("facetDocs.matrix.note")}{" "}
          <a className="underline hover:text-foreground" href={FACET_CLIENT_MATRIX_URL} target="_blank" rel="noopener noreferrer" data-testid="matrix-deep-link">
            {t("facetDocs.matrix.deepDoc")}
          </a>
        </p>
      </div>
    </section>
  );
}

function McpSection() {
  const { t } = useTranslation();
  return (
    <section id="docs-mcp" data-testid="docs-mcp" className="scroll-mt-4">
      <h2 className="text-lg font-semibold">{t("facetDocs.mcp.title")}</h2>
      <p className="mt-2 text-sm text-muted-foreground leading-6">{t("facetDocs.mcp.lead")}</p>

      <div className="mt-4 space-y-4">
        <div className="rounded-lg border border-border p-4" data-testid="docs-mcp-keypath">
          <h3 className="text-sm font-semibold">{t("facetDocs.mcp.keyPath.title")}</h3>
          <p className="mt-2 text-sm text-muted-foreground leading-6">{t("facetDocs.mcp.keyPath.body")}</p>
          <Command>{FACET_CONNECT_COMMAND}</Command>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("facetDocs.mcp.keyPath.mintNote")}{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">{FACET_REGISTRY_URL}</code>
          </p>
          <Command>{`${FACET_INSTALL_COMMAND} <packRef> --target <target> --write-mcp`}</Command>
        </div>

        <div className="rounded-lg border border-border p-4" data-testid="docs-mcp-oauthpath">
          <h3 className="text-sm font-semibold">{t("facetDocs.mcp.oauthPath.title")}</h3>
          <p className="mt-2 text-sm text-muted-foreground leading-6">{t("facetDocs.mcp.oauthPath.body")}</p>
          <p className="mt-2 text-xs text-muted-foreground" data-testid="docs-mcp-oauth-honest">
            {t("facetDocs.mcp.oauthPath.honest")}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-4" data-testid="docs-mcp-essentials">
          <h3 className="text-sm font-semibold">{t("facetDocs.mcp.essentials.title")}</h3>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            {(["quota", "tier", "revoke"] as const).map((k) => (
              <li key={k}>{t(`facetDocs.mcp.essentials.${k}`)}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function CreateSection() {
  const { t } = useTranslation();
  return (
    <section id="docs-create" data-testid="docs-create" className="scroll-mt-4">
      <h2 className="text-lg font-semibold">{t("facetDocs.create.title")}</h2>
      <p className="mt-2 text-sm text-muted-foreground leading-6">{t("facetDocs.create.lead")}</p>

      <div className="mt-4 space-y-4">
        <div className="rounded-lg border border-border p-4" data-testid="docs-create-routes">
          <h3 className="text-sm font-semibold">{t("facetDocs.create.routesTitle")}</h3>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            {(["route1", "route2", "route3"] as const).map((r) => (
              <li key={r}>{t(`facetDocs.create.${r}`)}</li>
            ))}
          </ol>
        </div>

        <div className="rounded-lg border border-border p-4" data-testid="docs-create-discipline">
          <h3 className="text-sm font-semibold">{t("facetDocs.create.disciplineTitle")}</h3>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            {(["versions", "subscribe", "gate"] as const).map((k) => (
              <li key={k}>{t(`facetDocs.create.${k}`)}</li>
            ))}
          </ul>
        </div>

        <a
          className="inline-block text-xs text-muted-foreground underline hover:text-foreground"
          href={FACET_CREATING_GUIDE_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="docs-create-deep-guide"
        >
          {t("facetDocs.create.deepGuide")}
        </a>
      </div>
    </section>
  );
}

/** 站内导航 (D7): the layer this page never had — what each shell entry is for,
 *  in the viewer's language, so a first-time visitor stops guessing which tab
 *  holds what. Entry names come from `facetShell.entries`/`account` (one
 *  concept, one name); only the description lives here. */
function SiteSection() {
  const { t } = useTranslation();
  const rows: [string, string][] = [
    ["intro", t("facetShell.entries.intro")],
    ["packs", t("facetShell.entries.packs")],
    ["mcp", t("facetShell.entries.mcp")],
    ["docs", t("facetShell.entries.docs")],
    ["studio", t("facetShell.entries.studio")],
    ["mine", t("facetShell.account.mine")],
    ["curate", t("facetShell.account.curate")],
  ];
  return (
    <section id="docs-site" data-testid="docs-site" className="scroll-mt-4">
      <h2 className="text-lg font-semibold">{t("facetDocs.site.title")}</h2>
      <p className="mt-2 text-sm text-muted-foreground leading-6">{t("facetDocs.site.lead")}</p>
      <dl className="mt-4 divide-y divide-border rounded-lg border border-border" data-testid="docs-site-entries">
        {rows.map(([id, name]) => (
          <div key={id} className="grid gap-1 p-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3" data-testid={`docs-site-entry-${id}`}>
            <dt className="text-sm font-medium text-foreground">{name}</dt>
            <dd className="text-sm text-muted-foreground leading-6">{t(`facetDocs.site.entries.${id}`)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function DocsView() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<SectionId>("docs-install");
  const scrollerRef = useRef<HTMLElement | null>(null);

  // Active-section tracking: the reading surface scrolls inside the shell's
  // `main`, so the observer hangs off whichever element actually scrolls.
  useEffect(() => {
    const sections = SECTION_IDS.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
    if (sections.length === 0) return;
    const scroller = sections[0].closest("main");
    scrollerRef.current = scroller as HTMLElement | null;
    const onScroll = () => {
      const origin = scroller ? scroller.getBoundingClientRect().top : 0;
      let current: SectionId = SECTION_IDS[0];
      for (const el of sections) {
        if (el.getBoundingClientRect().top - origin <= 32) current = el.id as SectionId;
      }
      // The last section is shorter than the viewport, so its top never crosses
      // the threshold even while the reader is looking straight at it. At the
      // bottom of the scroll range the last section IS the current one.
      const atBottom = scroller
        ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8
        : window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8;
      if (atBottom) current = SECTION_IDS[SECTION_IDS.length - 1];
      setActive(current);
    };
    onScroll();
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, []);

  // Search index over this page's own copy — no request, no new dependency.
  const index = useMemo(() => {
    const bundle = t("facetDocs", { returnObjects: true }) as unknown;
    return flattenCopy(bundle).map((leaf) => ({ ...leaf, section: sectionOfKey(leaf.key) }));
    // t is stable per locale; re-index when the copy changes language.
  }, [t]);

  const needle = query.trim().toLowerCase();
  const hits = needle
    ? index.filter((row) => row.text.toLowerCase().includes(needle)).slice(0, 8)
    : [];

  return (
    <div data-testid="facet-docs-view">
      <Container variant="split">
        <Rail className="space-y-5">
          {/* Where do I start — the first screen routes by intent, not by
              product jargon. */}
          <div>
            <h2 className="text-xs font-medium text-muted-foreground">{t("facetDocs.intentTitle")}</h2>
            <div className="mt-2 flex flex-col gap-1.5" data-testid="docs-intent">
              {(
                [
                  ["install", "docs-install"],
                  ["publish", "docs-create"],
                  ["mcp", "docs-mcp"],
                  ["site", "docs-site"],
                ] as [string, SectionId][]
              ).map(([key, target]) => (
                <button
                  key={key}
                  type="button"
                  data-testid={`docs-intent-${key}`}
                  onClick={() => document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  className="rounded-md border border-border px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {t(`facetDocs.intent.${key}`)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <h2 className="text-xs font-medium text-muted-foreground">{t("facetDocs.title")}</h2>
            <div className="mt-2">
              <SectionNav active={active} />
            </div>
          </div>

          <div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("facetDocs.searchPlaceholder")}
              aria-label={t("facetDocs.searchPlaceholder")}
              data-testid="docs-search"
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
            />
            {needle && (
              <div className="mt-2 space-y-1.5" data-testid="docs-search-results">
                {hits.length === 0 ? (
                  <p className="text-xs text-muted-foreground" data-testid="docs-search-empty">
                    {t("facetDocs.searchEmpty")}
                  </p>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground">
                      {t("facetDocs.searchResults", { count: hits.length })}
                    </p>
                    {hits.map((hit) => (
                      <button
                        key={hit.key}
                        type="button"
                        onClick={() => document.getElementById(hit.section)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                        className="block w-full rounded-md border border-border px-2 py-1.5 text-left text-xs leading-5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        {hit.text.length > 120 ? `${hit.text.slice(0, 120)}…` : hit.text}
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </Rail>

        <Measure className="space-y-10 pb-10">
          <section>
            <h1 className="text-2xl font-semibold tracking-tight">{t("facetDocs.title")}</h1>
            <p className="mt-3 text-sm text-muted-foreground">{t("facetDocs.subtitle")}</p>
            <p className="mt-2 text-xs text-muted-foreground" data-testid="docs-package">
              {t("facetDocs.packageNote")}{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">{FACET_CLI_PACKAGE}</code>
            </p>
          </section>

          <InstallSection />
          <McpSection />
          <CreateSection />
          <SiteSection />
        </Measure>
      </Container>
    </div>
  );
}
