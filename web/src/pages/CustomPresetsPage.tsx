// CustomPresetsPage — the 自建预设 management surface (add-custom-presets,
// design D5): list / create / edit / delete for the cell's user-composed
// persona presets. Creation reuses the ① editor's affordances — persona
// textarea with the per-turn cost readout, and chip-pickers with NO free-form
// name entry: skill chips draw from the locally-available skills (the user's
// own or any installed pack's), server chips from the enabled set. Every
// reference resolves at composition time, so the list marks references that
// currently resolve to nothing (their pack left, the server is gone) and ids
// an operator/cloud source overrides (「被覆盖」 — the role then composes full
// under the overriding persona). There is deliberately no publish, export, or
// share affordance anywhere on this page: a custom preset is cell-local;
// sharing goes through authoring a pack draft.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { PackagePlus, Pencil, Plus, Rocket, TriangleAlert, Trash2 } from "lucide-react";
import { useChatStore } from "@platform/core";
import * as api from "@/lib/presets-api";
import type { CustomPreset, CustomPresetInput } from "@/lib/presets-api";
import { stashBridgeHandoff } from "@/lib/pack-draft-bridge";
import { PresetPublishFlow } from "@/components/packs/PresetPublishFlow";
import { settingsPath } from "@/components/settings/sections";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// One selectable reference chip. `unavailable` marks a REFERENCED name that
// the cell cannot currently resolve — selectable state is meaningless there,
// the chip only explains why it counts zero.
function RefChip({
  name,
  on,
  unavailable,
  onToggle,
}: {
  name: string;
  on: boolean;
  unavailable?: boolean;
  onToggle?: () => void;
}) {
  const { t } = useTranslation();
  if (unavailable) {
    return (
      <span
        data-testid={`preset-ref-unavailable-${name}`}
        title={t("customPresets.unavailable")}
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-destructive/50 px-2 py-0.5 font-mono text-[11px] text-destructive/80 line-through"
      >
        {name}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      data-testid={`preset-ref-chip-${name}`}
      data-on={on ? "true" : undefined}
      className={cn(
        "rounded-full border px-2 py-0.5 font-mono text-[11px] transition-colors",
        on
          ? "border-primary text-primary bg-primary/10"
          : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {on ? "✓ " : "+ "}
      {name}
    </button>
  );
}

function PresetEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: CustomPreset | null;
  onClose: () => void;
  onSaved: (preset: CustomPreset) => void;
}) {
  const { t } = useTranslation();
  const { skills, mcpServers, load } = useExtensionsStore();
  const [name, setName] = useState(initial?.name ?? "");
  const [persona, setPersona] = useState(initial?.persona ?? "");
  const [tags, setTags] = useState((initial?.tags ?? []).join(", "));
  const [pickedSkills, setPickedSkills] = useState<string[]>(initial?.skills ?? []);
  const [pickedMcp, setPickedMcp] = useState<string[]>(initial?.mcpServers ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  // The reference universes: every enabled DB skill (the user's own or any
  // installed pack's — exactly what composition intersects against) and every
  // enabled MCP server. No free-form name entry exists anywhere.
  const availableSkills = useMemo(
    () => skills.filter((s) => s.source === "database" && s.enabled).map((s) => s.name).sort(),
    [skills],
  );
  const availableMcp = useMemo(
    () => mcpServers.filter((s) => s.enabled !== false).map((s) => s.name).sort(),
    [mcpServers],
  );
  // Referenced-but-unresolvable names (edit view only): rendered as inert
  // marked chips so the state is visible without a probe.
  const unavailableSkills = useMemo(
    () => (initial ? initial.skills.filter((n) => !availableSkills.includes(n)) : []),
    [initial, availableSkills],
  );
  const unavailableMcp = useMemo(
    () => (initial ? initial.mcpServers.filter((n) => !availableMcp.includes(n)) : []),
    [initial, availableMcp],
  );

  const toggle = (list: string[], setList: (v: string[]) => void, n: string) =>
    setList(list.includes(n) ? list.filter((x) => x !== n) : [...list, n]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const input: CustomPresetInput = {
      name,
      persona,
      skills: pickedSkills,
      mcpServers: pickedMcp,
      tags: tags.split(",").map((s) => s.trim()).filter(Boolean),
    };
    try {
      const { preset } = initial
        ? await api.updateCustomPreset(initial.id, input)
        : await api.createCustomPreset(input);
      onSaved(preset);
    } catch (e) {
      const err = e as Error & { status?: number };
      setError(err.status === 409 ? t("customPresets.streamBusy") : err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-testid="preset-editor" className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="preset-name">{t("customPresets.name")}</Label>
          <Input
            id="preset-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="preset-name-input"
          />
        </div>
        <div>
          <Label htmlFor="preset-tags">{t("customPresets.tags")}</Label>
          <Input
            id="preset-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t("customPresets.tagsPlaceholder")}
            data-testid="preset-tags-input"
          />
        </div>
      </div>
      <div>
        <Label htmlFor="preset-persona">{t("customPresets.persona")}</Label>
        <Textarea
          id="preset-persona"
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          rows={6}
          placeholder={t("customPresets.personaPlaceholder")}
          data-testid="preset-persona-input"
        />
        {/* The ① editor's cost readout, verbatim semantics: guidance, not a
            cap — a persona bills every turn. */}
        <p className="text-xs text-muted-foreground" data-testid="preset-persona-cost">
          {t("packs.editor.personaCost", { chars: persona.length, tokens: Math.ceil(persona.length / 3) })}
        </p>
      </div>

      <div>
        <Label>{t("customPresets.skills")}</Label>
        <p className="pb-1.5 text-xs text-muted-foreground">{t("customPresets.skillHint")}</p>
        <div className="flex flex-wrap gap-1.5" data-testid="preset-skill-chips">
          {availableSkills.length === 0 && unavailableSkills.length === 0 && (
            <span className="text-xs text-muted-foreground">{t("customPresets.noSkills")}</span>
          )}
          {availableSkills.map((n) => (
            <RefChip
              key={n}
              name={n}
              on={pickedSkills.includes(n)}
              onToggle={() => toggle(pickedSkills, setPickedSkills, n)}
            />
          ))}
          {unavailableSkills.map((n) => (
            <RefChip key={n} name={n} on unavailable />
          ))}
        </div>
      </div>

      <div>
        <Label>{t("customPresets.mcp")}</Label>
        <p className="pb-1.5 text-xs text-muted-foreground">{t("customPresets.mcpHint")}</p>
        <div className="flex flex-wrap gap-1.5" data-testid="preset-mcp-chips">
          {availableMcp.length === 0 && unavailableMcp.length === 0 && (
            <span className="text-xs text-muted-foreground">{t("customPresets.noMcp")}</span>
          )}
          {availableMcp.map((n) => (
            <RefChip
              key={n}
              name={n}
              on={pickedMcp.includes(n)}
              onToggle={() => toggle(pickedMcp, setPickedMcp, n)}
            />
          ))}
          {unavailableMcp.map((n) => (
            <RefChip key={n} name={n} on unavailable />
          ))}
        </div>
      </div>

      {error && (
        <p data-testid="preset-error" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={saving || !name.trim() || !persona.trim()}
          data-testid="preset-save"
        >
          {t("customPresets.save")}
        </Button>
      </div>
    </section>
  );
}

export function CustomPresetsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  // catalog_changed pulses when a mutation lands (ours or another client's) —
  // the roster is deployment-global, so the list refetches with it.
  const catalogVersion = useChatStore((s) => s.catalogVersion);
  const [presets, setPresets] = useState<CustomPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CustomPreset | null>(null);
  const [creating, setCreating] = useState(false);
  const [bridging, setBridging] = useState<string | null>(null);
  // The one-click "发布并部署" flow (add-facet-platform S4.1): compose → confirm
  // → publish → offer deploy, all inside one dialog bound to this preset.
  const [flowPreset, setFlowPreset] = useState<CustomPreset | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { presets: rows } = await api.fetchCustomPresets();
      setPresets(rows);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `catalogVersion` is the deliberate trigger — refetch when the catalog change broadcast bumps it
  useEffect(() => {
    void refresh();
  }, [refresh, catalogVersion]);

  const remove = async (preset: CustomPreset) => {
    if (!window.confirm(t("customPresets.deleteConfirm"))) return;
    try {
      await api.deleteCustomPreset(preset.id);
      await refresh();
    } catch (e) {
      const err = e as Error & { status?: number };
      setError(err.status === 409 ? t("customPresets.streamBusy") : err.message);
    }
  };

  // The one-way bridge into pack authoring (add-preset-to-pack-bridge): the
  // server resolves migratability, we stash the report for the editor to show
  // once, and jump to the packs section with the new draft open. The preset
  // itself is never touched.
  const convert = async (preset: CustomPreset) => {
    setBridging(preset.id);
    setError(null);
    try {
      const { draft, report } = await api.convertPresetToPackDraft(preset.id);
      stashBridgeHandoff(draft.id, report);
      navigate(settingsPath("packs"), { state: location.state });
    } catch (e) {
      const err = e as Error & { status?: number };
      setError(err.status === 403 ? t("customPresets.bridgeDenied") : err.message);
    } finally {
      setBridging(null);
    }
  };

  if (creating || editing) {
    return (
      <div data-testid="custom-presets-page">
        <PresetEditor
          key={editing?.id ?? "new"}
          initial={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            void refresh();
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="custom-presets-page">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t("customPresets.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("customPresets.desc")}</p>
        </div>
        <Button
          size="sm"
          onClick={() => setCreating(true)}
          data-testid="preset-create"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("customPresets.create")}
        </Button>
      </div>

      {error && (
        <p data-testid="custom-presets-error" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {loading && <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}
      {!loading && presets.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="custom-presets-empty">
          {t("customPresets.empty")}
        </p>
      )}

      <div className="grid gap-3">
        {presets.map((p) => {
          const unavailable = [...p.unavailableSkills, ...p.unavailableMcpServers];
          return (
            <div
              key={p.id}
              data-testid={`preset-item-${p.id}`}
              className="rounded-lg border border-border p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{p.name}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{p.id}</span>
                    {p.shadowed && (
                      <span
                        data-testid={`preset-shadowed-${p.id}`}
                        title={t("customPresets.shadowedHint")}
                        className="rounded-sm border border-muted-foreground/40 px-1 py-px text-[10px] text-muted-foreground"
                      >
                        {t("customPresets.shadowed")}
                      </span>
                    )}
                    {unavailable.length > 0 && (
                      <span
                        data-testid={`preset-unavailable-${p.id}`}
                        title={unavailable.join(", ")}
                        className="inline-flex items-center gap-0.5 rounded-sm border border-destructive/40 px-1 py-px text-[10px] text-destructive"
                      >
                        <TriangleAlert className="h-3 w-3" aria-hidden="true" />
                        {t("customPresets.unavailable")} · {unavailable.length}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{p.persona}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {t("customPresets.refs", { skills: p.skills.length, mcp: p.mcpServers.length })}
                    {p.tags.length > 0 ? ` · ${p.tags.join(" · ")}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setFlowPreset(p)}
                    aria-label={t("presetPublish.action")}
                    title={t("presetPublish.action")}
                    data-testid={`preset-publish-${p.id}`}
                  >
                    <Rocket className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void convert(p)}
                    disabled={bridging === p.id}
                    aria-label={t("customPresets.toPackDraft")}
                    title={t("customPresets.toPackDraft")}
                    data-testid={`preset-to-pack-${p.id}`}
                  >
                    <PackagePlus className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(p)}
                    aria-label={t("customPresets.edit")}
                    data-testid={`preset-edit-${p.id}`}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void remove(p)}
                    aria-label={t("customPresets.delete")}
                    data-testid={`preset-delete-${p.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {flowPreset && (
        <PresetPublishFlow
          preset={flowPreset}
          onOpenChange={(open) => {
            if (!open) setFlowPreset(null);
          }}
        />
      )}
    </div>
  );
}
