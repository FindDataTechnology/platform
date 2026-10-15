// Floating conversation outline (add-chat-outline). A collapsed edge control
// on the transcript's right edge expands on hover into a card listing every
// user turn; hovering an entry reveals its full prompt (the card entry grows
// in place — no tooltip stacking), clicking jumps to the turn. The control
// and card live in ONE hover container so the pointer can cross the gap
// between them without the card collapsing (design D2).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ListTree, Minus } from "lucide-react";

export interface OutlineEntry {
  id: string;
  text: string;
}

interface Props {
  entries: OutlineEntry[];
  onJump: (id: string) => void;
}

export function ChatOutline({ entries, onJump }: Props) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  // The "—" affordance: collapse now and stay collapsed until the pointer
  // re-enters (leaving the card would collapse anyway; the click makes it
  // immediate and deliberate).
  const [suppressed, setSuppressed] = useState(false);
  const expanded = hovered && !suppressed;

  return (
    <nav
      aria-label={t("chat.outlineLabel")}
      data-testid="chat-outline"
      className="pointer-events-none absolute right-1 top-20 z-20 flex max-h-[60vh] flex-col items-end"
      onMouseEnter={() => {
        setHovered(true);
        setSuppressed(false);
      }}
      onMouseLeave={() => setHovered(false)}
    >
      {expanded ? (
        <div className="pointer-events-auto flex max-h-full w-56 flex-col overflow-hidden rounded-md border border-border bg-card shadow-md">
          <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {t("chat.outlineLabel")}
            </span>
            <button
              type="button"
              aria-label={t("chat.outlineCollapse")}
              data-testid="chat-outline-collapse"
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setSuppressed(true)}
            >
              <Minus className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          <ol className="flex-1 overflow-y-auto py-1">
            {entries.map((e, idx) => (
              <li key={e.id}>
                <button
                  type="button"
                  title={t("chat.outlineJump")}
                  data-testid="chat-outline-entry"
                  data-turn-id={e.id}
                  className="group flex w-full items-start gap-1.5 px-2 py-1 text-left text-xs leading-5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => onJump(e.id)}
                >
                  <span className="shrink-0 tabular-nums opacity-60">{idx + 1}</span>
                  {/* Detail-on-hover: one clamped line normally, the full prompt
                      (up to 4 lines) while the ROW is hovered — group so the
                      whole entry is the hit area, not just the text span. */}
                  <span className="line-clamp-1 group-hover:line-clamp-4">{e.text}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <button
          type="button"
          aria-label={t("chat.outlineLabel")}
          data-testid="chat-outline-edge"
          className="pointer-events-auto m-1 flex h-8 w-5 items-center justify-center rounded-l-md border border-r-0 border-border bg-card/90 text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground"
        >
          <ListTree className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </nav>
  );
}
