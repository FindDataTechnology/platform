// ValidationPanel — the inspector's validation segment (add-agent-builder-
// workspace 2.3 + 5.2): the publish gate's RAW wording stays verbatim (doctrine:
// never reworded), gains a copy affordance, and every finding that names an
// entry becomes a jump-to-field action (scroll + focus + flash). Findings whose
// stable `code` is in the client map get a localized one-line summary ABOVE the
// raw text (5.3: summary + jump + raw in one row); unknown codes show the raw
// text only — never a guess.
import { useTranslation } from "react-i18next";
import { Copy, MapPin, TriangleAlert } from "lucide-react";
import { showToast } from "@/components/ui/toast";
import type { ValidationVerdict } from "@/lib/blueprint-api";
import { codeSummaryKey } from "@/lib/error-codes";
import { recordStudioMetric } from "@/lib/studio-metrics";
import { cn } from "@/lib/utils";

// Entry-less manifest errors whose field is unambiguous on this surface:
// the assembled manifest's name/description come from boundary.name/oneLine.
// 5.2: the stable codes now name those same two fields directly — the regex
// table stays as the fallback for older servers that predate codes.
const KNOWN_ENTRYLESS: Array<{ match: RegExp; anchor: string }> = [
  { match: /^name must be/, anchor: "boundary.name" },
  { match: /^description must be|^description is required/, anchor: "boundary.oneLine" },
];
const CODE_ANCHORS: Record<string, string> = {
  name_too_long: "boundary.name",
  description_too_long: "boundary.oneLine",
};

export function anchorForError(entry: string | undefined, error: string, code?: string): string | null {
  if (entry) return entry;
  if (code && CODE_ANCHORS[code]) return CODE_ANCHORS[code];
  for (const k of KNOWN_ENTRYLESS) if (k.match.test(error)) return k.anchor;
  return null;
}

export function jumpToAnchor(anchor: string): boolean {
  const el = document.querySelector<HTMLElement>(`[data-anchor="${anchor.replace(/"/g, '\\"')}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  const focusable = el.matches("input,textarea,select,button")
    ? el
    : el.querySelector<HTMLElement>("input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button");
  focusable?.focus({ preventScroll: true });
  // Reuse the design system's imperative flash (Chat's outline-jump-flash):
  // a primary-tint wash that fades, theme-safe, no new keyframes.
  el.classList.remove("outline-jump-flash");
  void (el as HTMLElement).offsetWidth; // forced reflow restarts a rapid re-tap
  el.classList.add("outline-jump-flash");
  window.setTimeout(() => el.classList.remove("outline-jump-flash"), 1200);
  return true;
}

export function ValidationPanel({ verdict, verifying, docId }: { verdict: ValidationVerdict | null; verifying: boolean; docId?: string | null }) {
  const { t } = useTranslation();

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast({ severity: "success", title: t("studio.workspace.validation.copied") });
    } catch {
      showToast({ severity: "error", title: text });
    }
  };

  return (
    <div data-testid="ws-validation">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        {verifying ? (
          <span className="text-muted-foreground">{t("studio.validate.running")}</span>
        ) : verdict?.ok ? (
          <span className="text-success" data-testid="ws-validation-ok">{t("studio.validate.ok")}</span>
        ) : verdict && !verdict.ok ? (
          <span className="inline-flex items-center gap-1 text-destructive" data-testid="ws-validation-bad">
            <TriangleAlert className="h-3.5 w-3.5" /> {t("studio.validate.bad", { n: verdict.errors.length })}
          </span>
        ) : null}
      </div>
      {verdict && !verdict.ok && (
        <ul className="mt-1 space-y-1">
          {verdict.errors.map((e, i) => {
            const anchor = anchorForError(e.entry, e.error, e.code);
            const canJump = anchor != null;
            const summaryKey = codeSummaryKey(e.code);
            return (
              <li
                /* biome-ignore lint/suspicious/noArrayIndexKey: flat error rows, never reordered */
                key={i}
                className="flex items-start gap-1 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs"
                data-testid="ws-validation-error"
                data-code={e.code ?? undefined}
              >
                <span className="min-w-0 flex-1">
                  {/* 5.3 三同框：摘要（有 code 映射时）在上，原文逐字在下 */}
                  {summaryKey && <span className="block font-medium text-destructive">{t(summaryKey)}</span>}
                  <span className={cn("block whitespace-pre-line", summaryKey ? "mt-0.5 text-[11px] text-muted-foreground" : "")}>
                    {e.entry ? <span className="mr-1 font-mono text-[11px] text-destructive">{e.entry}</span> : null}
                    {e.error}
                  </span>
                </span>
                {canJump && (
                  <button
                    type="button"
                    aria-label={t("studio.workspace.validation.jump")}
                    title={t("studio.workspace.validation.jump")}
                    data-testid={`ws-validation-jump-${i}`}
                    className={cn("shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground")}
                    onClick={() => {
                      // 8.4: the click that starts a resolution attempt.
                      if (docId) recordStudioMetric({ type: "validation_jump", at: Date.now(), docId });
                      if (!jumpToAnchor(anchor!)) {
                        showToast({ severity: "info", title: t("studio.workspace.validation.jumpMiss") });
                      }
                    }}
                  >
                    <MapPin className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  aria-label={t("studio.workspace.validation.copy")}
                  title={t("studio.workspace.validation.copy")}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => void copy(e.error)}
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
