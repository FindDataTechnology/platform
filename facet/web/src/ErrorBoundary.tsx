// View-level containment for the facet shell (spec: facet-platform — a view
// failure cannot blank the shell). Class boundary — React has no hook
// equivalent. The shell mounts one boundary around the main area per view
// (keyed by the active view), so a throwing view only ever takes down its
// own pane; the header, tabs, and footer render outside it. Retry clears the
// boundary state and remounts the child fresh.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[facet-shell] view failed to render:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        data-testid="facet-view-error"
        className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 space-y-2"
      >
        <p className="text-sm font-medium text-foreground">此视图加载失败 / This view failed to load</p>
        <p className="text-xs text-muted-foreground break-all">{String(this.state.error)}</p>
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          onClick={() => this.setState({ error: null })}
          data-testid="facet-view-retry"
        >
          重试 Retry
        </button>
      </div>
    );
  }
}
