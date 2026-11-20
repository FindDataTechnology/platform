// Chat-side delivery-status questions against the library (openspec:
// add-artifact-delivery). Two consumers:
//
//   - the chart badge: "is this fence's canonical hash captured?"
//   - the turn artifact strip: "for each tool-produced path, saved by content?"
//
// Both re-ask when the resources store's eventSeq moves (a capture/save just
// landed), so the UI updates without a reload. Answers are server-authoritative
// via POST /api/resources/lookup — only the server can hash file bytes.

import { useEffect, useState } from "react";
import { lookupResourceStatus, type WorkspacePathState } from "@platform/core";
import { useResourcesStore } from "./useResourcesStore";

// undefined = not known yet (or the lookup failed); the badge renders nothing
// rather than a wrong answer.
export function useChartCaptured(hash: string | null): boolean | undefined {
  const eventSeq = useResourcesStore((s) => s.eventSeq);
  const [captured, setCaptured] = useState<boolean | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: eventSeq is the deliberate trigger — a capture just landed, re-ask so the badge updates without a reload
  useEffect(() => {
    if (!hash) {
      setCaptured(undefined);
      return;
    }
    let cancelled = false;
    lookupResourceStatus({ hashes: [hash] })
      .then((r) => {
        if (!cancelled) setCaptured(Boolean(r.hashes[hash]));
      })
      .catch(() => {
        if (!cancelled) setCaptured(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [hash, eventSeq]);

  return captured;
}

// Batched: one lookup for the whole strip. `paths` identity is unstable per
// render, so the effect keys on the joined string.
export function usePathSaveStates(paths: string[]): Record<string, WorkspacePathState> {
  const eventSeq = useResourcesStore((s) => s.eventSeq);
  const key = paths.join("\n");
  const [states, setStates] = useState<Record<string, WorkspacePathState>>({});

  // biome-ignore lint/correctness/useExhaustiveDependencies: eventSeq is the deliberate trigger — a save just landed, re-ask so the strip updates without a reload
  useEffect(() => {
    const list = key ? key.split("\n") : [];
    if (!list.length) {
      setStates({});
      return;
    }
    let cancelled = false;
    lookupResourceStatus({ paths: list })
      .then((r) => {
        if (!cancelled) setStates(r.paths ?? {});
      })
      .catch(() => {
        // Unknown state renders like "unsaved"; the save path itself reports
        // the authoritative answer (already-in-library) on click.
        if (!cancelled) setStates({});
      });
    return () => {
      cancelled = true;
    };
  }, [key, eventSeq]);

  return states;
}
