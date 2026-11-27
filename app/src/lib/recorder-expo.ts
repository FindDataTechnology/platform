// Expo binding for the app's recorder adapter (openspec:
// add-voice-input-mobile, tasks 3.2/3.3).
//
// expo-audio creates its recorder through a hook, so this is the one module
// allowed to import it: the page calls useExpoVoiceRecorder(insert) and gets a
// ready VoiceRecorder from @platform/core. Everything the spec pins lives in
// that machine + the adapter; this file only wires platform bits.

import { useMemo, useRef } from "react";
import { useAudioRecorder, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync } from "expo-audio";
import { http, VoiceRecorder, voiceFitsUpload } from "@platform/core";
import { runtime } from "./session";
import { createExpoRecorderAdapter, uploadExpoTake, type ExpoRecorderLike, type ExpoTake } from "./recorder";

export { VoiceUploadError } from "./recorder";

export interface ExpoVoiceOptions {
  /** Where the transcript lands (never auto-sent). */
  insert: (text: string) => void;
  /** Localized text for "this take is too big to upload". */
  tooLargeMessage: string;
  /** Hard stop for a single take; exports stay well under the 25 MB ceiling. */
  maxDurationMs?: number;
}

/** A recorder whose transcript lands in the caller's draft (never auto-sent). */
export function useExpoVoiceRecorder({ insert, tooLargeMessage, maxDurationMs }: ExpoVoiceOptions): VoiceRecorder<ExpoTake> {
  // LOW_QUALITY is plenty for speech and keeps a long take well under the
  // 25 MB upload ceiling.
  const audioRecorder = useAudioRecorder(RecordingPresets.LOW_QUALITY);
  const insertRef = useRef(insert);
  insertRef.current = insert;
  const messageRef = useRef(tooLargeMessage);
  messageRef.current = tooLargeMessage;

  return useMemo(
    () =>
      new VoiceRecorder<ExpoTake>({
        adapter: createExpoRecorderAdapter({
          recorder: audioRecorder as unknown as ExpoRecorderLike,
          requestPermission: async () => {
            const res = await requestRecordingPermissionsAsync();
            return Boolean(res?.granted);
          },
          recordingOptions: RecordingPresets.LOW_QUALITY,
          beforeStart: async () => {
            // iOS records into a silent route without this.
            await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
          },
        }),
        upload: (take) =>
          uploadExpoTake(
            {
              post: (path, body) => http(path, { method: "POST", body }),
              refresh: () => runtime.refresher.refreshOnce(),
            },
            take,
          ),
        insert: (text) => insertRef.current(text),
        // Refuse locally what would certainly 413 upstream. 64 kbps is a
        // deliberate over-estimate of the preset: better to stop a little early
        // than to spend a slow-link upload on a doomed request.
        preflight: (take) =>
          voiceFitsUpload(take.durationMs, 64_000) ? { ok: true } : { ok: false, reason: messageRef.current },
        autoStopMs: maxDurationMs ?? 600_000,
      }),
    [audioRecorder, maxDurationMs],
  );
}
