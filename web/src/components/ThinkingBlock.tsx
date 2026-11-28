import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { memo, useId } from "react";

interface Props {
  text: string;
  open: boolean;
  onToggle: () => void;
}

function ThinkingBlockBase({ text, open, onToggle }: Props) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="rounded-md border border-border bg-muted/40" data-testid="thinking-block" data-open={open ? "true" : "false"}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={id}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} aria-hidden="true" />
        <span>{t("turn.thinking")}</span>
      </button>
      {open && (
        <div id={id} className="max-h-52 overflow-y-auto whitespace-pre-wrap border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  );
}

// Memoized: the store mutates turn objects in place and clones only the
// turns array, so a streaming delta re-renders just the tail turn's
// component instead of reconciling the whole transcript.
export const ThinkingBlock = memo(ThinkingBlockBase);
