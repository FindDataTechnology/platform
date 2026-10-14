// HelpDialog — the persistent help center. Replaces the old `/help` behavior
// (the full command list flashed in a 1.6-second toast): commands, skills,
// and keyboard shortcuts stay on screen until the user closes them.
//
// Opened from two places: the `/help` slash command and the sidebar settings
// menu's 帮助 entry. Content resolves through the i18n bundle; the skill list
// comes live from the store (with its count, so the surface's powers are
// visible even before the first prompt).
//
// Three tabs (add-onboarding-tutorial): 快速上手 — the three-step walkthrough
// with the tour replay affordance and a name glossary; 场景教程 — the pack
// guides from the client content module; 命令与快捷键 — the original four
// sections, unchanged. Tabs are component state, not URLs: the help center is
// an overlay, not a routed surface.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@platform/core";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { PACK_GUIDES } from "@/lib/packGuides";
import { replayTour } from "@/components/OnboardingTour";
import { cn } from "@/lib/utils";

const CMDS = [
  { label: "/model", descKey: "composer.cmd.model" },
  { label: "/new", descKey: "composer.cmd.new" },
  { label: "/clear", descKey: "composer.cmd.clear" },
  { label: "/help", descKey: "composer.cmd.help" },
];

const SHORTCUTS: { keys: string; descKey: string }[] = [
  { keys: "Enter", descKey: "help.shortcuts.send" },
  { keys: "Shift + Enter", descKey: "help.shortcuts.newline" },
  { keys: "/", descKey: "help.shortcuts.picker" },
  { keys: "Esc", descKey: "help.shortcuts.dismiss" },
  { keys: "Ctrl/⌘ + O", descKey: "help.shortcuts.thinking" },
  { keys: "Shift + F10", descKey: "help.shortcuts.sessionMenu" },
];

type Tab = "start" | "guides" | "reference";

const TABS: { id: Tab; labelKey: string }[] = [
  { id: "start", labelKey: "help.tabs.start" },
  { id: "guides", labelKey: "help.tabs.guides" },
  { id: "reference", labelKey: "help.tabs.reference" },
];

export function HelpDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const skills = useChatStore((s) => s.skills);
  const [tab, setTab] = useState<Tab>("start");
  // Per-guide expansion inside the scenario-guides tab.
  const [openGuide, setOpenGuide] = useState<string | null>(null);
  const guides = Object.entries(PACK_GUIDES);

  const replay = () => {
    // Close first so the tour's coach-marks meet an unobstructed surface.
    onOpenChange(false);
    replayTour();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="help-dialog"
        className="max-w-xl"
        role="dialog"
        aria-modal="true"
        aria-label={t("help.title")}
      >
        <DialogHeader>
          <DialogTitle>{t("help.title")}</DialogTitle>
          <DialogDescription>{t("help.subtitle")}</DialogDescription>
        </DialogHeader>

        {/* Tabs */}
        <div className="mt-2 border-b border-border">
          <nav className="flex gap-4" role="tablist" aria-label={t("help.title")}>
            {TABS.map(({ id, labelKey }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                data-testid={`help-tab-${id}`}
                onClick={() => setTab(id)}
                className={cn(
                  "border-b-2 px-2 py-2 text-sm font-medium transition-colors",
                  tab === id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t(labelKey)}
              </button>
            ))}
          </nav>
        </div>

        {tab === "start" && (
          <div className="mt-3 flex flex-col gap-4" data-testid="help-start">
            {/* The three steps — same walkthrough the tour performs. */}
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-foreground">{t("help.start.title")}</h3>
              <ol className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                {[1, 2, 3].map((n) => (
                  <li key={n} className="flex gap-2">
                    <span className="mt-px grid h-4 w-4 shrink-0 place-items-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
                      {n}
                    </span>
                    <span>{t(`help.start.s${n}`)}</span>
                  </li>
                ))}
              </ol>
              <button
                type="button"
                onClick={replay}
                data-testid="help-replay-tour"
                className="self-start rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-muted"
              >
                {t("help.start.replay")}
              </button>
            </section>

            {/* Glossary — the R1 naming, one line each. */}
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-foreground">{t("help.start.glossaryTitle")}</h3>
              <ul className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                {(["library", "outputs", "experts", "packs"] as const).map((k) => (
                  <li key={k}>• {t(`help.start.glossary.${k}`)}</li>
                ))}
              </ul>
            </section>
          </div>
        )}

        {tab === "guides" && (
          <div className="mt-3 flex flex-col gap-2" data-testid="help-guides">
            {guides.length === 0 && (
              <p className="text-xs text-muted-foreground">{t("help.guidesEmpty")}</p>
            )}
            {guides.map(([packId, guide]) => {
              const open = openGuide === packId;
              return (
                <div key={packId} className="rounded-md border border-border" data-testid="help-guide-item">
                  <button
                    type="button"
                    onClick={() => setOpenGuide(open ? null : packId)}
                    aria-expanded={open}
                    data-testid={`help-guide-toggle-${packId}`}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    <span className="truncate font-medium text-foreground">{guide.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{open ? "▾" : "▸"}</span>
                  </button>
                  {open && (
                    <ol className="flex flex-col gap-2 border-t border-border px-3 py-2">
                      {guide.steps.map((s, i) => (
                        <li key={s.title} className="text-xs">
                          <span className="font-medium text-foreground">
                            {t("packs.guide.step", { n: i + 1 })} · {s.title}
                          </span>
                          <p className="mt-0.5 leading-5 text-muted-foreground">{s.body}</p>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {tab === "reference" && (
          <div className="mt-4 flex flex-col gap-5" data-testid="help-reference">
            {/* Concepts — the how-does-this-work layer beneath the commands. */}
            <section aria-labelledby="help-concepts-heading" className="flex flex-col gap-2">
              <h3 id="help-concepts-heading" className="text-sm font-medium text-foreground">
                {t("help.concepts.title")}
              </h3>
              <ul className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                <li>• {t("help.concepts.attachments")}</li>
                <li>• {t("help.concepts.knowledge")}</li>
                <li>• {t("help.concepts.sessions")}</li>
                <li>• {t("help.concepts.tools")}</li>
              </ul>
            </section>

            {/* Commands */}
            <section aria-labelledby="help-commands-heading" className="flex flex-col gap-2">
              <h3 id="help-commands-heading" className="text-sm font-medium text-foreground">
                {t("help.commands")}
              </h3>
              <ul className="flex flex-col gap-1">
                {CMDS.map((c) => (
                  <li key={c.label} className="flex items-baseline gap-3 text-xs">
                    <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                      {c.label}
                    </code>
                    <span className="text-muted-foreground">{t(c.descKey)}</span>
                  </li>
                ))}
              </ul>
            </section>

            {/* Skills (live from the store) */}
            <section aria-labelledby="help-skills-heading" className="flex flex-col gap-2">
              <h3 id="help-skills-heading" className="text-sm font-medium text-foreground">
                {t("help.skills", { count: skills.length })}
              </h3>
              {skills.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("help.emptySkills")}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {skills.map((s) => (
                    <li key={s.name} className="flex items-baseline gap-3 text-xs">
                      <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                        /skill:{s.name}
                      </code>
                      <span className="text-muted-foreground">{s.description}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Shortcuts */}
            <section aria-labelledby="help-shortcuts-heading" className="flex flex-col gap-2">
              <h3 id="help-shortcuts-heading" className="text-sm font-medium text-foreground">
                {t("help.shortcuts.title")}
              </h3>
              <ul className="flex flex-col gap-1">
                {SHORTCUTS.map((s) => (
                  <li key={s.keys} className="flex items-baseline gap-3 text-xs">
                    <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                      {s.keys}
                    </code>
                    <span className="text-muted-foreground">{t(s.descKey)}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
