// Turn artifact strip (openspec: add-artifact-delivery; ADR-0009).
//
// The incident this change answers: the model wrote a file but referenced it
// only in prose, so no link resolved and the user had NO path to preview,
// download or save it. The strip surfaces every file this turn's completed
// tool calls produced — derived from tool paths (never a workspace scan),
// deduped by path at latest state — with preview and save-to-library actions.
//
// It is synthesized at RENDER TIME from data the tool blocks already carry:
// nothing is persisted into the message, nothing enters model-visible history,
// and a reopened historical session derives the identical strip. Save state
// ("already in library", by content) comes from the server lookup and refreshes
// on the library-change event, so a save from here or the drawer flips the
// chip without a reload.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, FolderOutput, Library, Save } from "lucide-react";
import {
  findFilePath,
  resolveRef,
  saveErrorKey,
  saveResource,
  useChatStore,
  type AssistantTurn,
} from "@platform/core";
import { showToast } from "@/components/Toast";
import { usePathSaveStates } from "@/hooks/useResourceStatus";
import { usePreviewStore } from "@/hooks/usePreviewStore";
import { baseName, fileUrl } from "@/lib/file-preview";

export function TurnArtifactStrip({ turn }: { turn: AssistantTurn }) {
  const { t } = useTranslation();
  const workspace = useChatStore((s) => s.currentWorkspace);
  const openPreview = usePreviewStore((s) => s.open);
  const [busy, setBusy] = useState<string | null>(null);

  const entries = useMemo(() => {
    if (turn.streaming) return [] as { rel: string; name: string }[];
    const byPath = new Map<string, { rel: string; name: string }>();
    for (const block of turn.blocks) {
      if (block.kind !== "tool" || block.state !== "done") continue;
      const found = findFilePath(block.args, block.result);
      if (!found) continue;
      const ref = resolveRef(found, workspace);
      if (!ref || ref.root !== "workspace") continue;
      byPath.set(ref.rel, { rel: ref.rel, name: baseName(ref.rel) });
    }
    return [...byPath.values()];
  }, [turn.blocks, turn.streaming, workspace]);

  const states = usePathSaveStates(entries.map((e) => e.rel));
  // Files that are gone or not addressable drop out once their state is known.
  const visible = entries.filter((e) => states[e.rel] !== "missing" && states[e.rel] !== "invalid");
  if (!visible.length) return null;

  const save = async (rel: string) => {
    setBusy(rel);
    try {
      const { inserted } = await saveResource({
        path: rel,
        sessionId: useChatStore.getState().currentSessionId,
      });
      showToast(inserted ? t("resources.save.saved") : t("resources.save.exists"));
    } catch (err) {
      const key = saveErrorKey(err);
      showToast(
        key
          ? t(`resources.save.errors.${key}`)
          : t("resources.save.failed", { message: (err as Error).message }),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      data-testid="turn-artifact-strip"
      className="flex flex-wrap items-center gap-2 self-start rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs"
    >
      <span className="flex items-center gap-1 font-medium text-muted-foreground">
        <FolderOutput className="h-3.5 w-3.5" aria-hidden="true" />
        {t("chat.artifactStrip.title")}
      </span>
      {visible.map((entry) => {
        const saved = states[entry.rel] === "saved";
        return (
          <span
            key={entry.rel}
            data-testid="turn-artifact-chip"
            className="flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5"
          >
            <button
              type="button"
              className="max-w-48 truncate font-medium hover:underline"
              title={entry.rel}
              onClick={() => {
                const ref = { root: "workspace" as const, rel: entry.rel };
                openPreview({ name: entry.name, url: fileUrl("workspace", entry.rel), ref });
              }}
            >
              {entry.name}
            </button>
            <button
              type="button"
              aria-label={t("preview.title")}
              title={t("preview.title")}
              className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => {
                const ref = { root: "workspace" as const, rel: entry.rel };
                openPreview({ name: entry.name, url: fileUrl("workspace", entry.rel), ref });
              }}
            >
              <Eye className="h-3 w-3" aria-hidden="true" />
            </button>
            {saved ? (
              <span
                data-testid="turn-artifact-saved"
                className="flex items-center gap-1 text-muted-foreground"
                title={t("chat.artifactStrip.saved")}
              >
                <Library className="h-3 w-3" aria-hidden="true" />
                {t("chat.artifactStrip.saved")}
              </span>
            ) : (
              <button
                type="button"
                data-testid="turn-artifact-save"
                aria-label={t("resources.actions.save")}
                title={t("resources.actions.save")}
                disabled={busy === entry.rel}
                onClick={() => void save(entry.rel)}
                className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                <Save className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
