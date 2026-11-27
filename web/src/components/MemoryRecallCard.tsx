import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  // The fd-memory server-rendered digest block, verbatim (spec
  // memory-recall-card): the front end never re-flows, truncates or parses
  // it — the line structure IS the render, and the inline （来自 xxx）
  // badges stay plain text (harness semantics owned by fd-memory).
  block: string;
}

// Opener memory card (add-memory-visible-ux, design D2): rendered at the top
// of the message flow when a session open carried a `memory_recall` echo.
// Collapsed by default with the block's first line as the summary; expanded
// shows the block as-is (whitespace-pre-line, no clamp — the server render is
// already budget-bound). The footer is the standing /memory correction entry.
// Collapsed state is component-local useState: ChatPage keys this card by
// session id, so it persists within a session (a resync re-echo keeps the
// toggle state) and resets when another session opens — no persistence layer.
export function MemoryRecallCard({ block }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // The sanctioned summary: the block's first line, verbatim (D2). The
  // explicit limit keeps the collapsed render from building the tail array.
  const summary = block.split("\n", 1)[0] ?? "";
  return (
    <div
      className="rounded-md border border-border bg-muted/40 text-xs"
      data-testid="memory-recall-card"
      data-open={open ? "true" : "false"}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
        <span className="shrink-0 font-medium text-foreground">{t("memoryRecall.title")}</span>
        {!open && summary && <span className="truncate">{summary}</span>}
      </button>
      {open && (
        <div className="whitespace-pre-line border-t border-border px-3 py-2 text-muted-foreground">
          {block}
        </div>
      )}
      <div className="border-t border-border px-3 py-1.5">
        <Link
          to="/memory"
          className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {t("memoryRecall.viewInPanel")}
        </Link>
      </div>
    </div>
  );
}
