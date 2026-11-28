import { ChevronRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  name: string;
  args?: string;
  open: boolean;
  onToggle: () => void;
}

// add-skill-display-annotations 3.2: the localized human label leads when the
// skill carries an annotation — the raw slug stays visible beside it
// (monospace, copy/expand keep the slug) and is never replaced. Absent skills
// render byte-identical to before.
interface SkillAnnotation {
  label: string;
  summary: string;
}
type AnnotationIndex = { servers: Record<string, SkillAnnotation>; tools: Record<string, SkillAnnotation>; skills?: Record<string, SkillAnnotation> };
const annotationIndexCache = new Map<string, Promise<AnnotationIndex>>();
function annotationIndex(locale: string): Promise<AnnotationIndex> {
  let p = annotationIndexCache.get(locale);
  if (!p) {
    p = fetch(`/api/supply-annotations?locale=${encodeURIComponent(locale)}`)
      .then((r) => (r.ok ? r.json() : { servers: {}, tools: {} }))
      .catch(() => ({ servers: {}, tools: {} }));
    annotationIndexCache.set(locale, p);
  }
  return p;
}

function useSkillAnnotation(name: string): SkillAnnotation | null {
  const { i18n } = useTranslation();
  const [ann, setAnn] = useState<SkillAnnotation | null>(null);
  useEffect(() => {
    let alive = true;
    annotationIndex(i18n.language).then((idx) => {
      if (!alive) return;
      setAnn(idx.skills?.[name] ?? null);
    });
    return () => {
      alive = false;
    };
  }, [name, i18n.language]);
  return ann;
}

export function SkillBlock({ name, args, open, onToggle }: Props) {
  const bodyId = useId();
  const ann = useSkillAnnotation(name);
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
        {ann ? (
          <span className="min-w-0 truncate" data-testid="skill-annotation-label">
            <span className="font-medium text-foreground">{ann.label}</span>{" "}
            <span className="font-mono text-[10px] text-muted-foreground">/skill:{name}</span>
          </span>
        ) : (
          <span className="font-mono font-semibold text-foreground">/skill:{name}</span>
        )}
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
