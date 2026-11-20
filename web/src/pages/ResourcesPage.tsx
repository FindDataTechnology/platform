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
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useNavigate } from "react-router-dom";
import {
  asOfResource,
  chartOption,
  chartPeriods,
  defaultPeriodWindow,
  fileRefPath,
  filterChartOption,
  formatFileSize,
  refreshBinding,
  resourceFileRef,
  resourceFileUrl,
  useChatStore,
  RESOURCE_GROUPS,
  type ClientMessage,
  type PeriodWindow,
  type Resource,
  type ResourceGroup,
} from "@platform/core";
import { showToast } from "@/components/ui/toast";
import { EChart } from "@/components/EChart";
import { ChartBindingBar, ChartBindPicker, ChartTimeline } from "@/components/resources/ChartBinding";
import JSZip from "jszip";
import { useResourcesStore, type ResourceTimePreset, type ResourceTypeFilter } from "@/hooks/useResourcesStore";
import { usePreviewStore } from "@/hooks/usePreviewStore";

export interface ResourcesPageProps {
  send: (msg: ClientMessage) => void;
}

const FILTERS: ResourceTypeFilter[] = ["all", "chart", "file"];
const TIME_PRESETS: ResourceTimePreset[] = ["all", "today", "7d", "30d"];
// Unified memory & outputs: tier filter row + per-card badge/gestures.
const TIERS = ["draft", "stable", "canonical"] as const;
function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean).slice(0, 5);
  if (typeof raw === "string" && raw.trim()) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.map(String).filter(Boolean).slice(0, 5);
    } catch { /* malformed */ }
  }
  return [];
}
// The tier column is a plain string, NOT a JSON array like tags — parsing it
// with parseTags read every graded output as "draft", so the badge lied and
// "取消正典" could never fire. Read it as the enum it is.
function parseTier(raw: unknown): (typeof TIERS)[number] {
  const t = typeof raw === "string" ? raw.trim() : "";
  return (TIERS as readonly string[]).includes(t) ? (t as (typeof TIERS)[number]) : "draft";
}
// The chip row mirrors the server's group list, minus the chart group when the
// files tab already means "files only".
const FILE_GROUPS: ResourceGroup[] = RESOURCE_GROUPS.filter((g) => g !== "chart");

// `MM-DD HH:mm` for the current year, `YYYY-MM-DD HH:mm` for anything older —
// a resource from last March must not read like one from last week.
function formatCreatedAt(iso: string | null, now = new Date()): string {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return at.getFullYear() === now.getFullYear() ? stamp : `${at.getFullYear()}-${stamp}`;
}

function ResourceCard({
  resource,
  sessionExists,
  send,
  selected,
  onToggleSelect,
}: {
  resource: Resource;
  sessionExists: boolean;
  send: ResourcesPageProps["send"];
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openPreview = usePreviewStore((s) => s.open);
  const rename = useResourcesStore((s) => s.rename);
  const remove = useResourcesStore((s) => s.remove);
  const load = useResourcesStore((s) => s.load);
  const remember = useResourcesStore((s) => s.remember);
  const setTier = useResourcesStore((s) => s.setTier);
  const setTags = useResourcesStore((s) => s.setTags);
  const memoryOff = useResourcesStore((s) => s.memoryOff);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(resource.title);
  // Inline tag editor (the surface's own row, not a window.prompt): the
  // draft lives here so opening it never mutates the row until 保存.
  const [editingTags, setEditingTags] = useState(false);
  const [tagsDraft, setTagsDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [periodWindow, setPeriodWindow] = useState<PeriodWindow | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [asOf, setAsOf] = useState<{ at: string; option: Record<string, unknown> } | null>(null);

  const option = resource.type === "chart" ? chartOption(resource) : null;
  const fileUrl = resourceFileUrl(resource);
  const shortCreatedAt = formatCreatedAt(resource.createdAt ?? null);
  const fullCreatedAt = resource.createdAt ? new Date(resource.createdAt).toLocaleString() : "";

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
      showToast({ severity: "error", title: (err as Error).message });
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
      showToast({ severity: "error", title: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    setBusy(true);
    try {
      await remove(resource.id);
    } catch (err) {
      showToast({ severity: "error", title: (err as Error).message });
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
      {/* Batch-export selection: file entries only (charts don't participate —
          spec: resource-library-ui). */}
      {resource.type === "file" && onToggleSelect ? (
        <label className="mb-1 flex w-fit cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={Boolean(selected)}
            onChange={onToggleSelect}
            data-testid="resource-select"
            className="h-3.5 w-3.5"
          />
        </label>
      ) : null}
      {/* Wraps, and the title keeps a floor: a chart card carries several
          shrink-0 chips (kind + tier + binding/refresh), and on a 320px grid
          cell they used to consume the whole line — the `min-w-0 flex-1`
          title then resolved to ZERO width, i.e. the card's name was invisible
          (found by e2e/artifact-delivery, which could only report "hidden"). */}
      <div className="flex flex-wrap items-start gap-2">
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
            <span className="min-w-0 flex-1 basis-1/2 truncate text-sm font-medium" data-testid="resource-title">
              {resource.title}
            </span>
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {t(`resources.kind.${resource.type === "chart" ? "chart" : "file"}`)}
            </span>
            {(() => {
              const tier = parseTier(resource.tier);
              return (
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs border ${
                    tier === "canonical"
                      ? // Category highlight (canonical tier) rides the warning
                        // token — the amber is the vocabulary's, not an invented
                        // hue; the label does the semantic work.
                        "border-status-waiting/50 bg-status-waiting/10 text-status-waiting"
                      : tier === "stable"
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border bg-muted/40 text-muted-foreground"
                  }`}
                  data-testid={`resource-tier-${tier}`}
                  title={`tier: ${tier}`}
                >
                  {t(`resources.memory.tier.${tier}`)}
                </span>
              );
            })()}
          </>
        )}

      {/* Tags chips（AI 提议/人类确认区别徽标）与三手势：记住、钉为正典、改 tag */}
      {(() => {
        const tags = parseTags(resource.tags);
        const tier = parseTier(resource.tier);
        const onRemember = async () => { try { await remember(resource.id); } catch (e) { showToast({ severity: "error", title: (e as Error).message }); } };
        const onToggleCanon = async () => { try { await setTier(resource.id, tier === "canonical" ? "stable" : "canonical"); } catch (e) { showToast({ severity: "error", title: (e as Error).message }); } };
        const openTagEditor = () => {
          setTagsDraft(tags.join(", "));
          setEditingTags(true);
        };
        const onSaveTags = async () => {
          setEditingTags(false);
          try { await setTags(resource.id, tagsDraft.split(/[,，]/).map((x) => x.trim()).filter(Boolean).slice(0, 5)); } catch (e) { showToast({ severity: "error", title: (e as Error).message }); }
        };
        return editingTags ? (
          <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="resource-memory-row">
            <input
              autoFocus
              value={tagsDraft}
              onChange={(ev) => setTagsDraft(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") void onSaveTags();
                if (ev.key === "Escape") setEditingTags(false);
              }}
              placeholder={t("resources.memory.tags.prompt")}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-0.5 text-xs"
              data-testid="resource-tag-input"
            />
            <button type="button" className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted" onClick={() => void onSaveTags()} data-testid="resource-tag-save">
              {t("common.save")}
            </button>
            <button type="button" className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted" onClick={() => setEditingTags(false)} data-testid="resource-tag-cancel">
              {t("common.cancel")}
            </button>
          </div>
        ) : (
          <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="resource-memory-row">
            {[...new Set(tags)].map((tag) => (
              <span key={tag} className="rounded-full bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground" data-testid={`resource-tag-${tag}`}>
                {tag}
                {(resource as Resource & { tagsOrigin?: string }).tagsOrigin === "ai" ? <span className="ml-1 opacity-70">·AI</span> : null}
              </span>
            ))}
            {/* No memory service on this deployment: the gestures say so once
                instead of failing on every click (the 503 rule lives in the store). */}
            <button
              type="button"
              disabled={memoryOff}
              title={memoryOff ? t("memory.degraded.unavailable") : undefined}
              className="ml-auto rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void onRemember()}
              data-testid="resource-remember"
            >
              {t("resources.memory.actions.remember")}
            </button>
            <button
              type="button"
              disabled={memoryOff}
              title={memoryOff ? t("memory.degraded.unavailable") : undefined}
              className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void onToggleCanon()}
              data-testid="resource-tier-toggle"
            >
              {tier === "canonical" ? t("resources.memory.actions.unpinCanonical") : t("resources.memory.actions.pinCanonical")}
            </button>
            <button
              type="button"
              disabled={memoryOff}
              title={memoryOff ? t("memory.degraded.unavailable") : undefined}
              className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              onClick={openTagEditor}
              data-testid="resource-tag-edit"
            >
              {t("resources.memory.actions.editTags")}
            </button>
          </div>
        );
      })()}
      </div>

      {/* Creation time on every card (openspec: add-resource-filters). Short and
          absolute — the library is looked back through, and a relative age
          silently drifts; the full timestamp rides the title attribute. */}
      <div
        className="mt-1 text-xs text-muted-foreground"
        title={fullCreatedAt}
        data-testid="resource-created-at"
        data-created-at={resource.createdAt}
      >
        {shortCreatedAt}
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
          onClick={() => setDeleteOpen(true)}
          disabled={busy}
          data-testid="resource-delete"
        >
          {t("resources.actions.delete")}
        </button>
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={t("resources.actions.delete")}
          description={t("resources.actions.deleteConfirm")}
          confirmLabel={t("resources.actions.delete")}
          cancelLabel={t("common.cancel")}
          onConfirm={() => void confirmDelete()}
          variant="danger"
        />
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
  const timePreset = useResourcesStore((s) => s.timePreset);
  const setTimePreset = useResourcesStore((s) => s.setTimePreset);
  const groups = useResourcesStore((s) => s.groups);
  const toggleGroup = useResourcesStore((s) => s.toggleGroup);
  const facets = useResourcesStore((s) => s.facets);
  const load = useResourcesStore((s) => s.load);
  const loadMore = useResourcesStore((s) => s.loadMore);
  const sessions = useChatStore((s) => s.sessions);

  const [searchInput, setSearchInput] = useState("");
  // Batch export (add-projects-automation-flow): file ids selected for the
  // client-side zip. Charts never enter the set; deselect-all hides the bar.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exportSelected = async () => {
    const chosen = items.filter((r) => selectedIds.has(r.id) && r.type === "file");
    if (!chosen.length) return;
    setExporting(true);
    try {
      const zip = new JSZip();
      const used = new Set<string>();
      for (const r of chosen) {
        const ref = resourceFileRef(r);
        if (!ref) continue;
        const res = await fetch(fileRefPath(ref));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = await res.blob();
        // Displayed name wins; a repeat gets a numeric suffix, not a clobber.
        let name = r.title || ref.rel;
        let n = 2;
        while (used.has(name)) {
          const dot = name.lastIndexOf(".");
          name = dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
          n += 1;
        }
        used.add(name);
        zip.file(name, bytes);
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      a.href = url;
      a.download = `outputs-${date}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setSelectedIds(new Set());
    } catch (e) {
      showToast({ severity: "error", title: (e as Error).message });
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  const tierFilterState = useResourcesStore((s) => s.tierFilter);
  const setTierFilter = useResourcesStore((s) => s.setTierFilter);
  const tagFilterState = useResourcesStore((s) => s.tagFilter);
  const toggleTagFilter = useResourcesStore((s) => s.toggleTagFilter);
  const unionTags = useMemo(() => {
    const set = new Set<string>();
    for (const r of items) for (const tag of parseTags(r.tags)) set.add(tag);
    return [...set].slice(0, 8);
  }, [items]);
  // Debounced so every keystroke is not a request; the store refetches.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(id);
  }, [searchInput, setSearch]);

  const sessionIds = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions]);
  // Any departure from the landing view counts as "filtered" for the empty
  // state's wording: with no filters at all, the library itself is empty.
  const filtered = searchInput.trim().length > 0 || typeFilter !== "all" || timePreset !== "all";
  const visibleGroups: ResourceGroup[] = typeFilter === "file" ? FILE_GROUPS : [...RESOURCE_GROUPS];

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

        {/* Memory tier + tag filters (add-unified-memory-and-outputs): draft/
            stable/canonical（草稿/成果/正典）三档与 tags 芯片筛选，服务端过滤。 */}
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="resources-tier-row">
          <span className="text-xs text-muted-foreground">{t("resources.memory.tier.label")}</span>
          {([null, ...TIERS] as const).map((tier) => (
            <button
              key={`tier-${tier ?? "all"}`}
              className={`shrink-0 rounded-md px-2.5 py-1 text-xs ${
                tierFilterState === tier ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted"
              }`}
              onClick={() => setTierFilter(tier)}
              data-testid={`resources-tier-${tier ?? "all"}`}
            >
              {tier === null ? t("resources.memory.tier.all") : t(`resources.memory.tier.${tier}`)}
            </button>
          ))}
          {unionTags.length > 0 && (
            <>
              <span className="ml-2 text-xs text-muted-foreground">{t("resources.memory.tags.label")}</span>
              {unionTags.map((tag) => (
                <button
                  key={`tag-${tag}`}
                  className={`shrink-0 rounded-md px-2 py-0.5 text-xs border ${
                    tagFilterState.includes(tag) ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                  onClick={() => toggleTagFilter(tag)}
                  data-testid={`resources-tag-${tag}`}
                >
                  {tag}
                </button>
              ))}
            </>
          )}
        </div>

        {/* Time window and file-kind groups (openspec: add-resource-filters).
            Both rows are server-applied and combine with the tab and the search;
            a change refetches immediately — there is no apply action. */}
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="resources-time-row">
          <span className="text-xs text-muted-foreground">{t("resources.time.label")}</span>
          <div className="flex max-w-full flex-nowrap gap-1 overflow-x-auto">
            {TIME_PRESETS.map((preset) => (
              <button
                key={preset}
                className={`shrink-0 rounded-md px-2.5 py-1 text-xs ${
                  timePreset === preset
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-muted"
                }`}
                onClick={() => setTimePreset(preset)}
                data-testid={`resources-time-${preset}`}
              >
                {t(`resources.time.${preset}`)}
              </button>
            ))}
          </div>
        </div>

        {/* Absent on the charts tab: the tab is already the group filter there.
            The chart chip is absent on the files tab for the same reason. */}
        {typeFilter === "chart" ? null : (
          <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="resources-group-row">
            <span className="text-xs text-muted-foreground">{t("resources.group.label")}</span>
            {visibleGroups.map((group) => {
              const checked = groups.includes(group);
              const count = facets[group] ?? 0;
              return (
                <button
                  key={group}
                  className={`shrink-0 rounded-md border px-2.5 py-1 text-xs ${
                    checked
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted"
                  } ${count === 0 ? "opacity-50" : ""}`}
                  onClick={() => toggleGroup(group)}
                  disabled={count === 0 && !checked}
                  aria-pressed={checked}
                  data-testid={`resources-group-${group}`}
                  data-checked={checked ? "true" : "false"}
                  data-count={count}
                >
                  {t(`resources.group.${group}`)} ({count})
                </button>
              );
            })}
          </div>
        )}
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
            {selectedIds.size > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="resources-export-bar">
                <button
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  onClick={() => void exportSelected()}
                  disabled={exporting}
                  data-testid="resources-export"
                >
                  {exporting ? t("resources.exporting") : t("resources.export", { count: selectedIds.size })}
                </button>
                <span className="text-xs text-muted-foreground">{t("resources.selectHint")}</span>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((resource) => (
                <ResourceCard
                  key={resource.id}
                  resource={resource}
                  sessionExists={resource.sessionId ? sessionIds.has(resource.sessionId) : false}
                  send={send}
                  selected={selectedIds.has(resource.id)}
                  onToggleSelect={resource.type === "file" ? () => toggleSelect(resource.id) : undefined}
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