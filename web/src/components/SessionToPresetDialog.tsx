// SessionToPresetDialog — the "save this session as my solution" wizard
// (add-session-to-preset, Y4 创作闭环第一刀). Non-technical users tune their
// assistant INSIDE a conversation; this is the extraction on-ramp the closed
// loop was missing. Everything downstream (preset container → publish flow →
// marketplace) already exists — the wizard only fills the funnel's mouth:
//
//   prefill   — name from the session title; persona from the session's
//               starting preset (SessionMeta.agentPreset → /api/catalog
//               carries persona for pack and user sources alike); the
//               skills/mcp snapshot rides along when that preset is a custom
//               one (its reference list is fetchable) — a builtin preset's
//               composition is server-side, so the wizard leaves the lists
//               empty rather than guessing.
//   examples  — the honest expression of a good setup is the user's own real
//               questions: pick up to 3 user messages (default: first 3).
//   save      — the existing custom-preset POST; success points at the
//               publish flow (the preset's row in 我的专家 carries it).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { getChatSession } from "@platform/core";
import * as presetsApi from "@/lib/presets-api";
import type { CustomPreset } from "@/lib/presets-api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

const MAX_EXAMPLES = 3;
const MAX_EXAMPLE_CHARS = 200;

interface CatalogAgent {
  id: string;
  persona?: string;
}

interface Props {
  sessionId: string | null;
  agentPreset?: string | null;
  onOpenChange: (open: boolean) => void;
}

type Mode = "create" | "update";

export function SessionToPresetDialog({ sessionId, agentPreset, onOpenChange }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [userMsgs, setUserMsgs] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<CustomPreset | null>(null);
  // Iterate mode (add-solution-iterate): write this session's tuning back
  // into an existing solution instead of minting a new one. The target list
  // is the user's own custom presets; the composition boundary (skills/MCP
  // stay the target's own) is stated in the UI, not implied.
  const [mode, setMode] = useState<Mode>("create");
  const [myPresets, setMyPresets] = useState<CustomPreset[]>([]);
  const [targetId, setTargetId] = useState<string>("");

  const open = Boolean(sessionId);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    setSaved(null);
    setUserMsgs([]);
    setPicked([]);
    setPersona("");
    setSkills([]);
    setMcpServers([]);
    setMode("create");
    setTargetId("");
    try {
      // The conversation itself: title + the user's real questions.
      const session = await getChatSession(sessionId);
      setName(session.title || t("sessionSolution.defaultName"));
      const msgs = session.messages.filter((m) => m.role === "user").map((m) => String(m.content ?? "").trim()).filter(Boolean);
      setUserMsgs(msgs);
      setPicked(msgs.slice(0, MAX_EXAMPLES).map((_, i) => i));
      // The persona the session started under. /api/catalog carries persona
      // for pack-sourced and user-sourced entries alike.
      if (agentPreset) {
        try {
          const r = await fetch("/api/catalog");
          if (r.ok) {
            const c = await r.json();
            const entry: CatalogAgent | undefined = (c.agents ?? []).find((a: CatalogAgent) => a.id === agentPreset);
            setPersona(entry?.persona ?? "");
          }
        } catch {
          // No persona prefill — the user writes their own, the wizard still works.
        }
      }
      // The user's own presets: the iterate target list, and (when the
      // session started under one of them) the reference snapshot.
      try {
        const cp = await presetsApi.fetchCustomPresets();
        setMyPresets(cp.presets);
        if (agentPreset) {
          const row = cp.presets.find((p) => p.id === agentPreset);
          if (row) {
            setSkills(row.skills ?? []);
            setMcpServers(row.mcpServers ?? []);
          }
        }
      } catch {
        // iterate list is best-effort; create mode still works without it
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sessionId, agentPreset, t]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const toggle = (i: number) => {
    setPicked((prev) => {
      if (prev.includes(i)) return prev.filter((x) => x !== i);
      if (prev.length >= MAX_EXAMPLES) return prev;
      return [...prev, i];
    });
  };

  const examples = picked
    .flatMap((i) => (userMsgs[i] === undefined ? [] : [userMsgs[i]]))
    .filter((s) => s.length <= MAX_EXAMPLE_CHARS);

  const save = async () => {
    if (mode === "update" && !targetId) {
      setError(t("sessionSolution.needTarget"));
      return;
    }
    if (!persona.trim() || (mode === "create" && !name.trim())) {
      setError(t("sessionSolution.needNamePersona"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (mode === "update") {
        // Partial PUT: this session's tuning (persona + picked examples)
        // overwrites the target; the composition (skills/mcp) is the
        // solution's own asset and is not sent at all.
        const r = await presetsApi.updateCustomPreset(targetId, {
          persona,
          ...(examples.length > 0 ? { examples } : {}),
        });
        setSaved(r.preset);
      } else {
        const r = await presetsApi.createCustomPreset({
          name: name.trim(),
          persona,
          skills,
          mcpServers,
          examples: examples.length > 0 ? examples : undefined,
        });
        setSaved(r.preset);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="session-solution-dialog" className="sm:max-w-lg">
        {/* No inner max-h/overflow here: the dialog's own content container
            already scrolls (single scroll container — nested ones break
            scrollIntoView for elements near the edges). */}
        <DialogHeader>
          <DialogTitle>{t("sessionSolution.title")}</DialogTitle>
          <DialogDescription>{t("sessionSolution.subtitle")}</DialogDescription>
        </DialogHeader>

        {saved ? (
          <div className="flex flex-col gap-3" data-testid="session-solution-saved">
            <p className="text-sm text-muted-foreground">
              {mode === "update"
                ? t("sessionSolution.updatedAs", { name: saved.name })
                : t("sessionSolution.savedAs", { name: saved.name })}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {t("common.close")}
              </Button>
              <Button
                size="sm"
                data-testid="session-solution-go-publish"
                onClick={() => {
                  onOpenChange(false);
                  navigate("/agents");
                }}
              >
                {t("sessionSolution.goPublish")}
              </Button>
            </div>
          </div>
        ) : loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Mode switch (add-solution-iterate): mint a new solution from
                this session, or write the tuning back into an existing one. */}
            <div className="flex gap-2" data-testid="session-solution-mode">
              <button
                type="button"
                data-testid="session-solution-mode-create"
                onClick={() => setMode("create")}
                className={`rounded-md border px-3 py-1 text-xs ${mode === "create" ? "border-primary bg-primary-deep text-primary-foreground" : "border-border text-muted-foreground hover:bg-muted"}`}
              >
                {t("sessionSolution.modeCreate")}
              </button>
              <button
                type="button"
                data-testid="session-solution-mode-update"
                onClick={() => setMode("update")}
                disabled={myPresets.length === 0}
                title={myPresets.length === 0 ? t("sessionSolution.noTargets") : undefined}
                className={`rounded-md border px-3 py-1 text-xs ${mode === "update" ? "border-primary bg-primary-deep text-primary-foreground" : "border-border text-muted-foreground hover:bg-muted"} disabled:opacity-50`}
              >
                {t("sessionSolution.modeUpdate")}
              </button>
            </div>

            {mode === "update" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ss-target">{t("sessionSolution.targetLabel")}</Label>
                <select
                  id="ss-target"
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                  data-testid="session-solution-target"
                  className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                >
                  <option value="">{t("sessionSolution.targetPlaceholder")}</option>
                  {myPresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground" data-testid="session-solution-boundary">
                  {t("sessionSolution.boundary")}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ss-name">{t("sessionSolution.nameLabel")}</Label>
                <Input id="ss-name" value={name} onChange={(e) => setName(e.target.value)} data-testid="session-solution-name" />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ss-persona">{t("sessionSolution.personaLabel")}</Label>
              <Textarea
                id="ss-persona"
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
                rows={6}
                placeholder={t("sessionSolution.personaPlaceholder")}
                data-testid="session-solution-persona"
              />
            </div>
            {userMsgs.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Label>{t("sessionSolution.examplesLabel", { max: MAX_EXAMPLES })}</Label>
                <div className="flex max-h-44 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2" data-testid="session-solution-examples">
                  {userMsgs.map((m, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the message list is an immutable snapshot fetched for this dialog
                    <label key={i} className="flex items-start gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
                      <input
                        type="checkbox"
                        checked={picked.includes(i)}
                        onChange={() => toggle(i)}
                        disabled={!picked.includes(i) && picked.length >= MAX_EXAMPLES}
                        data-testid={`session-solution-example-${i}`}
                        className="mt-1"
                      />
                      <span className={m.length > MAX_EXAMPLE_CHARS ? "text-muted-foreground line-clamp-2" : "line-clamp-2"}>
                        {m.length > MAX_EXAMPLE_CHARS ? t("sessionSolution.tooLong") : m}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {error ? (
              <p className="text-sm text-red-600" data-testid="session-solution-error">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={saving} data-testid="session-solution-save">
                {saving ? t("common.saving") : t("sessionSolution.save")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
