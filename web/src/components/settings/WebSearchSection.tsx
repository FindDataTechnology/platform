// Settings → Network search (add-websearch-settings, extended by
// add-search-byok). Two zones:
//
//   1. My search key — every signed-in user: their OWN search-provider key
//      (BYOK). Write-only (presence + 4-char hint), clear = back to the shared
//      pool. A test button shows which credential served the probe.
//   2. Shared search service — admins only: the deployment relay wiring
//      (URL + token, stored→env) and the shared pool's health.
//
// The section is visible to everyone; zone 2 renders only for admins (the
// server gates its endpoints the same way).

import { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/hooks/useAuth";
import {
  fetchWebsearchConfig,
  saveWebsearchConfig,
  fetchUserKey,
  saveUserKey,
  fetchPoolStatus,
  testWebsearchRelay,
  type WebsearchConfig,
  type WebsearchTestResult,
  type WebsearchUserKey,
  type WebsearchPoolStatus,
} from "@/lib/websearch-api";

const inputCls =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none";

function SourceBadge({ source }: { source: "stored" | "env" | null }) {
  const { t } = useTranslation();
  if (!source) return null;
  const label = source === "stored" ? t("settings.websearch.sourceStored") : t("settings.websearch.sourceEnv");
  const cls =
    source === "stored"
      ? "bg-primary/15 text-primary"
      : "bg-secondary text-secondary-foreground";
  return (
    <span data-testid={`websearch-source-${source}`} className={`text-xs px-2 py-0.5 rounded-full ${cls}`}>
      {label}
    </span>
  );
}

const testTone: Record<WebsearchTestResult["state"], string> = {
  ok: "text-emerald-600",
  "auth-rejected": "text-destructive",
  "upstream-degraded": "text-warning",
  unreachable: "text-destructive",
  "invalid-url": "text-destructive",
};

// Which credential served the request — the honest three-way disclosure.
function sourceLabel(t: (k: string) => string, source: string | undefined): string | null {
  if (source === "user") return t("settings.websearch.byok.servedUser");
  if (source === "pool") return t("settings.websearch.byok.servedPool");
  if (source === "pool-after-user-failure") return t("settings.websearch.byok.servedFallback");
  return null;
}

function UserKeyZone() {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<WebsearchUserKey | null>(null);
  const [key, setKey] = useState(""); // write-only: empty = leave unchanged
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState<WebsearchTestResult | null>(null);

  useEffect(() => {
    fetchUserKey()
      .then(setLoaded)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const save = async (clearing = false) => {
    setBusy(true);
    setError("");
    setTestResult(null);
    try {
      const next = await saveUserKey(clearing ? { key: "" } : key.trim() ? { key: key.trim() } : {});
      setLoaded(next);
      setKey("");
      setStatus("saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
      setStatus("error");
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setBusy(true);
    setTestResult(null);
    try {
      // Form value rides along for a dry run; nothing persists.
      setTestResult(await testWebsearchRelay({ userKey: key.trim() || undefined }));
    } catch (e) {
      setTestResult({ state: "unreachable", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const served = sourceLabel(t, testResult?.source);

  return (
    <div className="flex flex-col gap-3" data-testid="websearch-byok">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t("settings.websearch.byok.title")}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{t("settings.websearch.byok.subtitle")}</p>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="flex items-center gap-2 text-xs font-medium text-foreground">
          {t("settings.websearch.byok.keyLabel")}
          {loaded?.hasKey && (
            <span data-testid="websearch-userkey-stored" className="text-xs px-2 py-0.5 rounded-full bg-primary/15 text-primary">
              {t("settings.websearch.byok.storedBadge", { hint: loaded.keyHint ?? "" })}
            </span>
          )}
        </span>
        <input
          data-testid="websearch-userkey"
          type="password"
          value={key}
          placeholder={loaded?.hasKey ? t("settings.websearch.byok.keyStoredPlaceholder") : t("settings.websearch.byok.keyPlaceholder")}
          onChange={(e) => {
            setKey(e.target.value);
            setStatus("idle");
            setTestResult(null);
          }}
          className={inputCls}
        />
        <span className="text-xs text-muted-foreground">{t("settings.websearch.byok.keyHint")}</span>
      </label>

      <div className="flex items-center gap-2">
        <button
          data-testid="websearch-userkey-save"
          onClick={() => save(false)}
          disabled={busy}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {busy ? t("settings.websearch.saving") : t("settings.websearch.save")}
        </button>
        {loaded?.hasKey && (
          <button
            data-testid="websearch-userkey-clear"
            onClick={() => save(true)}
            disabled={busy}
            className="rounded-md border border-input px-3 py-1.5 text-sm text-foreground disabled:opacity-50"
          >
            {t("settings.websearch.byok.clear")}
          </button>
        )}
        <button
          data-testid="websearch-userkey-test"
          onClick={runTest}
          disabled={busy}
          className="rounded-md border border-input px-3 py-1.5 text-sm text-foreground disabled:opacity-50"
        >
          {busy ? t("settings.websearch.testing") : t("settings.websearch.test")}
        </button>
        {status === "saved" && (
          <span data-testid="websearch-userkey-saved" className="text-xs text-emerald-600">
            {t("settings.websearch.saved")}
          </span>
        )}
      </div>

      {error && (
        <p data-testid="websearch-userkey-error" className="text-xs text-destructive">{error}</p>
      )}

      {testResult && (
        <p data-testid="websearch-userkey-test-result" className={`text-xs ${testTone[testResult.state]}`}>
          {t(`settings.websearch.testStates.${testResult.state}`)}
          {served ? ` — ${served}` : ""}
          {testResult.detail && !served ? ` — ${testResult.detail}` : ""}
        </p>
      )}

      {!loaded?.hasKey && (
        <p className="text-xs text-muted-foreground">{t("settings.websearch.byok.noKeyHint")}</p>
      )}
    </div>
  );
}

function SharedServiceZone() {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<WebsearchConfig | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<WebsearchTestResult | null>(null);
  const [pool, setPool] = useState<WebsearchPoolStatus | null>(null);

  useEffect(() => {
    fetchWebsearchConfig()
      .then((cfg) => {
        setLoaded(cfg);
        setUrl(cfg.url);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    fetchPoolStatus().then(setPool).catch(() => {});
  }, []);

  const save = async (clearing: "url" | "token" | null = null) => {
    setStatus("saving");
    setError("");
    setTestResult(null);
    try {
      const body: Record<string, string> = {};
      if (clearing === "url") body.url = "";
      else if (clearing === "token") body.token = "";
      else {
        if (url.trim() !== (loaded?.url ?? "")) body.url = url.trim();
        if (token.trim()) body.token = token.trim();
      }
      const cfg = await saveWebsearchConfig(body);
      setLoaded(cfg);
      setUrl(cfg.url);
      setToken("");
      setStatus("saved");
      fetchPoolStatus().then(setPool).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
      setStatus("error");
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testWebsearchRelay({ url: url.trim() || undefined, token: token.trim() || undefined }));
    } catch (e) {
      setTestResult({ state: "unreachable", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const cooling = (pool?.keys ?? []).filter((k) => k.coolingDown).length;

  return (
    <div className="flex flex-col gap-3" data-testid="websearch-shared">
      <div>
        <h3 className="text-sm font-medium text-foreground">{t("settings.websearch.shared.title")}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{t("settings.websearch.shared.subtitle")}</p>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="flex items-center gap-2 text-xs font-medium text-foreground">
          {t("settings.websearch.urlLabel")}
          <SourceBadge source={loaded?.source.url ?? null} />
        </span>
        <input
          data-testid="websearch-url"
          value={url}
          placeholder={t("settings.websearch.urlPlaceholder")}
          onChange={(e) => {
            setUrl(e.target.value);
            setStatus("idle");
            setTestResult(null);
          }}
          className={inputCls}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="flex items-center gap-2 text-xs font-medium text-foreground">
          {t("settings.websearch.tokenLabel")}
          <SourceBadge source={loaded?.source.token ?? null} />
        </span>
        <input
          data-testid="websearch-token"
          type="password"
          value={token}
          placeholder={loaded?.hasToken ? t("settings.websearch.tokenStoredPlaceholder", { hint: loaded.tokenHint ?? "" }) : t("settings.websearch.tokenPlaceholder")}
          onChange={(e) => {
            setToken(e.target.value);
            setStatus("idle");
            setTestResult(null);
          }}
          className={inputCls}
        />
        <span className="text-xs text-muted-foreground">{t("settings.websearch.tokenHint")}</span>
      </label>

      <div className="flex items-center gap-2">
        <button
          data-testid="websearch-save"
          onClick={() => save(null)}
          disabled={status === "saving"}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {status === "saving" ? t("settings.websearch.saving") : t("settings.websearch.save")}
        </button>
        <button
          data-testid="websearch-test"
          onClick={runTest}
          disabled={testing}
          className="rounded-md border border-input px-3 py-1.5 text-sm text-foreground disabled:opacity-50"
        >
          {testing ? t("settings.websearch.testing") : t("settings.websearch.test")}
        </button>
        {loaded?.hasToken && (
          <button
            data-testid="websearch-token-clear"
            onClick={() => save("token")}
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            {t("settings.websearch.clearToken")}
          </button>
        )}
        {status === "saved" && (
          <span data-testid="websearch-saved" className="text-xs text-emerald-600">
            {t("settings.websearch.saved")}
          </span>
        )}
      </div>

      {error && <p data-testid="websearch-error" className="text-xs text-destructive">{error}</p>}

      {testResult && (
        <p data-testid="websearch-test-result" className={`text-xs ${testTone[testResult.state]}`}>
          {t(`settings.websearch.testStates.${testResult.state}`)}
          {testResult.detail ? ` — ${testResult.detail}` : ""}
        </p>
      )}

      {/* Shared pool health (admin): the difference between "wiring is wrong"
          and "the upstream key pool is dry" at a glance. */}
      {pool?.configured && (
        <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs" data-testid="websearch-pool">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <Globe className="h-3 w-3" />
            {t("settings.websearch.shared.poolTitle")}
          </div>
          {pool.reachable ? (
            <div className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
              {/* Upstream routing (search-relay-via-ciyuan): lane = the platform
                  gateway websearch lane serves this pool; direct = cold standby
                  (pre-migration relays omit the field and this row hides). */}
              {pool.upstream && (
                <span data-testid="websearch-pool-upstream">
                  {pool.upstream.mode === "ciyuan"
                    ? t("settings.websearch.shared.upstreamLane")
                    : t("settings.websearch.shared.upstreamDirect")}
                  {pool.upstream.mode === "ciyuan" && pool.upstream.fallbacks > 0
                    ? ` · ${t("settings.websearch.shared.upstreamFallbacks", { count: pool.upstream.fallbacks })}`
                    : ""}
                </span>
              )}
              {pool.upstream?.breakerOpen && (
                <span data-testid="websearch-pool-lane-down" className="text-warning">
                  {t("settings.websearch.shared.upstreamLaneDown")}
                </span>
              )}
              <span data-testid="websearch-pool-keys">
                {t("settings.websearch.shared.poolKeys", { total: pool.keys.length, cooling })}
              </span>
              <span data-testid="websearch-pool-usage">
                {t("settings.websearch.shared.poolUsage", { day: pool.day, used: pool.overrides?.used ?? 0, fallback: pool.overrides?.fallback ?? 0 })}
              </span>
              {(pool.errors?.poolDry ?? 0) > 0 && (
                <span data-testid="websearch-pool-dry" className="text-warning">
                  {t("settings.websearch.shared.poolDry", { count: pool.errors?.poolDry ?? 0 })}
                </span>
              )}
            </div>
          ) : (
            <p className="mt-1 text-destructive" data-testid="websearch-pool-unreachable">
              {t("settings.websearch.shared.poolUnreachable")}{pool.detail ? ` — ${pool.detail}` : ""}
            </p>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">{t("settings.websearch.scopeHint")}</p>
    </div>
  );
}

export function WebSearchSection() {
  const { t } = useTranslation();
  const { groups, adminGroups, authenticated } = useAuthStore();
  // Admin check mirrors the server gate: intersection of the user's groups
  // with the deployment's ADMIN_GROUPS; auth off (machine owner) = admin.
  const isAdmin =
    !authenticated ||
    (Array.isArray(groups) && Array.isArray(adminGroups) && groups.some((g) => adminGroups.includes(g)));

  return (
    <div className="flex flex-col gap-6" data-testid="settings-websearch">
      <p className="text-sm text-muted-foreground">{t("settings.websearch.subtitle")}</p>
      <UserKeyZone />
      {isAdmin && (
        <div className="border-t border-border pt-4">
          <SharedServiceZone />
        </div>
      )}
    </div>
  );
}
