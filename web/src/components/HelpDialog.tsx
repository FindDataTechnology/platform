// HelpDialog — the persistent help center. Replaces the old `/help` behavior
// (the full command list flashed in a 1.6-second toast): commands, skills,
// and keyboard shortcuts stay on screen until the user closes them.
//
// Opened from two places: the `/help` slash command and the sidebar settings
// menu's 帮助 entry. Content resolves through the i18n bundle; the skill list
// comes live from the store (with its count, so the surface's powers are
// visible even before the first prompt).

import { useTranslation } from "react-i18next";
import { useChatStore } from "@platform/core";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

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

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HelpDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const skills = useChatStore((s) => s.skills);

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

        <div className="mt-4 flex flex-col gap-5">
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
      </DialogContent>
    </Dialog>
  );
}
