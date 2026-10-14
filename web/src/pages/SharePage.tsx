// Public shared-session view (openspec: add-session-share). Reachable at
// /share/:token WITHOUT login — the one exempted route in App's auth gate.
// Read-only by construction: it calls only the public share endpoint and
// renders turns; there is no composer, no session state, no websocket here.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { getSharedSession } from "@platform/core";
import { Markdown } from "@/components/Markdown";
import type { ChatMessage } from "@platform/core";

type State =
  | { kind: "loading" }
  | { kind: "ready"; title: string; messages: ChatMessage[] }
  | { kind: "unavailable" };

export function SharePage() {
  const { t } = useTranslation();
  // Not mounted under a <Route path="/share/:token"> — App renders this page
  // directly from its auth gate, so the token comes from the URL path, not
  // useParams.
  const { pathname } = useLocation();
  const token = pathname.split("/")[2] ?? "";
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    getSharedSession(token)
      .then((s) => {
        if (!cancelled) setState({ kind: "ready", title: s.title, messages: s.messages });
      })
      .catch(() => {
        // 404 (revoked/expired/deleted/unknown) and transport errors render
        // the same friendly page — never a hint about what happened.
        if (!cancelled) setState({ kind: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="mx-auto flex h-dvh max-w-4xl flex-col px-4 py-6" data-testid="share-page">
      <header className="flex items-center justify-between border-b border-border pb-3">
        <span className="text-sm text-muted-foreground">{t("share.banner")}</span>
      </header>
      {state.kind === "loading" ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("share.loading")}
        </div>
      ) : state.kind === "unavailable" ? (
        <div className="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground">
          {t("share.unavailable")}
        </div>
      ) : (
        <>
          {state.title ? (
            <h1 className="truncate py-4 text-lg font-medium" data-testid="share-title">
              {state.title}
            </h1>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto pb-6">
            {state.messages.map((m) => {
              // Static one-shot transcript (no ids in the public share shape,
              // no reordering): a content-derived key keeps Biome's
              // no-array-index rule satisfied without behavior change.
              const key = `${m.role}:${m.content.length}:${m.content.slice(0, 16)}`;
              return m.role === "user" ? (
                <div key={key} className="rounded-lg bg-muted px-4 py-2 text-sm whitespace-pre-wrap">
                  {m.content}
                </div>
              ) : (
                <div key={key} className="text-sm">
                  <Markdown text={m.content} />
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
