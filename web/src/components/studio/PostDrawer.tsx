// PostDrawer — the team document's per-post editor (complete-team-authoring-
// loop 2.4, design D2).
//
// One post's authorable fields, in one drawer, on the document's own draft:
// title / parent / 节奏 / promptTemplate / KPI 槽位. The field set and the
// cadence grammar are the LIVE fleet's (InspectorDrawer's 配置 tab and
// MemberComposerDialog), because that pair has already been through real-machine
// verification — a second field vocabulary here would drift on exactly the
// fields a user cannot verify by eye.
//
// What it deliberately does NOT carry: model / fallbackModel / effort /
// contextBudget. Those have no place in `parseFleetTemplate`'s whitelist, so
// exposing them would mean also changing the template contract. design.md
// lists this as the known gap.
//
// Writes go through the caller's patchContent → the document's ordinary
// autosave. This drawer never invents a write path.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cadenceToDraft, emptyCadenceDraft, resolveCadence, type CadenceDraft } from "@/lib/cadence-draft";
import type { DocMember } from "@/lib/member-agents-projection";

export interface PostDrawerValue {
  title: string;
  parentRef: string;
  cadence: CadenceDraft;
  kpiSlots: { key: string; label: string; unit?: string; target?: number }[];
}

const EMPTY: PostDrawerValue = { title: "", parentRef: "", cadence: emptyCadenceDraft(), kpiSlots: [] };

function fromMember(m: DocMember | null): PostDrawerValue {
  if (!m) return EMPTY;
  const raw = (m.kpiSlots ?? []) as PostDrawerValue["kpiSlots"];
  return {
    title: typeof m.title === "string" ? m.title : "",
    parentRef: typeof m.parentRef === "string" ? m.parentRef : "",
    cadence: cadenceToDraft(m.cadence as { cron?: string; tz?: string | null; promptTemplate?: string } | null),
    kpiSlots: raw.map((s) => ({ key: s.key ?? "", label: s.label ?? "", unit: s.unit, target: s.target })),
  };
}

export function PostDrawer({
  member,
  siblings,
  onClose,
  onSave,
  onRemove,
}: {
  /** The post being edited; null = drawer closed. */
  member: DocMember | null;
  /** Other posts, for the parent picker. */
  siblings: DocMember[];
  onClose: () => void;
  onSave: (patch: { title: string; parentRef: string | null; cadence: unknown; kpiSlots: unknown[] }) => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<PostDrawerValue>(() => fromMember(member));
  const [error, setError] = useState<string | null>(null);

  // Re-seed when the selected post changes (never carry one post's edits into
  // another's form — the same rule the AI draft overlay applies to drafts).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed keyed on identity is the intent
  useEffect(() => setValue(fromMember(member)), [member?.ref]);

  if (!member) return null;

  const commit = () => {
    if (!value.title.trim()) {
      setError(t("studio.post.titleRequired"));
      return;
    }
    const cadence = resolveCadence(value.cadence);
    if (value.cadence.mode !== "none" && !cadence) {
      setError(t("studio.post.cadenceInvalid"));
      return;
    }
    // A scheduled post needs a prompt: the template validator rejects a
    // cadence without one (`cadence needs a promptTemplate`), so letting the
    // drawer save it would hand the author a green-looking form and a red
    // document.
    if (cadence && !value.cadence.promptTemplate.trim()) {
      setError(t("studio.post.promptRequired"));
      return;
    }
    // KPI slots: drop rows that name neither a key nor a label — an empty row
    // is an unfinished edit, not a declaration the server should reject.
    const kpiSlots = value.kpiSlots
      .map((s) => ({ ...s, key: s.key.trim(), label: s.label.trim() }))
      .filter((s) => s.key && s.label);
    setError(null);
    onSave({
      title: value.title.trim(),
      parentRef: value.parentRef || null,
      cadence: cadence ?? null,
      kpiSlots,
    });
  };

  return (
    <div className="rounded-md border border-border p-3" data-testid="ws-post-drawer">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">{t("studio.post.title")}</h4>
        <button
          type="button"
          aria-label={t("common.close")}
          className="rounded p-1 text-muted-foreground hover:bg-muted"
          onClick={onClose}
          data-testid="ws-post-close"
        >
          ×
        </button>
      </div>

      <div className="space-y-2">
        <div>
          <Label htmlFor="post-title">{t("studio.post.name")}</Label>
          <Input
            id="post-title"
            value={value.title}
            onChange={(e) => setValue((v) => ({ ...v, title: e.target.value }))}
            data-testid="ws-post-title"
          />
        </div>

        <div>
          <Label htmlFor="post-parent">{t("studio.post.parent")}</Label>
          <select
            id="post-parent"
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={value.parentRef}
            onChange={(e) => setValue((v) => ({ ...v, parentRef: e.target.value }))}
            data-testid="ws-post-parent"
          >
            <option value="">{t("studio.post.noParent")}</option>
            {siblings
              .filter((s) => s.ref !== member.ref)
              .map((s) => (
                <option key={s.ref} value={s.ref}>
                  {s.title || s.ref}
                </option>
              ))}
          </select>
        </div>

        <div className="rounded-md border border-border p-2" data-testid="ws-post-cadence">
          <Label>{t("studio.post.cadence")}</Label>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <select
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={value.cadence.mode}
              onChange={(e) => setValue((v) => ({ ...v, cadence: { ...v.cadence, mode: e.target.value as CadenceDraft["mode"] } }))}
              data-testid="ws-post-cadence-mode"
            >
              <option value="none">{t("studio.post.cadenceNone")}</option>
              <option value="hourly">{t("studio.post.cadenceHourly")}</option>
              <option value="daily">{t("studio.post.cadenceDaily")}</option>
              <option value="custom">{t("studio.post.cadenceCustom")}</option>
            </select>
            {value.cadence.mode === "daily" ? (
              <Input
                type="time"
                value={value.cadence.time}
                onChange={(e) => setValue((v) => ({ ...v, cadence: { ...v.cadence, time: e.target.value } }))}
                data-testid="ws-post-cadence-time"
              />
            ) : value.cadence.mode === "custom" ? (
              <Input
                placeholder="0 9 * * *"
                value={value.cadence.cron}
                onChange={(e) => setValue((v) => ({ ...v, cadence: { ...v.cadence, cron: e.target.value } }))}
                data-testid="ws-post-cadence-cron"
              />
            ) : null}
          </div>
          {value.cadence.mode !== "none" ? (
            <div className="mt-2 space-y-2">
              <Input
                placeholder={t("studio.post.tzPlaceholder")}
                value={value.cadence.tz}
                onChange={(e) => setValue((v) => ({ ...v, cadence: { ...v.cadence, tz: e.target.value } }))}
                data-testid="ws-post-cadence-tz"
              />
              <Textarea
                rows={3}
                placeholder={t("studio.post.promptPlaceholder")}
                value={value.cadence.promptTemplate}
                onChange={(e) => setValue((v) => ({ ...v, cadence: { ...v.cadence, promptTemplate: e.target.value } }))}
                data-testid="ws-post-cadence-prompt"
              />
            </div>
          ) : null}
        </div>

        <div className="rounded-md border border-border p-2" data-testid="ws-post-slots">
          <Label>{t("studio.post.kpiSlots")}</Label>
          <div className="mt-1 space-y-1">
            {value.kpiSlots.map((s, i) => (
              /* biome-ignore lint/suspicious/noArrayIndexKey: positional rows of an editable list */
              <div key={i} className="flex items-center gap-1">
                <Input
                  className="font-mono text-xs"
                  placeholder={t("studio.post.slotKey")}
                  value={s.key}
                  onChange={(e) => setValue((v) => ({ ...v, kpiSlots: v.kpiSlots.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) }))}
                  data-testid={`ws-post-slot-key-${i}`}
                />
                <Input
                  className="text-xs"
                  placeholder={t("studio.post.slotLabel")}
                  value={s.label}
                  onChange={(e) => setValue((v) => ({ ...v, kpiSlots: v.kpiSlots.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) }))}
                  data-testid={`ws-post-slot-label-${i}`}
                />
                <Input
                  className="w-20 text-xs"
                  placeholder={t("studio.post.slotUnit")}
                  value={s.unit ?? ""}
                  onChange={(e) => setValue((v) => ({ ...v, kpiSlots: v.kpiSlots.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)) }))}
                  data-testid={`ws-post-slot-unit-${i}`}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("studio.remove")}
                  onClick={() => setValue((v) => ({ ...v, kpiSlots: v.kpiSlots.filter((_, j) => j !== i) }))}
                >
                  ×
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setValue((v) => ({ ...v, kpiSlots: [...v.kpiSlots, { key: "", label: "" }] }))}
              data-testid="ws-post-slot-add"
            >
              + {t("studio.post.addSlot")}
            </Button>
          </div>
        </div>

        {error ? (
          <p className="text-xs text-destructive" data-testid="ws-post-error">
            {error}
          </p>
        ) : null}

        <div className="flex justify-between gap-2 pt-1">
          {onRemove ? (
            <Button size="sm" variant="ghost" onClick={onRemove} data-testid="ws-post-remove">
              {t("studio.post.remove")}
            </Button>
          ) : (
            <span />
          )}
          <Button size="sm" onClick={commit} data-testid="ws-post-save">
            {t("studio.post.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
