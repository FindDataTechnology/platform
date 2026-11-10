// ConnectionsSection — Settings → 连接 (settings-connect-center).
//
// The single home for user-level credential connect cards and the search
// wiring. The five panels moved here verbatim from the extensions market tab
// (their mint/store/disconnect flows are unchanged — container only), the
// search card moved from its former own section. A collapsible brand
// quick-reference on top decodes the ecosystem names.
//
// Deep link: /settings/connections?panel=<id> scrolls to and highlights one
// card. The install gates (credential-required) and the line-mint round trip
// land here. Unknown panel values render the section normally.

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { RegistryConnectPanel } from "@/components/extensions/RegistryConnectPanel";
import { ConnectorConnectPanel } from "@/components/extensions/ConnectorConnectPanel";
import { FacetMarketConnectPanel } from "@/components/extensions/FacetMarketConnectPanel";
import { LineOpsConnectPanel } from "@/components/extensions/LineOpsConnectPanel";
import { PaperTradingConnectPanel } from "@/components/extensions/PaperTradingConnectPanel";
import { CiyuanAccountConnectPanel } from "@/components/extensions/CiyuanAccountConnectPanel";
import { ChatwootConnectPanel } from "@/components/extensions/ChatwootConnectPanel";
import { SearchServiceCard } from "./SearchServiceCard";
import { ConnectorBindingsView } from "./ConnectorBindingsView";

const GLOSSARY_BRANDS = ["ciyuan", "facet", "connector", "wire", "lex"] as const;

// A panel target: the anchor wrapper around one card (or one group). `ids`
// are the deep-link panel values that resolve here — the line block answers
// all three line panel ids because one panel renders three rows.
function CardAnchor({
  ids,
  active,
  subtitleKey,
  searchText,
  wide,
  hidden,
  children,
}: {
  ids: string[];
  active: boolean;
  // Optional: cards that render their own header (SearchServiceCard) skip it.
  subtitleKey?: string;
  // Locale-resolved text the section filter matches (name + subtitle). Cards
  // without it are never filtered out (the ledger is always first).
  searchText?: string;
  // List-heavy cards take the full row even when the grid goes two-up.
  wide?: boolean;
  // Filtered out — HIDDEN, never unmounted: a half-typed credential lives in
  // the panel's own state, and dropping the component would silently discard it.
  hidden?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active]);

  return (
    <div
      ref={ref}
      id={`conn-${ids[0]}`}
      data-panel={ids[0]}
      data-panel-active={active ? "true" : "false"}
      data-search={searchText}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-lg",
        wide && "min-[1100px]:col-span-2",
        // `hidden` beats everything: an addressed card is never hidden, but a
        // filtered-out one leaves the visual flow without losing its state.
        hidden && !active && "hidden",
        active && "ring-2 ring-primary/60 p-1",
      )}
    >
      {subtitleKey && <p className="px-3 text-xs text-muted-foreground">{t(subtitleKey)}</p>}
      {children}
    </div>
  );
}

export function ConnectionsSection() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  // The registry panel renders nothing until its store slice is known (never
  // claim "not connected" before known) — prime it here like the market shelf
  // used to. The other panels self-fetch.
  const { refreshRegistryConnection } = useExtensionsStore();
  useEffect(() => {
    refreshRegistryConnection();
  }, [refreshRegistryConnection]);
  const panel = searchParams.get("panel") ?? "";
  const isActive = (...ids: string[]) => ids.includes(panel);
  // 节内筛选 (restructure-yizuo-ia): nine cards in one scroll is the section's
  // biggest interaction cost. The filter only ever HIDES (never unmounts, so a
  // typed secret survives) and it never hides the addressed card.
  const [query, setQuery] = useState("");
  const matches = (text: string | undefined) => {
    const q = query.trim().toLowerCase();
    if (!q || !text) return false;
    return text.toLowerCase().includes(q);
  };
  // A card shows when the query is empty, when its own text matches, or when
  // it is the deep-linked one.
  const cardHidden = (text: string | undefined, active: boolean) => {
    if (active) return false;
    if (!query.trim()) return false;
    return !matches(text);
  };

  return (
    <div className="flex flex-col gap-5 p-6" data-testid="settings-connections">
      <p className="text-sm text-muted-foreground">{t("settings.connections.subtitle")}</p>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("settings.connections.filterPlaceholder")}
        aria-label={t("settings.connections.filterPlaceholder")}
        data-testid="connections-filter"
        className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
      />

      {/* Brand quick-reference: collapsed by default, expands in place. */}
      <details
        data-testid="connections-glossary"
        className="rounded-md border border-border bg-secondary/20 px-3 py-2 text-xs"
      >
        <summary className="cursor-pointer select-none text-muted-foreground">
          {t("settings.connections.glossary.title")}
        </summary>
        <dl className="mt-2 flex flex-col gap-1">
          {GLOSSARY_BRANDS.map((brand) => (
            <div key={brand} className="flex gap-1.5">
              <dt className="shrink-0 font-medium text-foreground">
                {t(`settings.connections.glossary.${brand}.name`)}
              </dt>
              <dd className="text-muted-foreground">
                {t(`settings.connections.glossary.${brand}.desc`)}
              </dd>
            </div>
          ))}
        </dl>
      </details>

      {/* The binding ledger comes FIRST and always renders (binding-first,
          add-connector-bindings 6.2): "which of my installed packs still needs
          something" is the question users open this section with, so it is never
          filtered away and never placed after the accounts. */}
      <CardAnchor ids={["connector-bindings-ledger"]} active={false} wide>
        <ConnectorBindingsView className="px-1" />
      </CardAnchor>

      {/* Cards (restructure-yizuo-ia): one column at the modal's own width, two
          columns when the viewport leaves room; list-heavy cards keep the full
          row. Filtering HIDES a card instead of unmounting it — a half-typed
          credential lives in the panel's state and must survive a search — and
          the deep-linked card is never hidden. */}
      <div className="grid grid-cols-1 gap-4 min-[1100px]:grid-cols-2" data-testid="connections-grid">
        {/* 词元 account first (ciyuan-account-lane): the one key behind the model
            lane and the 萬星 operations MCP. `line-wanxing-caller` is the retired
            panel id kept as an alias so older deep links still land here. */}
        <CardAnchor
          ids={["ciyuan-account", "line-wanxing-caller"]}
          active={isActive("ciyuan-account", "line-wanxing-caller")}
          subtitleKey="settings.connections.cards.ciyuanAccount.subtitle"
          hidden={cardHidden(
            t("settings.connections.cards.ciyuanAccount.subtitle"),
            isActive("ciyuan-account", "line-wanxing-caller"),
          )}
        >
          <CiyuanAccountConnectPanel />
        </CardAnchor>

        {/* 谦面 grouped card: the tool market login and the market device
            pairing are two rows of one brand family (settings-connect-center
            D1) — same brand, two products, two auth models. */}
        <section
          data-testid="connections-group-facet"
          className={cn(
            "flex min-w-0 flex-col gap-1.5",
            query.trim() &&
              !matches(t("settings.connections.cards.facetGroup.title")) &&
              !isActive("registry") &&
              !isActive("facet-market") &&
              "hidden",
          )}
        >
          <h2 className="px-3 text-sm font-semibold text-foreground">
            {t("settings.connections.cards.facetGroup.title")}
          </h2>
          <CardAnchor
            ids={["registry"]}
            active={isActive("registry")}
            subtitleKey="settings.connections.cards.registry.subtitle"
            hidden={cardHidden(
              t("settings.connections.cards.registry.subtitle"),
              isActive("registry") || isActive("facet-market"),
            )}
          >
            <RegistryConnectPanel />
          </CardAnchor>
          <CardAnchor
            ids={["facet-market"]}
            active={isActive("facet-market")}
            subtitleKey="settings.connections.cards.facetMarket.subtitle"
            hidden={cardHidden(
              t("settings.connections.cards.facetMarket.subtitle"),
              isActive("registry") || isActive("facet-market"),
            )}
          >
            <FacetMarketConnectPanel />
          </CardAnchor>
        </section>

        {/* 连接器账号：绑定写需求、账号写供给，顺序固定 —— add-connector-bindings
            6.2。`connector-bindings` 是 chat-connect-guidance 6.3 指向授权动作的
            别名 panel id：它和 `connector` 都落在这张卡上（账本自己用
            `connector-bindings-ledger`，不占这个别名）。 */}
        <CardAnchor
          ids={["connector", "connector-bindings"]}
          active={isActive("connector", "connector-bindings")}
          subtitleKey="settings.connections.cards.connector.subtitle"
          wide
          hidden={cardHidden(
            t("settings.connections.cards.connector.subtitle"),
            isActive("connector", "connector-bindings"),
          )}
        >
          <ConnectorConnectPanel />
        </CardAnchor>

        <CardAnchor
          ids={["line-wire-customer", "line-lex"]}
          active={isActive("line-wire-customer", "line-lex")}
          subtitleKey="settings.connections.cards.lines.subtitle"
          wide
          hidden={cardHidden(
            t("settings.connections.cards.lines.subtitle"),
            isActive("line-wire-customer", "line-lex"),
          )}
        >
          <LineOpsConnectPanel />
        </CardAnchor>

        <CardAnchor
          ids={["paper-trading"]}
          active={isActive("paper-trading")}
          subtitleKey="settings.connections.cards.paperTrading.subtitle"
          hidden={cardHidden(
            t("settings.connections.cards.paperTrading.subtitle"),
            isActive("paper-trading"),
          )}
        >
          <PaperTradingConnectPanel />
        </CardAnchor>

        {/* 商家 Chatwoot BYOK（add-crm-desk-pack-embed）：自带 token 驱动自己的
            租户面；登录对仅嵌入代登录用。 */}
        <CardAnchor
          ids={["chatwoot"]}
          active={isActive("chatwoot")}
          subtitleKey="settings.connections.cards.chatwoot.subtitle"
          hidden={cardHidden(t("settings.connections.cards.chatwoot.subtitle"), isActive("chatwoot"))}
        >
          <ChatwootConnectPanel />
        </CardAnchor>

        {/* The search card renders its own title + subtitle (SearchServiceCard). */}
        <CardAnchor
          ids={["search"]}
          active={isActive("search")}
          hidden={cardHidden(t("settings.connections.cards.search.title"), isActive("search"))}
        >
          <SearchServiceCard highlight={isActive("search")} />
        </CardAnchor>
      </div>
    </div>
  );
}
