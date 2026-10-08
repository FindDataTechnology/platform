import { ChevronRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useId } from "react";

interface Props {
  name: string;
  args?: string;
  open: boolean;
  onToggle: () => void;
}

export function SkillBlock({ name, args, open, onToggle }: Props) {
  const bodyId = useId();
  // No state edge: unlike tool blocks (running/error/done), a skill
  // invocation has no lifecycle to color-code — a 2px accent would claim a
  // state that doesn't exist (and was a second accent hue). Command blocks
  // share this neutral container; stateful work gets the colored edge.
  return (
    <div className="overflow-hidden rounded-md border border-border bg-muted/40">
      <button
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted"
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} aria-hidden="true" />
        <Sparkles className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="font-mono font-semibold text-foreground">/skill:{name}</span>
        {args && <span className="truncate font-mono text-muted-foreground">{args}</span>}
      </button>
      {open && args && (
        <pre id={bodyId} className="whitespace-pre-wrap break-words border-t border-border bg-background px-3 py-2 font-mono text-[11px]">
          {args}
        </pre>
      )}
    </div>
  );
}
