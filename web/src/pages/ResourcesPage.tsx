// ResourcesPage.tsx — the resource library surface (spec: resource-library-ui).
//
// One list, two kinds: charts captured from assistant turns render live
// through the same EChart component the chat uses; saved files open in the
// same preview drawer. Rename / delete / jump-to-source are per card.
//
// Data lives in useResourcesStore (REST + the resources_changed WS event);
// this page owns only view state: the debounced search box and the inline
// rename editor.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  asOfResource,
  chartOption,
  chartPeriods,
  defaultPeriodWindow,
  filterChartOption,
  formatFileSize,
  refreshBinding,
  resourceFileRef,
  resourceFileUrl,
  useChatStore,
  type ClientMessage,
  type PeriodWindow,
  type Resource,
} from "@platform/core";
import { showToast } from "@/components/Toast";
import { EChart } from "@/components/EChart";
import { ChartBindingBar, ChartBindPicker, ChartTimeline } from "@/components/resources/ChartBinding";
import { useResourcesStore, type ResourceTypeFilter } from "@/hooks/useResourcesStore";
import { usePreviewStore } from "@/hooks/usePreviewStore";

export interface ResourcesPageProps {
  send: (msg: ClientMessage) => void;
}

const FILTERS: ResourceTypeFilter[] = ["all", "chart", "file"];

function ResourceCard({
  resource,
  sessionExists,
  send,
}: {
  resource: Resource;
  sessionExists: boolean;
  send: ResourcesPageProps["send"];
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openPreview = usePreviewStore((s) => s.open);
  const rename = useResourcesStore((s) => s.rename);
  const remove = useResourcesStore((s) => s.remove);
  const load = useResourcesStore((s) => s.load);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(resource.title);
  const [busy, setBusy] = useState(false);
  const [periodWindow, setPeriodWindow] = useState<PeriodWindow | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [asOf, setAsOf] = useState<{ at: string; option: Record<string, unknown> } | null>(null);

  const option = resource.type === "chart" ? chartOption(resource) : null;
  const fileUrl = resourceFileUrl(resource);

  // `bindings` is absent on a cell older than this capability: the whole
  // bound-chart surface hides itself and the chart renders as it always did.
  const bindings = resource.bindings ?? [];
  const knowsBindings = resource.bindings !== undefined;
  const periods = useMemo(() => chartPeriods(option), [option]);
  const effectiveWindow = periodWindow ?? (periods.length ? defaultPeriodWindow(periods) : "all");
  const displayed = asOf?.option ?? filterChartOption(option, effectiveWindow);

  // On-open refresh: a binding with a TTL asks to be refreshed when its data is
  // older than the TTL. The cell re-checks and answers "skipped_fresh" when it
  // is not, so a stale client clock cannot force a read. The key is the TTL
  // state itself, so a list refetch that changes nothing re-runs nothing.
  const onOpenKey = useMemo(
    () =>
      bindings
        .filter((binding) => binding.refreshable && Number(binding.refreshRule?.ttlSec) > 0)
        .map(
          (binding) =>
            `${binding.id}:${binding.refreshRule?.ttlSec}:${binding.lastObservedAt ?? binding.lastOkAt ?? ""}`,
        )
        .join("|"),
    [bindings],
  );

  useEffect(() => {
    if (resource.type !== "chart" || !onOpenKey) return;
    const ttlOf = (binding: (typeof bindings)[number]) => Number(binding.refreshRule?.ttlSec) || 0;
    const stale = bindings.filter((binding) => {
      const at = binding.lastObservedAt ?? binding.lastOkAt;
      return !at || Date.now() - Date.parse(at) > ttlOf(binding) * 1000;
    });
    if (!stale.length) return;
    let cancelled = false;
    void (async () => {
      let moved = 0;
      for (const binding of stale) {
        try {
          const result = await refreshBinding(resource.id, binding.id, { trigger: "on-open" });
          if (result.ok && result.counts) {
            moved += result.counts.appended + result.counts.revised + result.counts.resourced;
          }
        } catch {
          // An older cell 404s this route: the affordances hide, no error shown.
        }
      }
      if (!cancelled && moved > 0) void load();
    })();
    return () => {
      cancelled = true;
    };
  }, [resource.id, resource.type, onOpenKey, bindings, load]);

  const openFile = () => {
    const ref = resourceFileRef(resource);
    if (!ref || !fileUrl) return;
    openPreview({ name: resource.title, url: fileUrl, ref });
  };

  const viewAsOf = async (at: string | null) => {
    if (!at) {
      setAsOf(null);
      return;
    }
    try {
      const view = await asOfResource(resource.id, at);
      setAsOf({ at: view.at, option: view.option });
    } catch (err) {
      showToast((err as Error).message);
    }
  };

  const jumpToSource = () => {
    if (!resource.sessionId || !sessionExists) return;
    send({ type: "switch_session", id: resource.sessionId });
    navigate(`/chat/${resource.sessionId}`);
  };

  const submitRename = async () => {
    const title = draft.trim();
    if (!title || title === resource.title) {
      setEditing(false);
      setDraft(resource.title);
      return;
    }
    setBusy(true);
    try {
      await rename(resource.id, title);
      setEditing(false);
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!window.confirm(t("resources.actions.deleteConfirm"))) return;
    setBusy(true);
    try {
      await remove(resource.id);
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex flex-col rounded-md border border-border bg-card p-3"
      data-testid="resource-card"
      data-resource-id={resource.id}
      data-resource-type={resource.type}
    >
      <div className="flex items-start gap-2">
        {editing ? (
          <>
            <input
              autoFocus
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitRename();
                if (e.key === "Escape") {
                  setEditing(false);
                  setDraft(resource.title);
                }
              }}
              data-testid="resource-rename-input"
            />
            <button
              className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
              onClick={() => void submitRename()}
              disabled={busy}
              data-testid="resource-rename-save"
            >
              {t("resources.actions.renameSave")}
            </button>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-sm font-medium" data-testid="resource-title">
              {resource.title}
            </span>
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {t(`resources.kind.${resource.type === "chart" ? "chart" : "file"}`)}
            </span>
          </>
        )}
      </div>

      <div className="mt-2 min-h-0 flex-1">
        {resource.type === "chart" ? (
          option ? (
            <>
              {asOf ? (
                <div
                  className="mb-1 flex items-center gap-2 rounded-md bg-primary/10 px-2 py-1 text-xs text-primary"
                  data-testid="asof-banner"
                >
                  <span>
                    {t("resources.binding.historical")} ·{" "}
                    {new Date(asOf.at).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <button
                    type="button"
                    className="ml-auto rounded-md border border-primary/40 px-2 py-0.5"
                    onClick={() => void viewAsOf(null)}
                    data-testid="asof-return"
                  >
                    {t("resources.binding.backToCurrent")}
                  </button>
                </div>
              ) : null}
              <EChart option={displayed ?? option} />
            </>
          ) : (
            <div className="my-3 rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
              {t("resources.chartUnrenderable")}
            </div>
          )
        ) : (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-6 text-left hover:bg-muted"
            onClick={openFile}
            data-testid="resource-open"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{resource.title}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {[resource.fileMime, formatFileSize(resource.fileSize)].filter(Boolean).join(" · ")}
              </span>
            </span>
          </button>
        )}
      </div>

      {resource.type === "chart" && knowsBindings ? (
        <>
          {bindings.map((binding) => (
            <ChartBindingBar
              key={binding.id}
              resource={resource}
              binding={binding}
              seriesCount={bindings.length}
              window={effectiveWindow}
              shown={chartPeriods(displayed ?? option).length}
              onWindow={(next) => {
                setPeriodWindow(next);
                setAsOf(null);
              }}
              onChanged={() => void load()}
              onTimeline={() => setTimelineOpen((open) => !open)}
              timelineOpen={timelineOpen}
            />
          ))}
          {!bindings.length ? <ChartBindPicker resource={resource} onChanged={() => void load()} /> : null}
          {timelineOpen && bindings.length ? (
            <ChartTimeline resource={resource} onView={(at) => void viewAsOf(at)} />
          ) : null}
        </>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" data-testid="resource-provenance">
          {resource.sessionTitle ?? ""}
        </span>
        {resource.sessionId && sessionExists ? (
          <button
            className="rounded-md border border-border px-2 py-0.5 hover:bg-muted"
            onClick={jumpToSource}
            data-testid="resource-jump"
          >
            {t("resources.actions.jump")}
          </button>
        ) : null}
        {resource.type === "file" && fileUrl ? (
          <a
            className="rounded-md border border-border px-2 py-0.5 hover:bg-muted"
            href={fileUrl}
            download={resource.title}
            data-testid="resource-download"
          >
            {t("resources.actions.download")}
          </a>
        ) : null}
        {!editing ? (
          <button
            className="rounded-md border border-border px-2 py-0.5 hover:bg-muted"
            onClick={() => setEditing(true)}
            data-testid="resource-rename"
          >
            {t("resources.actions.rename")}
          </button>
        ) : null}
        <button
          className="rounded-md border border-destructive/40 px-2 py-0.5 text-destructive hover:bg-destructive/10 disabled:opacity-50"
          onClick={() => void confirmDelete()}
          disabled={busy}
          data-testid="resource-delete"
        >
          {t("resources.actions.delete")}
        </button>
      </div>
    </div>
  );
}

export function ResourcesPage({ send }: ResourcesPageProps) {
  const { t } = useTranslation();
  const items = useResourcesStore((s) => s.items);
  const total = useResourcesStore((s) => s.total);
  const loading = useResourcesStore((s) => s.loading);
  const loadingMore = useResourcesStore((s) => s.loadingMore);
  const error = useResourcesStore((s) => s.error);
  const typeFilter = useResourcesStore((s) => s.typeFilter);
  const setTypeFilter = useResourcesStore((s) => s.setTypeFilter);
  const setSearch = useResourcesStore((s) => s.setSearch);
  const load = useResourcesStore((s) => s.load);
  const loadMore = useResourcesStore((s) => s.loadMore);
  const sessions = useChatStore((s) => s.sessions);

  const [searchInput, setSearchInput] = useState("");

  useEffect(() => {
    void load();
  }, [load]);

  // Debounced so every keystroke is not a request; the store refetches.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(id);
  }, [searchInput, setSearch]);

  const sessionIds = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions]);
  const filtered = searchInput.trim().length > 0 || typeFilter !== "all";

  return (
    <div className="flex h-full flex-col bg-background" data-testid="resources-page">
      <div className="border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">{t("resources.title")}</h1>
          <span className="text-xs text-muted-foreground" data-testid="resources-total">
            {t("resources.count", { count: total })}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {FILTERS.map((filter) => (
              <button
                key={filter}
                className={`rounded-md px-3 py-1 text-sm ${
                  typeFilter === filter
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-muted"
                }`}
                onClick={() => setTypeFilter(filter)}
                data-testid={`resources-filter-${filter}`}
              >
                {t(`resources.filter.${filter}`)}
              </button>
            ))}
            <input
              className="w-56 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              placeholder={t("resources.search")}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              data-testid="resources-search"
            />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {error ? (
          <div className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="resources-error">
            {t("resources.error", { message: error })}
          </div>
        ) : null}
        {loading && items.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            {t("resources.loading")}
          </div>
        ) : items.length === 0 ? (
          <div
            className="flex h-40 items-center justify-center px-6 text-center text-sm text-muted-foreground"
            data-testid="resources-empty"
          >
            {filtered ? t("resources.emptyFiltered") : t("resources.empty")}
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((resource) => (
                <ResourceCard
                  key={resource.id}
                  resource={resource}
                  sessionExists={resource.sessionId ? sessionIds.has(resource.sessionId) : false}
                  send={send}
                />
              ))}
            </div>
            {items.length < total ? (
              <div className="mt-4 flex justify-center">
                <button
                  className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  data-testid="resources-load-more"
                >
                  {t("resources.loadMore")}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}