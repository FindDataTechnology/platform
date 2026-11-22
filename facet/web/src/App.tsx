// Facet's thin shell: a header (text site mark + identity + locale switcher +
// login/logout) over hash-addressed views — the mechanism-first intro
// (#/, the default landing), the 壹座 packs market surface reused verbatim
// (#/packs), the MCP catalog (#/mcp), and the docs view (#/docs). v1 scope on
// the facet domain: browse, inspect, subscribe (recorded at the market),
// publish via the same /api/packs API. Cell-side install stays a 壹座 surface
// — the service answers /api/mypacks/* with a guided 501 and the dialog shows it.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PackMarketView } from "@/components/packs/PackMarketView";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useLanguage } from "@/i18n/useLanguage";
import { FACET_HELP_COMMAND } from "./cliFacts";
import { Container } from "./Container";
import { ErrorBoundary } from "./ErrorBoundary";
import { CurateView } from "./CurateView";
import { DocsView } from "./DocsView";
import { FleetsView } from "./FleetsView";
import { EntryView } from "./EntryView";
import { CatalogView } from "./CatalogView";
import { PackDetailPage } from "@/components/packs/PackDetailPage";
import { MineView } from "./MineView";
import { StudioView } from "./StudioView";
import { TeamConsoleView, slugFromPath } from "./TeamConsoleView";
import { FilingFooter, PageFooter } from "./PageFooter";
import { SiteMark } from "./SiteMark";

// Conditional views (add-facet-content-management): #/mine needs a signed-in
// viewer, #/curate needs an admin — an unauthorized deep link falls back to
// the intro landing (the data plane rejects those calls anyway).
// studio (add-supply-studio-migration 1.6): the supply-domain creation face —
// signed-in only (documents are owner-scoped; anonymous deep links fall back
// to the intro landing, same gate as #/mine).
type View = "intro" | "packs" | "packDetail" | "catalog" | "docs" | "mine" | "curate" | "studio" | "fleets";

/** Identity probe result, in THREE states, and the difference matters:
 *    undefined — the probe has not answered yet (paint nothing identity-gated)
 *    null      — answered, nobody is signed in
 *    object    — answered, signed in
 *  A two-state `null | user` cannot tell "still loading" from "anonymous", so
 *  the shell used to flash a signed-in affordance for everyone and then remove
 *  it. `loginEnabled` rides along because the header decides whether to offer a
 *  login entry before it knows who you are (a deployment without Logto would
 *  otherwise link to a /auth/login that 404s). */
type WhoamiUser = { email: string; groups: string[]; creator?: boolean; admin?: boolean; loginEnabled?: boolean } | null | undefined;

const VIEW_HASH: Record<View, string> = {
  intro: "#/",
  packs: "#/packs",
  // 详情页是 `<id>` 的地址，没有单一 hash；`go("packDetail")` 不该被调用
  // （两个入口都直接写 `#/packs/<id>`）。放进表里只为满足 Record 的完备性。
  packDetail: "#/packs",
  catalog: "#/catalog",
  docs: "#/docs",
  mine: "#/mine",
  curate: "#/curate",
  studio: "#/studio",
  fleets: "#/fleets",
};

/** Hash → view, gated by identity; unknown/empty/unauthorized fall back to intro.
 *
 *  The query rides the hash (`#/studio?doc=bp_x` — supply-studio 深链契约, the
 *  shape the cross-domain back-links use), so the view match reads the PATH
 *  part only. Comparing the whole hash dropped every deep link to intro: the
 *  fleet 来源蓝图 chip opened the market page instead of the document (live
 *  2026-11-08). */
/** 详情页的 pack id：`#/packs/<id>` → `<id>`；不是详情地址则 null。 */
function hashPackId(hash: string): string | null {
  const path = hash.split("?")[0];
  const prefix = "#/packs/";
  if (!path.startsWith(prefix)) return null;
  const id = path.slice(prefix.length);
  return id ? decodeURIComponent(id) : null;
}

/** 目录页的物种预选：`#/catalog?species=mcp` 或旧地址 `#/mcp`。 */
function hashSpecies(hash: string): string {
  const path = hash.split("?")[0];
  if (path === "#/mcp") return "mcp";
  const q = hash.split("?")[1];
  if (!q) return "all";
  return new URLSearchParams(q).get("species") ?? "all";
}

function viewFromHash(hash: string, user: WhoamiUser): View {
  const path = hash.split("?")[0];
  // 详情页（pack-detail-as-page 1.1）：必须**先于** `#/packs` 匹配，
  // 否则 `#/packs/<id>` 会落到列表。
  if (path.startsWith("#/packs/") && path.length > "#/packs/".length) return "packDetail";
  if (path === "#/packs") return "packs";
  // #/mcp 退役（unify-material-catalog-page 2.2）：旧地址不断，落到目录页的 MCP 页签。
  if (path === "#/mcp") return "catalog";
  if (path === "#/catalog") return "catalog";
  if (path === "#/docs") return "docs";
  if (path === "#/mine") return user ? "mine" : "intro";
  if (path === "#/studio") return user ? "studio" : "intro";
  if (path === "#/fleets") return user ? "fleets" : "intro";
  if (path === "#/curate") return user?.admin ? "curate" : "intro";
  return "intro";
}

function Whoami({ onUser }: { onUser: (u: WhoamiUser, loginEnabled: boolean) => void }) {
  // 回调走 ref，effect 空依赖：宿主传的是内联箭头（每次渲染新引用），把它放进
  // 依赖数组会让「请求 → setState → 重渲染 → 新箭头 → 再请求」无限自激
  // （2026-11-22 实测：打开详情页后 /api/whoami 被连打上百次）。身份只探一次。
  const onUserRef = useRef(onUser);
  onUserRef.current = onUser;
  useEffect(() => {
    fetch("/api/whoami")
      .then((r) => r.json())
      .then((d) => onUserRef.current(d?.email ? d : null, d?.loginEnabled === true))
      // A failed probe means "we do not know who you are" — the anonymous face
      // is the honest answer, and the login entry stays hidden (we also do not
      // know whether this deployment can log anyone in).
      .catch(() => onUserRef.current(null, false));
  }, []);
  return null;
}

/** Five-locale switcher; an explicit choice persists in the app's locale store. */
function LocaleSwitcher() {
  const { t } = useTranslation();
  const { locale, locales, changeLocale } = useLanguage();
  return (
    <select
      aria-label={t("facetShell.langLabel")}
      data-testid="facet-locale-switcher"
      value={locale}
      onChange={(e) => changeLocale(e.target.value as (typeof locales)[number]["code"])}
      className="rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
    >
      {locales.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  );
}

/** The account control: identity + the author/admin entries that no longer
 *  deserve a primary tab (overhaul-facet-shell-ia-and-space). Dependency-free
 *  menu — outside click and Escape close it, `aria-expanded`/`aria-haspopup`
 *  announce it, and the email lives here instead of widening the header row.
 *  Critically, the control states WHO is signed in even when closed: the
 *  earlier silent-login failure (a viewer believed to be signed in, header
 *  still anonymous) must stay impossible. */

/** The panel is `w-56`; the constant exists so the anchor maths below cannot
 *  drift away from the class. */
const ACCOUNT_MENU_WIDTH = 224;

/** Where the panel's left edge goes, in viewport coordinates.
 *
 *  A fixed `right-0` anchor clipped the panel's own first characters off the
 *  screen whenever the header wrapped the chip toward the middle of a narrow
 *  viewport (measured at 390px: chip 124..207 ⇒ panel left = −17px; 「已登录」、
 *  「我的发布」、「内容运营」、「退出登录」 each lost their first glyph, and
 *  `scrollWidth` stayed 0 because the document does not scroll — the text was
 *  simply outside). Pick from the room actually available: right-align to the
 *  chip, else left-align to it, else clamp inside the viewport with a gutter.
 *  Pure and total so the three branches are testable without a browser. */
function accountMenuLeft(chip: { left: number; right: number }, viewportWidth: number): number {
  const gutter = 8;
  const rightAligned = chip.right - ACCOUNT_MENU_WIDTH;
  if (rightAligned >= gutter) return rightAligned;
  if (chip.left + ACCOUNT_MENU_WIDTH <= viewportWidth - gutter) return chip.left;
  return Math.max(gutter, viewportWidth - ACCOUNT_MENU_WIDTH - gutter);
}

function AccountMenu({
  email,
  label,
  loggedInAs,
  items,
  onSelect,
  logoutLabel,
}: {
  email: string;
  label: string;
  loggedInAs: string;
  items: [View, string][];
  onSelect: (v: View) => void;
  logoutLabel: string;
}) {
  const [open, setOpen] = useState(false);
  /** Distance from the wrapper's left edge to the panel's left edge; null until
   *  the first open (the panel renders only when open, so it is always set). */
  const [panelLeft, setPanelLeft] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        ref={chipRef}
        data-testid="facet-user-chip"
        title={loggedInAs}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          const chip = chipRef.current?.getBoundingClientRect();
          const wrapper = ref.current?.getBoundingClientRect();
          if (chip && wrapper) {
            setPanelLeft(
              accountMenuLeft(chip, document.documentElement.clientWidth) - wrapper.left,
            );
          }
          setOpen(true);
        }}
        className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <span className="inline-block h-2 w-2 rounded-full bg-success" aria-hidden />
        <span>{label}</span>
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          data-testid="facet-account-menu"
          style={{ left: panelLeft ?? 0 }}
          className="absolute z-20 mt-1 w-56 rounded-md border border-border bg-background p-1 shadow-sm"
        >
          <p className="truncate px-2 py-1.5 text-xs text-muted-foreground" title={email}>
            {loggedInAs}
          </p>
          <div className="my-1 border-t border-border" />
          {items.map(([id, itemLabel]) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              data-testid={`facet-account-${id}`}
              onClick={() => {
                setOpen(false);
                onSelect(id);
              }}
              className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
            >
              {itemLabel}
            </button>
          ))}
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            data-testid="facet-account-logout"
            onClick={() => (window.location.href = "/api/auth/logout")}
            className="block w-full rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {logoutLabel}
          </button>
        </div>
      )}
    </div>
  );
}

export function App() {
  const { t } = useTranslation();
  // undefined = probe has not answered yet (see WhoamiUser). Never `null`: that
  // would claim "anonymous" during loading and paint affordances that then flip.
  const [user, setUser] = useState<WhoamiUser>(undefined);
  // Whether this deployment can start a login at all (whoami reports it). Kept
  // separate from `user` because the header needs it while anonymous — it is
  // the difference between "sign in" and a link to a 404.
  const [loginEnabled, setLoginEnabled] = useState(false);
  // `viewFromHash` takes the SETTLED identity; during the probe it must not
  // grant gated views, so it reads `null` until the answer is in.
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash, null));
  // 目录页的物种预选来自 hash 的 query（`#/catalog?species=mcp`；旧 `#/mcp`
  // 也靠这条走 MCP 页签）。跟着 hashchange 一起更新，否则从导航切进来会丢预选。
  const [catalogSpecies, setCatalogSpecies] = useState<string>(() => hashSpecies(window.location.hash));
  // 详情页的 pack id 来自 hash 路径（`#/packs/<id>`），与视图一起更新。
  const [packDetailId, setPackDetailId] = useState<string | null>(() => hashPackId(window.location.hash));
  // 详情页的「返回来处」（pack-detail-as-page 5.2）：进入详情时把**当时**的 hash
  // 记下来，返回就回那一条——目录的 ?species=&q= 因此完整保留。
  // 不用 history.length 判：ego/SPA 常从 >1 起（实测 2），会把直开深链退到空白页。
  // 也不用「在 hashchange 里读 location.hash」——那时它已是新值；要记的是上一条。
  const returnHashRef = useRef<string | null>(null);
  const lastHashRef = useRef<string>(window.location.hash);
  // The scrolling element (`<main>`); view changes reset it to the top.
  const scrollerRef = useRef<HTMLElement | null>(null);
  // A failed OIDC return lands on /?auth_error=state|token. Without this the
  // shell silently shows the anonymous face — the user believes the sign-in
  // happened and wonders why the header still says "登录". Surface it once,
  // then scrub the param so a refresh does not re-raise it.
  const [authError, setAuthError] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const kind = params.get("auth_error");
    if (!kind) return;
    params.delete("auth_error");
    const rest = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
    setAuthError(kind);
  }, []);

  // Whoami resolves after first paint: re-derive the view once identity is in,
  // so an authorized deep link to #/mine or #/curate lands after the probe.
  useEffect(() => {
    setView(viewFromHash(window.location.hash, user));
  }, [user]);

  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash;
      // 刚离开的那一条若不是详情，它就是「来处」。从这里进详情时记下。
      const prev = lastHashRef.current;
      if (viewFromHash(hash, user) === "packDetail" && prev && viewFromHash(prev, user) !== "packDetail") {
        returnHashRef.current = prev;
      }
      lastHashRef.current = hash;
      setView(viewFromHash(hash, user));
      setCatalogSpecies(hashSpecies(window.location.hash));
      setPackDetailId(hashPackId(window.location.hash));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [user]);

  // Tabs write the hash (deep-linkable, reload-stable); the hashchange listener
  // above is the single place that moves the view. The path part decides "same
  // view" so a tab click does not strip a live deep-link query (#/studio?doc=).
  const go = useCallback((next: View) => {
    if (window.location.hash.split("?")[0] === VIEW_HASH[next]) setView(next);
    else window.location.hash = VIEW_HASH[next];
  }, []);

  // A view change lands at the top of the new view. `<main>` is the scroll
  // container and `key={view}` only remounts the boundary INSIDE it, so the
  // offset used to carry over: switching away from a long docs page dropped
  // the reader mid-page in the market (the "interaction feels off" complaint).
  // Reset on any view change rather than only on tab clicks: back/forward
  // between views also resets, which beats landing at a half-restored offset
  // in content the reader never saw.
  //
  // The previous view is kept in a ref so the first mount is skipped (the
  // browser's own scroll-into-hash handling must not be fought) and so `view`
  // is a real input rather than an unused dependency.
  const lastView = useRef(view);
  useEffect(() => {
    if (lastView.current === view) return;
    lastView.current = view;
    scrollerRef.current?.scrollTo({ top: 0, left: 0 });
  }, [view]);

  // The tab, the back/forward history entry and a bookmark must name the view
  // you are actually on. Seven views share one document, so the static <title>
  // claimed the market on every page — and it ignored the locale entirely. The
  // labels are the same task names the entry row and the account menu use, so a
  // view cannot end up with three names.
  useEffect(() => {
    // 详情页没有自己的入口名（它不是导航项，而是市场里的一张卡打开的面），
    // 沿用市场的名字，否则会拼出不存在的 key 并显示成裸串。
    const ns = view === "mine" || view === "curate" ? "account" : "entries";
    const label = view === "packDetail" ? t("facetShell.entries.packs") : t(`facetShell.${ns}.${view}`);
    document.title = `${label} · 谦面 Facet`;
  }, [view, t]);

  // Signed-out viewers subscribing from the detail dialog land on the login
  // entry with a same-origin return path (logto-auth's safeReturnPath keeps
  // the hash) — back to the packs market, dialog state intentionally lost.
  const goLogin = useCallback(() => {
    window.location.href = `/auth/login?rd=${encodeURIComponent(window.location.href)}`;
  }, []);

  /** A login the viewer asked for, as opposed to one an action forced.
   *
   *  The return path is the signed-in work surface, not "/". Landing an
   *  explicit sign-in back on the intro hands the viewer the page they were
   *  already looking at, which makes the one thing they chose to do feel like
   *  it did nothing (facet-shell-entry-and-narrative). An action-driven login
   *  keeps `goLogin` above: it must return to the action, never to the studio.
   *
   *  `safeReturnPath` (server) validates this: a hash fragment rides through
   *  because the value is a same-origin path, and the server reduces absolute
   *  URLs from other hosts to "/". */
  const goLoginToWork = useCallback(() => {
    window.location.href = `/auth/login?rd=${encodeURIComponent("/#/studio")}`;
  }, []);

  const tabs: View[] = [
    // Public entries: the browsing surfaces every visitor gets.
    "intro",
    "packs",
    "catalog",
    "docs",
    // The creation face is the one signed-in entry that earns a tab: it is
    // where a creator spends their session (add-supply-studio-migration 1.6).
    // 我的团队 (facet-owns-its-fleets 4.3) is the same kind of signed-in entry.
    ...((user ? ["studio", "fleets"] : []) as View[]),
  ];

  // Author-only and admin-only surfaces live behind the account control
  // (overhaul-facet-shell-ia-and-space): they serve a viewer in a few minutes
  // of their month and used to take primary-row width from every visitor. The
  // hashes stay resolvable, so deep links and bookmarks keep working.
  const accountItems: [View, string][] = [
    ["mine", t("facetShell.account.mine")],
    ...((user?.admin ? [["curate", t("facetShell.account.curate")]] : []) as [View, string][]),
  ];

  return (
    <div className="flex flex-col h-full min-h-screen bg-background text-foreground">
      <Whoami onUser={(u, enabled) => { setUser(u); setLoginEnabled(enabled); }} />
      <header className="border-b border-border px-6 py-3 flex flex-wrap items-center justify-between gap-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <SiteMark chars="谦" size="md" />
          <span className="text-lg font-semibold">谦面 Facet</span>
          {/* The entry row wraps: with task-named labels in five languages the
              public entries plus 创作台 exceed a 390px viewport (es crosses it
              first), and a non-wrapping row pushes the whole document wider
              than the screen. Wrapping keeps every entry visible; a scrolling
              strip would hide the ones that don't fit. */}
          <nav className="ml-2 flex flex-wrap gap-2" data-testid="facet-tabs">
            {tabs.map((id) => (
              <button
                key={id}
                onClick={() => go(id)}
                aria-current={view === id ? "page" : undefined}
                className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${
                  view === id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t(`facetShell.entries.${id}`)}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <LocaleSwitcher />
          {user ? (
            <AccountMenu
              email={user.email}
              label={t("facetShell.account.menuLabel")}
              loggedInAs={t("facetShell.loggedInAs", { email: user.email })}
              items={accountItems}
              onSelect={go}
              logoutLabel={t("auth.logout")}
            />
          ) : loginEnabled ? (
            // Only offer a login the deployment can honour: without Logto the
            // link would 404, and the old code rendered it regardless.
            <Button size="sm" onClick={goLoginToWork}>
              {t("auth.login")}
            </Button>
          ) : null}
        </div>
      </header>
      {authError && (
        <div
          className="border-b border-border bg-warning/10 px-6 py-2 flex flex-wrap items-center gap-3"
          data-testid="facet-auth-error"
          role="alert"
        >
          <Icon name="alert-circle" size={16} className="text-warning shrink-0" />
          <span className="flex-1 text-sm text-warning">
            {t(`facetShell.loginBanner.${authError === "state" || authError === "token" ? authError : "generic"}`)}
          </span>
          <Button size="sm" onClick={goLoginToWork}>
            {t("facetShell.loginBanner.retry")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAuthError(null)}>
            {t("facetShell.loginBanner.dismiss")}
          </Button>
        </div>
      )}
      <main ref={scrollerRef} className="flex-1 overflow-auto p-6">
        {/* key={view} resets the boundary when tabs switch: a contained
            failure never leaks into the next view (spec: facet-platform,
            tabs still work after a contained failure). */}
        <ErrorBoundary key={view}>
          {/* Path-addressed team console (add-pack-console): /t/<slug> is a
              shared link, so it wins over the hash-addressed views. A share
              page offers no write action and degrades on its own when 壹座 is
              unreachable — the market plane is unaffected. */}
          {slugFromPath(window.location.pathname) ? (
            <TeamConsoleView />
          ) : (
            <>
          {view === "intro" && <EntryView signedIn={Boolean(user)} />}
          {view === "packs" && (
            <Container className="space-y-4">
              {/* One page-level h1 per view (the module's task name), the way
                  intro and the guide already do it. The market and MCP were the
                  only surfaces with NO heading at all, so a screen reader got a
                  page with no title and the document outline had no root. */}
              <h1 className="text-2xl font-semibold tracking-tight">{t("facetShell.entries.packs")}</h1>
              {/* onOpenChat={null}: the next-steps wizard footer points at a
                  conversation view this shell doesn't have (installing stays a
                  壹座 surface), so the footer is suppressed — the report panel
                  itself renders unchanged (spec: pack-marketplace). */}
              {/* Fork deep link (add-agent-fork-lineage D5): cross-domain to
                  壹座 — facet renders the affordance, the write lands in the
                  user's 壹座 cell after SSO. */}
              <PackMarketView
                studioOrigin="https://platform.finddatatech.cloud"
                // A wide viewport gets tiles and a filter rail
                // (overhaul-facet-shell-ia-and-space D2/D5); 壹座 keeps the
                // row-card defaults it has always rendered.
                layout="tile"
                filters="rail"
                // 详情是独立地址（pack-detail-as-page 5.3）：市场只列表，
                // 打开详情 = 写 hash，与目录页指向同一个地址、无来源参数。
                onOpenDetail={(id) => { window.location.hash = `#/packs/${encodeURIComponent(id)}`; }}
              />
              <p className="text-xs text-muted-foreground">
                {t("facetShell.packsFootnote")} <code className="font-mono">{FACET_HELP_COMMAND}</code>
              </p>
            </Container>
          )}
          {/* Every view sits on the same container grid (facet-platform: "one
              shared container grid"). The three tool views below shipped bare,
              so on a 1920 screen their content ran 1872px — wider than the
              container's own 1600 cap — while every sibling stopped at 1600.
              MCP's prose was the visible symptom; the author and admin faces
              had the same shape, unnoticed because they sit behind sign-in. */}
          {view === "catalog" && (
            <Container className="space-y-4">
              {/* 六物种一页（unify-material-catalog-page 1.x）；页签由 hash 的
                  ?species= 预选，#/mcp 重定向同样落在这里。 */}
              <CatalogView key={catalogSpecies} initialSpecies={catalogSpecies} />
            </Container>
          )}
          {view === "packDetail" && (
            <Container className="space-y-4">
              {/* 详情页（pack-detail-as-page 1.2）：交易可见性由**登录态**决定，
                  不由来源决定——两个入口指向同一个地址，无来源参数。 */}
              <PackDetailPage
                packId={packDetailId}
                canTrade={Boolean(user)}
                // facet 匿名壳没有安装面：部署/计费探测不在这里发。
                installSurface={false}
                studioOrigin="https://platform.finddatatech.cloud"
                // 返回来处（pack-detail-as-page 5.2）：从目录进来的回目录，页签与
                // 搜索词都在记下的那条 hash 里。深链直开（没记到来处）回市场。
                onBack={() => {
                  const back = returnHashRef.current;
                  if (back && back.startsWith("#/") && !back.startsWith("#/packs/")) window.location.hash = back;
                  else go("packs");
                }}
                onRequireLogin={() => { window.location.href = `/auth/login?rd=${encodeURIComponent(location.pathname + "#/packs/" + (packDetailId ?? ""))}`; }}
              />
            </Container>
          )}
          {view === "docs" && <DocsView />}
          {view === "mine" && (
            <Container>
              <MineView />
            </Container>
          )}
          {view === "curate" && (
            <Container>
              <CurateView />
            </Container>
          )}
          {view === "studio" && <StudioView onExit={() => go("packs")} onOpenFleets={() => go("fleets")} />}
          {view === "fleets" && (
            <Container>
              <FleetsView />
            </Container>
          )}
            </>
          )}
        </ErrorBoundary>
        {/* Spec: the intro landing carries the full marketing footer (ladder,
            brand, mission); the tool views carry the filing-only footer. */}
        {view === "intro" ? <PageFooter /> : <FilingFooter />}
      </main>
    </div>
  );
}