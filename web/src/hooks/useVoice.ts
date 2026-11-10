// useVoice — the page-wide voice availability (voice-lane).
//
// One cached read of /api/voice/status shared by the composer (mic + file
// entry) and every assistant turn (朗读). The boot config's `voice.enabled`
// short-circuits the fetch when the deployment switched voice off, so a
// disabled deployment costs no request at all. `refresh()` re-reads after a
// credential-shaped failure or a settings save.
import { useEffect, useSyncExternalStore } from "react";
import { useAppConfig } from "@/hooks/useAppConfig";
import { fetchVoiceStatus, type VoiceStatus } from "@/lib/voice";

type State = { status: VoiceStatus | null; loaded: boolean; loading: boolean };

let state: State = { status: null, loaded: false, loading: false };
const listeners = new Set<() => void>();

function emit(next: State) {
  state = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function refreshVoiceStatus(): Promise<VoiceStatus | null> {
  if (state.loading) return state.status;
  emit({ ...state, loading: true });
  try {
    const status = await fetchVoiceStatus();
    emit({ status, loaded: true, loading: false });
    return status;
  } catch {
    // Unreachable / unauthenticated: report "not available" honestly rather
    // than leaving entries that will fail on first click.
    emit({ status: null, loaded: true, loading: false });
    return null;
  }
}

export function useVoice(): { available: boolean; status: VoiceStatus | null; loaded: boolean; refresh: () => Promise<VoiceStatus | null> } {
  const { voice } = useAppConfig();
  const s = useSyncExternalStore(subscribe, () => state, () => state);
  // `voice === null` is an older server without the field: probe anyway so a
  // new web on an old server degrades to "unavailable" through the 404.
  const deploymentOff = voice !== null && voice.enabled === false;
  useEffect(() => {
    if (deploymentOff || s.loaded || s.loading) return;
    void refreshVoiceStatus();
  }, [deploymentOff, s.loaded, s.loading]);
  return {
    available: !deploymentOff && s.status?.available === true,
    status: s.status,
    loaded: deploymentOff || s.loaded,
    refresh: refreshVoiceStatus,
  };
}
