// PackPillarsEditor — author-side editing for the three pillars
// (openspec: pillar-surfaces 6.2).
//
// Why this exists: the declarations were always legal in a manifest, but the
// editor had no field for them AND the compiler dropped them, so an author
// could not write one and — worse — an author who imported one lost it on the
// first save. The compile/import halves are fixed (task 6.1); this is the
// writing half.
//
// Two rules the form follows:
//   · Empty means ABSENT. Clearing every field removes the key entirely rather
//     than writing `{store:{home:""}}`; the validator would refuse that shape,
//     and a half-filled axis is not a declaration.
//   · The form never invents a value. Every select has an explicit「不声明」
//     option, because "I have not decided" and "I decided the default" are
//     different facts and the second one must be authored deliberately.
//
// The per-block console editor is a picker over the registered block ids —
// the same registry the server validates against (`lib/console-blocks-spec.js`).
// A free-text block id would let an author produce a manifest that only fails
// at publish.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentSpecSheet, type SpecPillars } from "@/components/packs/AgentSpecSheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import * as api from "@/lib/packs-api";
import type { PackManifest } from "@/lib/packs-api";

/** The six registered console blocks. Mirrors `CONSOLE_BLOCK_IDS` in
 *  paas/lib/console-blocks-spec.js — a seventh block has to be added in both
 *  places, and the publish validator is what catches a miss. */
const CONSOLE_BLOCKS = ["team", "stream", "kpi", "decisions", "spend", "orchestration"] as const;

const STORE_HOMES = ["fleet", "member", "person"] as const;
const READ_SCOPES = ["own+shared", "shared", "off"] as const;
const WRITE_AUTHORITIES = ["private", "shared"] as const;
const DISTILL_VALUES = ["on", "off", "inherit"] as const;

const UNDECLARED = "";

type Memory = NonNullable<PackManifest["memory"]>;

function PillarCard({ title, hint, children, testId }: {
  title: string;
  hint: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div className="rounded-md border border-border p-3 space-y-2" data-testid={testId}>
      <h4 className="text-sm font-medium text-foreground">{title}</h4>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {children}
    </div>
  );
}

/** A select that can express "not declared" — the option list is closed and
 *  the empty value means absent, never a default. */
function EnumField<T extends string>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: T | undefined;
  options: readonly T[];
  onChange: (v: T | undefined) => void;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <Label htmlFor={testId} className="text-xs">{label}</Label>
      <select
        id={testId}
        value={value ?? UNDECLARED}
        onChange={(e) => onChange((e.target.value || undefined) as T | undefined)}
        className="w-full rounded border border-border bg-background px-1.5 py-1 text-xs"
        data-testid={testId}
      >
        <option value={UNDECLARED}>{t("packs.editor.pillars.undeclared")}</option>
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  );
}

export function PackPillarsEditor({
  agents,
  onGuidance,
  memory,
  onMemory,
  consoleDecl,
  onConsole,
  previewManifest,
}: {
  /** The draft's agent entries — the charter is an AGENT-level field
   *  (`agents[].memory.guidance`), never pack-level: a pack-level charter has
   *  no consumer, so accepting one here would turn a declaration into
   *  decoration. */
  agents: { id?: string; memory?: { guidance?: string } }[];
  onGuidance: (agentId: string, text: string) => void;
  memory: Memory;
  onMemory: (next: Memory) => void;
  consoleDecl: PackManifest["console"] | undefined;
  onConsole: (next: PackManifest["console"] | undefined) => void;
  /** The manifest as it would be published, for the server-side preview.
   *  Debounced by the caller; errors simply leave the previous preview up. */
  previewManifest: PackManifest | null;
}) {
  const { t } = useTranslation();

  // Pruning helper: setting a leaf to `undefined` and then dropping empty axis
  // objects keeps the stored block equal to what was actually authored.
  const patchAxis = (axis: keyof Memory, key: string, value: unknown) => {
    const next: Memory = { ...memory, [axis]: { ...(memory[axis] as Record<string, unknown> | undefined) } };
    const segment = next[axis] as Record<string, unknown>;
    if (value === undefined || value === "") delete segment[key];
    else segment[key] = value;
    if (Object.keys(segment).length === 0) delete (next as Record<string, unknown>)[axis];
    onMemory(next);
  };

  const agentIds = agents.map((a) => a.id ?? "").filter(Boolean);
  // Server-side preview (pillar-surfaces 6.3). The derivation is NOT run here:
  // a second interpreter in the browser is exactly the drift this change
  // exists to remove. A failed request keeps the last good preview — the
  // author is typing, not publishing.
  const [preview, setPreview] = useState<SpecPillars | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  useEffect(() => {
    if (!previewManifest) return;
    let live = true;
    const timer = setTimeout(() => {
      api
        .previewPackPillars(previewManifest)
        .then((r) => {
          if (!live) return;
          setPreview(r.pillars);
          setPreviewErr(null);
        })
        .catch((e) => live && setPreviewErr(String(e?.message ?? e)));
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [previewManifest]);
  const blocks = consoleDecl?.blocks ?? [];
  const toggleBlock = (id: string) => {
    const has = blocks.some((b) => b.block === id);
    const nextBlocks = has ? blocks.filter((b) => b.block !== id) : [...blocks, { block: id }];
    if (nextBlocks.length === 0) {
      onConsole(undefined);
      return;
    }
    onConsole({ ...(consoleDecl ?? {}), blocks: nextBlocks });
  };

  return (
    <section className="space-y-3" data-testid="pack-pillars-editor">
      <h3 className="font-medium text-foreground">{t("packs.editor.pillars.title")}</h3>
      <p className="text-xs text-muted-foreground">{t("packs.editor.pillars.hint")}</p>

      <PillarCard title={t("packs.specSheet.memoryTitle")} hint={t("packs.editor.pillars.memoryHint")} testId="pack-pillars-memory">
        <div className="grid gap-2 md:grid-cols-3">
          <EnumField
            label={t("packs.editor.pillars.storeHome")}
            value={memory.store?.home}
            options={STORE_HOMES}
            onChange={(v) => patchAxis("store", "home", v)}
            testId="pack-pillars-memory-store-home"
          />
          <EnumField
            label={t("packs.editor.pillars.readScope")}
            value={memory.read?.scope}
            options={READ_SCOPES}
            onChange={(v) => patchAxis("read", "scope", v)}
            testId="pack-pillars-memory-read-scope"
          />
          <EnumField
            label={t("packs.editor.pillars.writeAuthority")}
            value={memory.write?.authority}
            options={WRITE_AUTHORITIES}
            onChange={(v) => patchAxis("write", "authority", v)}
            testId="pack-pillars-memory-write-authority"
          />
          <EnumField
            label={t("packs.editor.pillars.distill")}
            value={memory.process?.distill}
            options={DISTILL_VALUES}
            onChange={(v) => patchAxis("process", "distill", v)}
            testId="pack-pillars-memory-distill"
          />
          <div className="space-y-1">
            <Label htmlFor="pack-pillars-memory-budget" className="text-xs">{t("packs.editor.pillars.readBudget")}</Label>
            <Input
              id="pack-pillars-memory-budget"
              inputMode="numeric"
              value={memory.read?.budget ?? ""}
              onChange={(e) => {
                const raw = e.target.value.trim();
                patchAxis("read", "budget", raw === "" ? undefined : Number(raw));
              }}
              placeholder="64–2000"
              data-testid="pack-pillars-memory-read-budget"
            />
          </div>
        </div>

        {/* Per-role charter. Only roles the draft declares — a charter for a
            role that does not exist is a declaration nothing can consume. */}
        {agentIds.length > 0 && (
          <div className="space-y-2 border-t border-border pt-2" data-testid="pack-pillars-guidance">
            <p className="text-xs font-medium text-muted-foreground">{t("packs.editor.pillars.guidanceTitle")}</p>
            {agentIds.map((id) => {
              const current = agents.find((a) => a.id === id)?.memory?.guidance ?? "";

              return (
                <div key={id} className="space-y-1" data-testid={`pack-pillars-guidance-${id}`}>
                  <Label htmlFor={`pack-pillars-guidance-${id}`} className="font-mono text-[11px] text-muted-foreground">{id}</Label>
                  <Textarea
                    id={`pack-pillars-guidance-${id}`}
                    rows={2}
                    maxLength={600}
                    value={current}
                    onChange={(e) => onGuidance(id, e.target.value)}
                    placeholder={t("packs.editor.pillars.guidancePlaceholder")}
                  />
                </div>
              );
            })}
          </div>
        )}
      </PillarCard>

      <PillarCard
        title={t("packs.specSheet.dashboardTitle")}
        hint={t("packs.editor.pillars.dashboardHint")}
        testId="pack-pillars-dashboard"
      >
        <div className="flex flex-wrap gap-1.5" data-testid="pack-pillars-blocks">
          {CONSOLE_BLOCKS.map((id) => {
            const on = blocks.some((b) => b.block === id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => toggleBlock(id)}
                aria-pressed={on}
                data-testid={`pack-pillars-block-${id}`}
                className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${
                  on ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"
                }`}
              >
                {id}
              </button>
            );
          })}
        </div>
        {blocks.length > 0 && (
          <div className="space-y-1">
            <Label htmlFor="pack-pillars-headline" className="text-xs">{t("packs.editor.pillars.headline")}</Label>
            <Input
              id="pack-pillars-headline"
              value={consoleDecl?.headline ?? ""}
              onChange={(e) => {
                const next: NonNullable<PackManifest["console"]> = { blocks: consoleDecl?.blocks ?? [] };
                if (e.target.value.trim()) next.headline = e.target.value.trim();
                onConsole(next);
              }}
              placeholder="kpi.deliverables"
              data-testid="pack-pillars-headline"
            />
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => onConsole(undefined)} data-testid="pack-pillars-console-clear">
                {t("packs.editor.pillars.clearConsole")}
              </Button>
            </div>
          </div>
        )}
      </PillarCard>

      {/* 发布前预览：与市场页同一份渲染（同一组件、同一派生）。 */}
      <div className="rounded-md border border-dashed border-border p-3" data-testid="pack-pillars-preview">
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t("packs.editor.pillars.previewTitle")}</p>
        {previewErr && (
          <p className="text-xs text-destructive" data-testid="pack-pillars-preview-error">{previewErr}</p>
        )}
        {!previewErr && preview && (
          <AgentSpecSheet variant="full" testIdPrefix="pillars-preview" pillars={preview} />
        )}
      </div>
    </section>
  );
}
