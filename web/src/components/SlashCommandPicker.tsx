// SlashCommandPicker — sectioned popover for slash-command autocomplete in the
// composer. Shows two sections (Commands, Skills) with the user's typed
// substring filtered case-insensitively against each entry's label. Arrow keys
// move the highlight, Enter inserts the highlighted label, Esc dismisses.
// Opens when the composer text contains a leading `/` (or `/` after a space).

import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@platform/core";
import { cn } from "@/lib/utils";

export interface SlashCommand {
  label: string; // e.g. "/model" or "/skill:foo"
  description?: string;
}

interface Props {
  // The current composer text (raw). The picker derives the filter from the
  // last `/...` token and only renders when the token is non-empty and the
  // user hasn't moved past it.
  text: string;
  // Whether the picker is currently visible. The composer owns this state so
  // Esc can dismiss without clearing the text (a separate "dismissed" flag
  // resets on the next edit).
  open: boolean;
  // Highlighted index across the merged, filtered list.
  highlight: number;
  onHighlight: (i: number) => void;
  // Insert a label and reset state. `onPick` should return the new text.
  onPick: (label: string) => void;
  // The full set of built-in commands (constant). Passed in so the composer
  // owns the source of truth and the picker stays presentational.
  commands: SlashCommand[];
}

const MAX_PER_SECTION = 8;

export function SlashCommandPicker({ text, open, highlight, onHighlight, onPick, commands }: Props) {
  const { t } = useTranslation();
  const skills = useChatStore((s) => s.skills);
  const listRef = useRef<HTMLDivElement>(null);

  // Find the active `/...` token at caret. We only consider the prefix up to
  // the first whitespace after the most recent `/`; the composer is
  // single-line, so the whole text is "the prefix".
  const token = useMemo(() => {
    const m = text.match(/(^|\s)(\/[^/\s]*)$/);
    return m ? m[2] : null;
  }, [text]);

  const query = token ? token.slice(1).toLowerCase() : "";

  const filteredCommands = useMemo(() => {
    if (!token) return [];
    return commands
      .filter((c) => c.label.toLowerCase().includes(query))
      .slice(0, MAX_PER_SECTION);
  }, [token, query, commands]);

  const filteredSkills = useMemo(() => {
    if (!token) return [];
    return skills
      .map((s) => ({ label: `/skill:${s.name}`, description: s.description || "" }))
      .filter((s) => s.label.toLowerCase().includes(query))
      .slice(0, MAX_PER_SECTION);
  }, [token, query, skills]);

  // Flatten for keyboard navigation. Section breaks don't count as items.
  const items = useMemo(
    () => [...filteredCommands, ...filteredSkills],
    [filteredCommands, filteredSkills],
  );

  // Keep the highlight in bounds when the filter shrinks.
  useEffect(() => {
    if (highlight >= items.length) onHighlight(Math.max(0, items.length - 1));
  }, [items.length, highlight, onHighlight]);

  if (!open) return null;
  if (!token) return null;
  if (items.length === 0) {
    return (
      <div
        ref={listRef}
        role="listbox"
        data-testid="slash-picker"
        className="absolute bottom-full left-4 right-4 mb-2 overflow-hidden rounded-md border border-border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-lg"
      >
        {t("composer.slashPicker.noMatches")}
      </div>
    );
  }

  let idx = -1;
  return (
    <div
      ref={listRef}
      role="listbox"
      data-testid="slash-picker"
      className="absolute bottom-full left-4 right-4 mb-2 max-h-72 overflow-y-auto rounded-md border border-border bg-popover shadow-lg"
    >
      {filteredCommands.length > 0 && (
        <>
          <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("composer.slashPicker.sectionCommands")}
          </div>
          {filteredCommands.map((c) => {
            idx += 1;
            const i = idx;
            return (
              <button
                key={c.label}
                type="button"
                role="option"
                aria-selected={i === highlight}
                data-testid="slash-picker-item"
                onMouseEnter={() => onHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(c.label);
                }}
                className={cn(
                  "flex w-full items-baseline gap-3 px-3 py-1.5 text-left text-xs",
                  i === highlight ? "bg-muted" : "hover:bg-muted/60",
                )}
              >
                <span className="font-mono text-foreground">{c.label}</span>
                {c.description && (
                  <span className="truncate text-muted-foreground">{c.description}</span>
                )}
              </button>
            );
          })}
        </>
      )}
      {filteredSkills.length > 0 && (
        <>
          <div className="border-t border-border px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("composer.slashPicker.sectionSkills")}
          </div>
          {filteredSkills.map((c) => {
            idx += 1;
            const i = idx;
            return (
              <button
                key={c.label}
                type="button"
                role="option"
                aria-selected={i === highlight}
                data-testid="slash-picker-item"
                onMouseEnter={() => onHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(c.label);
                }}
                className={cn(
                  "flex w-full items-baseline gap-3 px-3 py-1.5 text-left text-xs",
                  i === highlight ? "bg-muted" : "hover:bg-muted/60",
                )}
              >
                <span className="font-mono text-foreground">{c.label}</span>
                {c.description && (
                  <span className="truncate text-muted-foreground">{c.description}</span>
                )}
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}
