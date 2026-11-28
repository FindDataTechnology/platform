// Embedded service views: ExternalService apps (NEW API-style) shown as
// same-origin iframes. These are third-party projects with their own native
// UIs - we embed, not reimplement. Tokens are injected server-side by the
// /external/:appId proxy; no secrets reach this renderer.
//
// Only the wrapper chrome (loading state, blocked-frame fallback, not-configured
// message) is localized here; the iframe internals have their own i18n.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { cn } from "@/lib/utils";

function EmbeddedFrame({ src, testId }: { src: string; testId: string }) {
  const { t } = useTranslation();
  const [blocked, setBlocked] = useState(false);
  // If the iframe hasn't loaded successfully after a few seconds, offer a
  // fallback "open in new tab" link (handles X-Frame-Options / CSP blocks).
  // Track load state in a ref so the timeout only fires the overlay when onLoad
  // has NOT yet fired - otherwise a fast-loading iframe would be covered by the
  // overlay at 5s (the unconditional timer used to re-block after onLoad).
  const loadedRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `src` is the deliberate trigger — reset the overlay/block state when the iframe target changes
  useEffect(() => {
    loadedRef.current = false;
    setBlocked(false);
    const timer = setTimeout(() => {
      if (!loadedRef.current) setBlocked(true);
    }, 5000);
    return () => clearTimeout(timer);
  }, [src]);
  return (
    <div className="relative flex-1">
      <iframe
        src={src}
        data-testid={testId}
        className="h-full w-full border-0"
        title={t("embedded.iframeTitle")}
        onLoad={() => {
          loadedRef.current = true;
          setBlocked(false);
        }}
      />
      {blocked && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80" data-testid="iframe-blocked">
          <div className="text-center">
            <p className="text-sm text-muted-foreground">{t("embedded.blockedMessage")}</p>
            <a href={src} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted">
              {t("embedded.openInNewTab")}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

// ExternalServicePage — embedded iframe for any external-service catalog entry
// (e.g. NEW API). The /external/:appId route is registered server-side based
// on agents.json's external-service entries. Falls back to a placeholder if the
// app id isn't in the catalog (stale link).
export function ExternalServicePage() {
  const { appId } = useParams<{ appId: string }>();
  if (!appId) {
    return <Placeholder title="External Service" testId="external-service-missing" />;
  }
  return (
    <main className="flex h-full min-w-0 flex-col" data-testid={`external-service-page-${appId}`}>
      <EmbeddedFrame src={`/external/${appId}`} testId={`external-service-iframe-${appId}`} />
    </main>
  );
}

function Placeholder({ title, testId }: { title: string; testId: string }) {
  const { t } = useTranslation();
  return (
    <main className={cn("flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center p-6")}>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-muted-foreground" data-testid={testId}>{t("embedded.notConfigured", { name: title })}</p>
    </main>
  );
}
