// AgentBucketsEditor — the three-bucket editing card, shared by BOTH hosts of
// the studio (add-agent-studio canvas and the blueprint team mode,
// fold-blueprint-into-studio D1): one editor, two hosts — the fold must not
// fork the bucket UX. Persona editing is per selected agent; skills and MCP
// are document-level buckets. MCP references come from the catalog picker
// only (no free-form registryName entry anywhere).
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { PackManifestAgent, PackManifestMcp, PackManifestSkill } from "@/lib/packs-api";
import { cn } from "@/lib/utils";

export interface BucketsValue {
  agents: PackManifestAgent[];
  skills?: PackManifestSkill[];
  mcpServers: PackManifestMcp[];
}

interface CatalogServer {
  name: string;
  /** Catalog snapshot; null = unknown (the picker only needs names). */
  toolList?: string[] | null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function SectionCard({ title, children, testid }: { title: string; children: React.ReactNode; testid: string }) {
  return (
    <div className="rounded-md border border-border p-3" data-testid={testid}>
      <h4 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

export function AgentBucketsEditor({
  value,
  showSkills = true,
  localSkills = [],
  catalogServers = [],
  onChange,
  testIdPrefix = "studio-bucket",
  selectedAgentId,
  onSelectAgent,
}: {
  value: BucketsValue;
  showSkills?: boolean;
  localSkills?: { name: string; description?: string }[];
  catalogServers?: CatalogServer[];
  onChange: (next: BucketsValue) => void;
  testIdPrefix?: string;
  // Controlled selection (add-agent-builder-workspace 1.4): the page owns the
  // selected agent so the inspector can follow it; hosts that pass nothing
  // keep the editor's internal selection (backward compatible).
  selectedAgentId?: string | null;
  onSelectAgent?: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const { agents, skills = [], mcpServers } = value;
  const [innerId, setInnerId] = useState<string | null>(agents[0]?.id ?? null);
  const controlled = selectedAgentId !== undefined;
  const selectedId = controlled ? selectedAgentId : innerId;
  const select = useCallback(
    (id: string | null) => {
      if (controlled) onSelectAgent?.(id);
      else setInnerId(id);
    },
    [controlled, onSelectAgent],
  );
  const seq = { current: 0 };

  useEffect(() => {
    if (selectedId && !agents.some((a) => a.id === selectedId)) select(agents[0]?.id ?? null);
  }, [agents, selectedId, select]);
  const selected = agents.find((a) => a.id === selectedId) ?? null;

  const setAgents = (next: PackManifestAgent[]) => onChange({ ...value, agents: next });
  const setSkills = (next: PackManifestSkill[]) => onChange({ ...value, skills: next });
  const setMcp = (next: PackManifestMcp[]) => onChange({ ...value, mcpServers: next });

  return (
    <div className="space-y-3">
      {/* ── Bucket 1 · persona (per selected agent) ── */}
      <SectionCard title={t("packs.detail.agents")} testid={`${testIdPrefix}-persona`}>
        {agents.length > 0 ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
              {agents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  data-testid={`${testIdPrefix}-agent-chip-${a.id}`}
                  onClick={() => select(a.id)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[11px]",
                    selectedId === a.id ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted",
                  )}
                >
                  {a.name || a.id}
                </button>
              ))}
              <button
                type="button"
                data-testid={`${testIdPrefix}-agent-add`}
                onClick={() => {
                  const id = `agent-${agents.length + 1}-${++seq.current}`;
                  setAgents([...agents, { id, name: "", persona: "" }]);
                  select(id);
                }}
                className="rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
              >
                + {t("studio.roster.new")}
              </button>
            </div>
            {selected && (
              <div className="space-y-2" data-anchor={`agents[${agents.findIndex((a) => a.id === selected.id)}]`}>
                <div className="flex gap-2">
                  <Field label={t("studio.agent.id")}>
                    <Input value={selected.id} disabled className="w-40 font-mono text-xs" data-testid={`${testIdPrefix}-agent-id`} />
                  </Field>
                  <Field label={t("studio.agent.name")}>
                    <Input
                      value={selected.name}
                      onChange={(e) => setAgents(agents.map((a) => (a.id === selected.id ? { ...a, name: e.target.value } : a)))}
                      data-testid={`${testIdPrefix}-agent-name`}
                    />
                  </Field>
                </div>
                <Textarea
                  rows={6}
                  value={selected.persona}
                  onChange={(e) => setAgents(agents.map((a) => (a.id === selected.id ? { ...a, persona: e.target.value } : a)))}
                  data-testid={`${testIdPrefix}-agent-persona`}
                />
                {agents.length > 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid={`${testIdPrefix}-agent-remove`}
                    onClick={() => setAgents(agents.filter((a) => a.id !== selected.id))}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> {t("studio.remove")}
                  </Button>
                )}
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            data-testid={`${testIdPrefix}-agent-add`}
            onClick={() => {
              const id = `agent-${agents.length + 1}-${++seq.current}`;
              setAgents([{ id, name: "", persona: "" }]);
              select(id);
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            + {t("studio.roster.new")}
          </button>
        )}
      </SectionCard>

      {/* ── Bucket 2 · skills (document-level; blueprints carry none) ── */}
      {showSkills && (
        <SectionCard title={t("packs.detail.skills")} testid={`${testIdPrefix}-skills`}>
          <div className="space-y-2">
            {skills.map((s, i) => (
              <div key={s.name} className="rounded-md border border-border p-2" data-testid={`${testIdPrefix}-skill-${s.name}`} data-anchor={`skills[${i}]`}>
                <div className="flex items-center gap-2">
                  <Input
                    value={s.name}
                    onChange={(e) => setSkills(skills.map((x) => (x.name === s.name ? { ...x, name: e.target.value } : x)))}
                    className="font-mono text-xs"
                    data-testid={`${testIdPrefix}-skill-name-${s.name}`}
                  />
                  <Button size="icon" variant="ghost" onClick={() => setSkills(skills.filter((x) => x.name !== s.name))} aria-label={t("studio.remove")}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <Input
                  value={s.description}
                  placeholder={t("studio.skill.description")}
                  onChange={(e) => setSkills(skills.map((x) => (x.name === s.name ? { ...x, description: e.target.value } : x)))}
                  className="mt-1 text-xs"
                />
                <Textarea
                  rows={4}
                  value={s.content}
                  placeholder={t("studio.skill.content")}
                  onChange={(e) => setSkills(skills.map((x) => (x.name === s.name ? { ...x, content: e.target.value } : x)))}
                  className="mt-1 font-mono text-xs"
                />
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                value=""
                onChange={(e) => {
                  const name = e.target.value;
                  const src = localSkills.find((x) => x.name === name);
                  if (!src || skills.some((x) => x.name === name)) return;
                  setSkills([...skills, { name: src.name, description: src.description ?? "", content: "" }]);
                }}
                data-testid={`${testIdPrefix}-skill-import`}
              >
                <option value="">{t("studio.skill.importLocal")}</option>
                {localSkills.filter((s) => !skills.some((x) => x.name === s.name)).map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                data-testid={`${testIdPrefix}-skill-add`}
                onClick={() => setSkills([...skills, { name: `skill-${Date.now().toString(36)}`, description: "", content: "" }])}
              >
                <Plus className="h-3.5 w-3.5" /> {t("studio.skill.inline")}
              </Button>
            </div>
          </div>
        </SectionCard>
      )}

      {/* ── Bucket 3 · tools (registry picker only) ── */}
      <SectionCard title={t("packs.detail.mcp")} testid={`${testIdPrefix}-mcp`}>
        <div className="space-y-2">
          {mcpServers.map((m, i) => (
            <div key={m.registryName} className="rounded-md border border-border p-2" data-testid={`${testIdPrefix}-mcp-${m.registryName}`} data-anchor={`mcpServers[${i}]`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs">{m.registryName}</span>
                <Button size="icon" variant="ghost" onClick={() => setMcp(mcpServers.filter((x) => x.registryName !== m.registryName))} aria-label={t("studio.remove")}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              {(() => {
                const tools = catalogServers.find((s) => s.name === m.registryName)?.toolList ?? [];
                if (tools.length === 0) return null;
                return (
                  <div className="mt-1 flex flex-wrap gap-1" data-testid={`${testIdPrefix}-mcp-tools-${m.registryName}`}>
                    {tools.map((tool: string) => {
                      const on = m.allowTools?.includes(tool) ?? false;
                      return (
                        <button
                          key={tool}
                          type="button"
                          data-testid={`${testIdPrefix}-mcp-tool-${m.registryName}-${tool}`}
                          onClick={() => {
                            const next = on ? (m.allowTools ?? []).filter((x) => x !== tool) : [...(m.allowTools ?? []), tool];
                            setMcp(mcpServers.map((x) => (x.registryName === m.registryName ? { ...x, allowTools: next.length ? next : undefined } : x)));
                          }}
                          className={cn(
                            "rounded-full border px-2 py-0.5 font-mono text-[11px]",
                            on ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted",
                          )}
                        >
                          {on ? "✓ " : "+ "}
                          {tool}
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          ))}
          <select
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
            value=""
            onChange={(e) => {
              const name = e.target.value;
              if (name && !mcpServers.some((x) => x.registryName === name)) setMcp([...mcpServers, { registryName: name }]);
            }}
            data-testid={`${testIdPrefix}-mcp-add`}
          >
            <option value="">{t("studio.mcp.pick")}</option>
            {catalogServers.filter((s) => !mcpServers.some((x) => x.registryName === s.name)).map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </SectionCard>
    </div>
  );
}

export function useTotalTools(catalogServers: CatalogServer[]) {
  return (registryName: string) => catalogServers.find((s) => s.name === registryName)?.toolList?.length ?? null;
}
