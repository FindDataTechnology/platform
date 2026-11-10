// ShellErrorBoundary.tsx — the SPA never blanks out (openspec:
// harden-spa-shell-resilience, web-shell-resilience「渲染崩溃降级为页内错误
// 态」+「chunk 加载失败自动重载一次」).
//
// Two mounts, one component (design D2):
//  - INNER, inside the work layout around <Suspense><Routes/></Suspense>: a
//    route-level render crash — or a lazy-import failure from a shell older
//    than the server's dist — replaces the CONTENT area only; the sidebar
//    and nav stay alive so the user can leave the broken page.
//  - OUTER, at the root in main.tsx: the last-resort catcher for anything
//    the layout itself throws; worst case is a standalone card with a reload
//    button, never a white document.
//
// Chunk failures self-heal exactly once per module URL per session (the
// claim lives in lib/chunk-failure.ts, the framework-free core); a repeat
// falls through to the card instead of looping the reload.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { chunkFailureKey, claimReloadOnce, isChunkLoadError } from "@/lib/chunk-failure";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ShellErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    if (isChunkLoadError(error) && claimReloadOnce(chunkFailureKey(error))) {
      window.location.reload();
    }
  }

  render(): ReactNode {
    if (this.state.error) {
      return <ShellErrorCard onRetry={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}

// The card keeps states-kit's error vocabulary (role=alert, status-failed
// border) but owns two exits, which ErrorState's single onRetry cannot
// express: retry re-renders the subtree in place; reload starts a fresh
// document (the path out of a still-stale shell after the once-claim was
// spent).
function ShellErrorCard({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      data-testid="shell-error-card"
      className="mx-auto flex max-w-md flex-col items-center justify-center gap-2 rounded-md border border-status-failed/40 bg-card px-6 py-10 text-center"
    >
      <AlertCircle className="h-6 w-6 text-status-failed" aria-hidden="true" />
      <div className="text-sm font-medium text-status-failed">{t("shell.error.title")}</div>
      <div className="text-sm text-muted-foreground">{t("shell.error.body")}</div>
      <div className="mt-2 flex items-center gap-2">
        <Button type="button" size="sm" onClick={onRetry}>
          {t("shell.error.retry")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => window.location.reload()}>
          {t("shell.error.reload")}
        </Button>
      </div>
    </div>
  );
}
