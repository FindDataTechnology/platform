// PackDraftsView — the creator side (add-pack-marketplace): draft list plus
// the pack editor. Skill entries edit inline (custom-skill conventions); MCP
// entries are PICKED from the cell's registry-sourced market catalog (no
// free-form URL/command field anywhere — the v1 content boundary); agent
// entries are persona-only. Publish pushes the manifest to the gateway and
// stays editable for the next version; the first publish also records the
// pack id on the draft so later publishes append versions.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/lib/packs-api";
import type { PackDraft, PackManifest, PackManifestAgent } from "@/lib/packs-api";
import { takeBridgeHandoff } from "@/lib/pack-draft-bridge";
import type { BridgeReport } from "@/lib/pack-draft-bridge";
import { RhythmEditor } from "./RhythmEditor";
import type { RhythmEntry } from "./RhythmEditor";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "./Badge";

const emptyEntries = { skills: [], mcpServers: [], agents: [] };

// Client-side stable keys for editable list entries (skills/agents may share
// a name or be blank while editing; the key never leaves the editor).
let uid = 0;
const nextKey = () => `e${++uid}`;
const withKeys = <T,>(items: T[]) => items.map((v) => ({ key: nextKey(), value: v }));

export function PackDraftsView({ onPublished }: { onPublished?: () => void }) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<PackDraft[]>([]);
  const [editing, setEditing] = useState<PackDraft | null>(null);
  const [bridgeReport, setBridgeReport] = useState<BridgeReport | null>(null);
  const [openDraftId, setOpenDraftId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setDrafts((await api.listPackDrafts()).drafts);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A preset-conversion handoff (add-preset-to-pack-bridge): open the converted
  // draft directly and surface the migratability report once. The handoff is
  // consumed here — a later plain visit shows no banner.
  useEffect(() => {
    const handoff = takeBridgeHandoff();
    if (handoff) {
      setBridgeReport(handoff.report);
      setOpenDraftId(handoff.draftId);
    }
  }, []);
  // The open lands when the list refresh delivers the converted draft.
  useEffect(() => {
    if (!openDraftId || editing) return;
    const found = drafts.find((d) => d.id === openDraftId);
    if (found) {
      setEditing(found);
      setOpenDraftId(null);
    }
  }, [drafts, openDraftId, editing]);

  const createDraft = async () => {
    try {
      const { draft } = await api.createPackDraft({ name: t("packs.drafts.defaultName"), entries: emptyEntries });
      await refresh();
      setEditing(draft);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (editing) {
    return (
      <PackDraftEditor
        draft={editing}
        bridgeReport={bridgeReport}
        onClose={() => {
          setEditing(null);
          setBridgeReport(null);
          void refresh();
        }}
        onPublished={(d) => {
          setEditing(d);
          onPublished?.();
        }}
      />
    );
  }

  return (
    <section data-testid="pack-drafts-section">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-foreground">{t("packs.drafts.title")}</h2>
        <Button size="sm" onClick={() => void createDraft()} data-testid="pack-draft-create">
          {t("packs.drafts.create")}
        </Button>
      </div>
      {error && <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md mb-4">{error}</div>}
      {loading && <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}
      {!loading && drafts.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("packs.drafts.empty")}</p>
      )}
      <div className="grid gap-3">
        {drafts.map((d) => (
          <button
            key={d.id}
            onClick={() => setEditing(d)}
            data-testid={`pack-draft-item-${d.id}`}
            className="text-left border border-border rounded-lg p-4 hover:border-primary/50 transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-foreground">{d.name}</span>
              {d.publishedPackId ? (
                <Badge>{t("packs.drafts.published")}</Badge>
              ) : (
                <Badge>{t("packs.drafts.draft")}</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t("packs.drafts.partCounts", {
                skills: d.entries.skills?.length ?? 0,
                mcp: d.entries.mcpServers?.length ?? 0,
                agents: d.entries.agents?.length ?? 0,
              })}
            </p>
          </button>
        ))}
      </div>
    </section>
  );
}

function PackDraftEditor({
  draft,
  bridgeReport,
  onClose,
  onPublished,
}: {
  draft: PackDraft;
  bridgeReport?: BridgeReport | null;
  onClose: () => void;
  onPublished: (updated: PackDraft) => void;
}) {
  const { t } = useTranslation();
  const { marketCatalog, refreshMarketCatalog } = useExtensionsStore();
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  // Visibility (add-agent-platform-ops): pack-level exposure, author-picked
  // at publish; remembered across editing sessions.
  const [visibility, setVisibility] = useState<"public" | "private">(
    (draft as { visibility?: "public" | "private" }).visibility === "private" ? "private" : "public",
  );
  const [tags, setTags] = useState(draft.tags.join(", "));
  const [skills, setSkills] = useState(() => withKeys(draft.entries.skills ?? []));
  const [mcpPicked, setMcpPicked] = useState<string[]>((draft.entries.mcpServers ?? []).map((m) => m.registryName));
  const [agents, setAgents] = useState(() => withKeys(draft.entries.agents ?? []));
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<string | null>(null);

  useEffect(() => {
    refreshMarketCatalog();
  }, [refreshMarketCatalog]);

  // The picker lists registry-sourced market entries only (spec:
  // pack-authoring — no free-form endpoint or command entry exists).
  const registryMcp = (marketCatalog?.mcpServers ?? []).filter((s) => s.origin === "registry");

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { draft: updated } = await api.updatePackDraft(draft.id, {
        name,
        description,
        tags: tags.split(",").map((s) => s.trim()).filter(Boolean),
        entries: {
          skills: skills.map((e) => e.value),
          mcpServers: mcpPicked.map((registryName) => ({ registryName })),
          agents: agents.map((e) => e.value),
        },
      });
      Object.assign(draft, updated);
      return updated;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    setPublishing(true);
    setError(null);
    setPublishResult(null);
    try {
      const updated = await save();
      if (!updated) return;
      const manifest: PackManifest = {
        name: updated.name,
        description: updated.description,
        visibility,
        tags: updated.tags,
        skills: updated.entries.skills ?? [],
        mcpServers: updated.entries.mcpServers ?? [],
        agents: updated.entries.agents ?? [],
      };
      const r = await api.publishPack({ packId: draft.publishedPackId, manifest });
      if (!draft.publishedPackId) {
        const { draft: marked } = await api.markDraftPublished(draft.id, r.id);
        Object.assign(draft, marked);
      }
      setPublishResult(t("packs.editor.publishOk", { version: r.version }));
      onPublished({ ...draft, ...updated, publishedPackId: draft.publishedPackId ?? r.id });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPublishing(false);
    }
  };

  return (
    <section data-testid="pack-editor" className="space-y-4">
      {/* Conversion report (add-preset-to-pack-bridge): what came over from the
          preset and what the author must replace — shown once, never stored. */}
      {bridgeReport && (bridgeReport.pendingSkills.length > 0 || bridgeReport.pendingServers.length > 0) && (
        <div
          data-testid="pack-bridge-report"
          className="border border-amber-500/40 bg-amber-500/5 rounded-md p-3 space-y-1"
        >
          <p className="text-xs font-medium text-foreground">
            {t("packs.bridge.title", {
              skills: bridgeReport.inlinedSkills.length,
              servers: bridgeReport.mcpServers.length,
            })}
          </p>
          {bridgeReport.pendingSkills.length > 0 && (
            <ul className="text-xs text-muted-foreground list-disc pl-4">
              {bridgeReport.pendingSkills.map((s) => (
                <li key={`sk-${s.name}`} data-testid={`pack-bridge-pending-skill-${s.name}`}>
                  {s.name} — {s.pack ? t("packs.bridge.reason.pack", { pack: s.pack }) : t("packs.bridge.reason.unavailable")}
                </li>
              ))}
            </ul>
          )}
          {bridgeReport.pendingServers.length > 0 && (
            <ul className="text-xs text-muted-foreground list-disc pl-4">
              {bridgeReport.pendingServers.map((s) => (
                <li key={`mc-${s.name}`} data-testid={`pack-bridge-pending-server-${s.name}`}>
                  {s.name} — {t(`packs.bridge.reason.${s.reason}`)}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">{t("packs.bridge.replaceHint")}</p>
        </div>
      )}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">{t("packs.editor.title")}</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void save()} disabled={saving}>
            {t("packs.editor.save")}
          </Button>
          <Button size="sm" onClick={() => void publish()} disabled={publishing} data-testid="pack-draft-publish">
            {t("packs.editor.publish")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
      </div>

      {error && <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">{error}</div>}
      {publishResult && (
        <div className="bg-primary/10 text-primary px-4 py-3 rounded-md" data-testid="pack-publish-ok">
          {publishResult}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="pack-name">{t("packs.editor.name")}</Label>
          <Input id="pack-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="pack-tags">{t("packs.editor.tags")}</Label>
          <Input
            id="pack-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t("packs.editor.tagsPlaceholder")}
          />
        </div>
      </div>
      <div>
        <Label htmlFor="pack-desc">{t("packs.editor.description")}</Label>
        <Textarea id="pack-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        <div className="flex items-center gap-2 mt-2">
          <Label htmlFor="pack-visibility">{t("packs.editor.visibility")}</Label>
          <select
            id="pack-visibility"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value === "private" ? "private" : "public")}
            className="border border-border rounded px-1.5 py-1 text-xs bg-background"
            data-testid="pack-visibility"
          >
            <option value="public">{t("packs.editor.visibilityPublic")}</option>
            <option value="private">{t("packs.editor.visibilityPrivate")}</option>
          </select>
        </div>
      </div>

      {/* Skills */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-medium text-foreground">{t("packs.editor.skills")}</h3>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSkills([...skills, { key: nextKey(), value: { name: "", description: "", content: "" } }])}
            data-testid="pack-skill-add"
          >
            {t("packs.editor.addSkill")}
          </Button>
        </div>
        <div className="space-y-3">
          {skills.map((entry, i) => (
            <div key={entry.key} className="border border-border rounded-md p-3 space-y-2" data-testid={`pack-skill-entry-${i}`}>
              <div className="grid gap-2 md:grid-cols-2">
                <Input
                  value={entry.value.name}
                  onChange={(e) => setSkills(skills.map((x, j) => (j === i ? { ...x, value: { ...x.value, name: e.target.value } } : x)))}
                  placeholder={t("packs.editor.skillName")}
                />
                <Input
                  value={entry.value.description}
                  onChange={(e) => setSkills(skills.map((x, j) => (j === i ? { ...x, value: { ...x.value, description: e.target.value } } : x)))}
                  placeholder={t("packs.editor.skillDescription")}
                />
              </div>
              <Textarea
                value={entry.value.content}
                onChange={(e) => setSkills(skills.map((x, j) => (j === i ? { ...x, value: { ...x.value, content: e.target.value } } : x)))}
                rows={6}
                placeholder={t("packs.editor.skillContent")}
                className="font-mono text-xs"
              />
              <Button size="sm" variant="ghost" onClick={() => setSkills(skills.filter((_, j) => j !== i))}>
                {t("packs.editor.remove")}
              </Button>
            </div>
          ))}
        </div>
      </section>

      {/* MCP picker */}
      <section>
        <h3 className="font-medium text-foreground mb-2">{t("packs.editor.mcp")}</h3>
        <p className="text-xs text-muted-foreground mb-2">{t("packs.editor.mcpHint")}</p>
        {registryMcp.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("packs.editor.mcpEmpty")}</p>
        ) : (
          <div className="flex flex-wrap gap-2" data-testid="pack-mcp-picker">
            {registryMcp.map((s) => {
              const on = mcpPicked.includes(s.name);
              return (
                <button
                  key={s.name}
                  onClick={() => setMcpPicked(on ? mcpPicked.filter((n) => n !== s.name) : [...mcpPicked, s.name])}
                  className={`border rounded-full px-3 py-1 text-xs transition-colors ${
                    on ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground"
                  }`}
                  data-testid={`pack-mcp-option-${s.name}`}
                >
                  {s.displayName || s.name}
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Agents (persona-only) */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-medium text-foreground">{t("packs.editor.agents")}</h3>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAgents([...agents, { key: nextKey(), value: { id: "", name: "", persona: "" } }])}
            data-testid="pack-agent-add"
          >
            {t("packs.editor.addAgent")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mb-2">{t("packs.editor.agentHint")}</p>
        <div className="space-y-3">
          {agents.map((entry, i) => (
            <div key={entry.key} className="border border-border rounded-md p-3 space-y-2" data-testid={`pack-agent-entry-${i}`}>
              <div className="grid gap-2 md:grid-cols-2">
                <Input
                  value={entry.value.id}
                  onChange={(e) => setAgents(agents.map((x, j) => (j === i ? { ...x, value: { ...x.value, id: e.target.value } } : x)))}
                  placeholder={t("packs.editor.agentId")}
                />
                <Input
                  value={entry.value.name}
                  onChange={(e) => setAgents(agents.map((x, j) => (j === i ? { ...x, value: { ...x.value, name: e.target.value } } : x)))}
                  placeholder={t("packs.editor.agentName")}
                />
              </div>
              <Textarea
                value={entry.value.persona}
                onChange={(e) => setAgents(agents.map((x, j) => (j === i ? { ...x, value: { ...x.value, persona: e.target.value } } : x)))}
                rows={3}
                placeholder={t("packs.editor.agentPersona")}
              />
              {/* Persona cost readout (D6): guidance, not a cap — a persona
                  bills every turn, so its size is a per-turn cost decision. */}
              <p className="text-xs text-muted-foreground" data-testid={`pack-agent-cost-${i}`}>
                {t("packs.editor.personaCost", {
                  chars: entry.value.persona.length,
                  tokens: Math.ceil(entry.value.persona.length / 3),
                })}
              </p>
              {/* Serving contract (add-a2a-agent-serving): declaring the role
                  deployable as an Agent Service. The contract carries no
                  configuration (model/credentials are deployment concerns);
                  absent card fields derive from name/description/tags at
                  deploy time. */}
              <label className="flex items-start gap-2 text-xs" data-testid={`pack-agent-serving-toggle-${i}`}>
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={!!entry.value.serving}
                  onChange={(e) =>
                    setAgents(
                      agents.map((x, j) =>
                        j === i
                          ? {
                              ...x,
                              value: {
                                ...x.value,
                                ...(e.target.checked
                                  ? { serving: { protocol: "a2a" } }
                                  : { serving: undefined }),
                              },
                            }
                          : x,
                      ),
                    )
                  }
                />
                <span>
                  {t("packs.editor.agentServing")}
                  <span className="block text-muted-foreground">{t("packs.editor.agentServingHint")}</span>
                </span>
              </label>
              {entry.value.serving && (
                <div className="border border-border rounded-md p-2 space-y-1.5" data-testid={`pack-agent-rhythm-${i}`}>
                  <p className="text-xs font-medium">{t("packs.rhythm.title")}</p>
                  <RhythmEditor
                    value={(entry.value.serving.rhythm ?? []) as RhythmEntry[]}
                    onChange={(rhythm) =>
                      setAgents(
                        agents.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                value: {
                                  ...x.value,
                                  serving: { ...x.value.serving!, rhythm: rhythm.length > 0 ? rhythm : undefined },
                                },
                              }
                            : x,
                        ),
                      )
                    }
                    testIdPrefix={`pack-agent-rhythm-editor-${i}`}
                  />
                </div>
              )}
              <AgentResourcesPicker
                index={i}
                value={entry.value}
                ownSkillNames={skills.map((s) => s.value.name.trim()).filter(Boolean)}
                ownMcpNames={mcpPicked}
                onChange={(resources) =>
                  setAgents(agents.map((x, j) => (j === i ? { ...x, value: { ...x.value, resources } } : x)))
                }
              />
              <Button size="sm" variant="ghost" onClick={() => setAgents(agents.filter((_, j) => j !== i))}>
                {t("packs.editor.remove")}
              </Button>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}

// Per-role resource declaration picker (add-persona-resource-sets D6). Chip
// sources are the draft's OWN entries only — no free-form name input exists,
// so a declaration can never name a foreign resource (the server re-validates
// anyway). Dimension semantics mirror the manifest: a dimension left
// UNCHECKED is absent (= the role uses the whole pack's set for it); checked,
// the chip selection is the set (none checked = none). Enabling a dimension
// pre-selects everything — the equivalent of today's whole-pack behavior —
// and dropping both dimensions removes `resources` entirely (undeclared).
function AgentResourcesPicker({
  index,
  value,
  ownSkillNames,
  ownMcpNames,
  onChange,
}: {
  index: number;
  value: PackManifestAgent;
  ownSkillNames: string[];
  ownMcpNames: string[];
  onChange: (resources: PackManifestAgent["resources"]) => void;
}) {
  const { t } = useTranslation();
  const resources = value.resources;
  const skillsOn = Array.isArray(resources?.skills);
  const mcpOn = Array.isArray(resources?.mcpServers);
  // Auto-expand once a declaration exists, but let the author collapse it —
  // `open` must survive unrelated re-renders (typing in the persona textarea
  // re-renders this entry on every keystroke).
  const [open, setOpen] = useState(skillsOn || mcpOn);

  const setDimension = (dim: "skills" | "mcpServers", on: boolean, all: string[]) => {
    let next: PackManifestAgent["resources"] = { ...resources };
    if (on) next[dim] = [...all];
    else delete next[dim];
    if (!next.skills && !next.mcpServers) next = undefined;
    onChange(next);
  };
  const toggleChip = (dim: "skills" | "mcpServers", name: string) => {
    const current = resources?.[dim] ?? [];
    onChange({
      ...resources,
      [dim]: current.includes(name) ? current.filter((n) => n !== name) : [...current, name],
    });
  };

  const chips = (dim: "skills" | "mcpServers", names: string[]) =>
    names.length === 0 ? (
      <p className="text-xs text-muted-foreground" data-testid={`pack-agent-resource-empty-${dim}`}>
        {t(dim === "skills" ? "packs.editor.resourceEmptySkills" : "packs.editor.resourceEmptyMcp")}
      </p>
    ) : (
      <div className="flex flex-wrap gap-1.5" data-testid={`pack-agent-resource-chips-${index}-${dim}`}>
        {names.map((name) => {
          const on = (resources?.[dim] ?? []).includes(name);
          return (
            <button
              key={name}
              type="button"
              onClick={() => toggleChip(dim, name)}
              className={`border rounded-full px-2 py-0.5 text-xs transition-colors ${
                on ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground"
              }`}
              data-testid={`pack-agent-resource-chip-${name}`}
            >
              {name}
            </button>
          );
        })}
      </div>
    );

  return (
    <details
      className="border border-border rounded-md px-3 py-2"
      data-testid={`pack-agent-resources-${index}`}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm text-muted-foreground select-none">
        {t("packs.editor.resourceSet")}
      </summary>
      <p className="text-xs text-muted-foreground mt-1 mb-2">{t("packs.editor.resourceHint")}</p>
      <div className="space-y-2">
        <div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={skillsOn}
              onChange={(e) => setDimension("skills", e.target.checked, ownSkillNames)}
              data-testid={`pack-agent-resource-toggle-skills-${index}`}
            />
            {t("packs.editor.limitSkills")}
          </label>
          {skillsOn && chips("skills", ownSkillNames)}
        </div>
        <div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={mcpOn}
              onChange={(e) => setDimension("mcpServers", e.target.checked, ownMcpNames)}
              data-testid={`pack-agent-resource-toggle-mcp-${index}`}
            />
            {t("packs.editor.limitMcp")}
          </label>
          {mcpOn && chips("mcpServers", ownMcpNames)}
        </div>
      </div>
    </details>
  );
}
