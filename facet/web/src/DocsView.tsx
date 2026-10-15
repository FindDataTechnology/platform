// The docs view, served at `#/docs` (facet-platform spec: "The facet shell
// carries a docs view"). Three static sections — install, MCP access,
// creation — with 壹座 leading the install section (first-citizen rule).
//
// Facts discipline: command strings, target directories, and native MCP
// config paths come from cliFacts (single-sourced; a unit test pins the table
// to the CLI's own). Copy comes from `facetDocs.*` i18n keys in all five
// locales — no counts of servers/tools/skills anywhere (those live on the
// live #/mcp surface), and the OAuth path is stated as client-dependent
// (dynamic client registration is not offered; see add-ecosystem-bridge 5.1).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FACET_CAPABILITIES,
  FACET_CLI_PACKAGE,
  FACET_CLIENT_GUIDE_URL,
  FACET_CONNECT_COMMAND,
  FACET_CREATING_GUIDE_URL,
  FACET_INSTALL_COMMAND,
  FACET_MARKET_URL,
  FACET_REGISTRY_URL,
  FACET_TARGETS,
  type FacetTargetId,
} from "./cliFacts";

type InstallTab = "yizuo" | FacetTargetId;

function Command({ children }: { children: string }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 text-xs">
      <code>{children}</code>
    </pre>
  );
}

function SectionNav() {
  const { t } = useTranslation();
  // In-page jumps scroll instead of writing `#docs-…` anchors: the shell's
  // hash IS its router (facet-platform: "Shell views are addressable hash
  // routes"), so any non-route hash would bounce the view back to intro.
  const links: [string, string][] = [
    ["docs-install", t("facetDocs.nav.install")],
    ["docs-mcp", t("facetDocs.nav.mcp")],
    ["docs-create", t("facetDocs.nav.create")],
  ];
  return (
    <nav className="flex flex-wrap gap-2" data-testid="docs-nav">
      {links.map(([anchor, label]) => (
        <button
          key={anchor}
          type="button"
          onClick={() => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" })}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
        <div className="mt-4 rounded-lg border border-border p-4" data-testid={`docs-install-client-${tab}`}>
          <h3 className="text-sm font-semibold">{t(`facetDocs.clients.${tab}.label`)}</h3>
          <p className="mt-2 text-sm text-muted-foreground leading-6">{t(`facetDocs.clients.${tab}.body`)}</p>
          <Command>{`${FACET_INSTALL_COMMAND} <packRef> --target ${tab}`}</Command>
          <p className="mt-3 text-xs text-muted-foreground">
            {t("facetDocs.install.client.skillDir")}{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">{target?.skillsDir}</code>
          </p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("facetDocs.install.client.mcpFile")}{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">{target?.mcpFile}</code>
          </p>
          <a
            className="mt-3 inline-block text-xs text-muted-foreground underline hover:text-foreground"
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
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t("facetDocs.matrix.note")}{" "}
          <a className="underline hover:text-foreground" href={FACET_CLIENT_GUIDE_URL("client-matrix").replace(/client-matrix\.md$/, "client-matrix.md")} target="_blank" rel="noopener noreferrer" data-testid="matrix-deep-link">
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

export function DocsView() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-3xl space-y-10 pb-10" data-testid="facet-docs-view">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">{t("facetDocs.title")}</h1>
        <p className="mt-3 text-sm text-muted-foreground">{t("facetDocs.subtitle")}</p>
        <p className="mt-2 text-xs text-muted-foreground" data-testid="docs-package">
          {t("facetDocs.packageNote")} <code className="rounded bg-muted px-1 py-0.5 font-mono">{FACET_CLI_PACKAGE}</code>
        </p>
        <div className="mt-5">
          <SectionNav />
        </div>
      </section>

      <InstallSection />
      <McpSection />
      <CreateSection />
    </div>
  );
}
