// recorder — the mini-program's RecorderAdapter for the shared voice state
// machine (openspec: add-voice-input-mobile, design D1/D2).
//
// Deliberately free of `@tarojs/taro` imports so it can be exercised in node:
// everything the platform provides comes in through MiniRecorderEnv. The thin
// Taro binding lives in recorder-taro.ts.
//
// Two mini-program rules the spec pins, implemented here:
//   • a denied `scope.record` must NOT re-prompt — `getAuthSetting()` returns
//     false for "denied" and the adapter answers false straight back; the page
//     offers 去设置 instead (spec: 被拒后不再弹系统框);
//   • the recorder manager is a PROCESS-WIDE singleton, so handlers are
//     re-registered per take and gated by a generation counter — a late
//     `onStop` from a cancelled take can never resolve a newer one.
//
// Upload rides Taro.uploadFile (no fetch/Blob in a mini program) and copies the
// house rules from lib/file-transfer.ts: the Authorization header is carried
// manually, a 401 triggers one silent re-login and exactly one retry.

import type { RecorderAdapter, RecordedTake } from "@platform/core";

export interface MiniTake {
  filePath: string;
  fileSize: number;
  durationMs: number;
}

interface RecorderStopResult {
  tempFilePath: string;
  fileSize: number;
  duration: number;
}

export interface MiniRecorderManager {
  start(opts: { format: string; duration: number; sampleRate?: number; encodeBitRate?: number; numberOfChannels?: number }): void;
  stop(): void;
  onStart(cb: () => void): void;
  onStop(cb: (res: RecorderStopResult) => void): void;
  onError(cb: (err: { errMsg?: string }) => void): void;
}

export interface MiniRecorderEnv {
  isSupported(): boolean;
  getRecorderManager(): MiniRecorderManager;
  /** true = granted, false = denied (do not re-prompt), undefined = never asked. */
  getAuthSetting(): Promise<boolean | undefined>;
  /** Ask the platform once (wx.authorize). Resolves false on denial. */
  requestAuth(): Promise<boolean>;
  /** Mini-program recording formats are mp3/aac/wav/PCM; mp3 is the default. */
  format?: string;
  /** Platform cap; Taro's own ceiling applies on top. */
  maxDurationMs?: number;
}

/** A denied-but-recoverable state the page turns into 去设置. */
export class MiniPermissionDenied extends Error {
  readonly scopeDenied = true;
  constructor() {
    super("recording permission denied");
    this.name = "MiniPermissionDenied";
  }
}

export function createMiniRecorderAdapter(env: MiniRecorderEnv): RecorderAdapter<MiniTake> {
  const manager = env.isSupported() ? env.getRecorderManager() : null;
  let generation = 0;
  let settle: ((take: RecordedTake<MiniTake> | null) => void) | null = null;
  let startFailure: ((err: Error) => void) | null = null;

  const clearHandlers = () => {
    // The manager is a singleton: leaving stale callbacks attached would let a
    // cancelled take resolve the next one.
    if (!manager) return;
    manager.onStart(() => {});
    manager.onStop(() => {});
    manager.onError(() => {});
  };

  return {
    isSupported: () => manager !== null && env.isSupported(),

    async requestPermission(): Promise<boolean> {
      if (!manager) return false;
      const state = await env.getAuthSetting();
      if (state === true) return true;
      // Denied before: never prompt again (the OS would ignore it anyway and
      // the spec forbids it). The page shows 去设置 instead.
      if (state === false) return false;
      try {
        return await env.requestAuth();
      } catch {
        return false;
      }
    },

    async start(): Promise<void> {
      if (!manager) throw new Error("recorder is not available");
      const mine = ++generation;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        manager.onStart(() => {
          if (settled) return;
          settled = true;
          resolve();
        });
        manager.onError((err) => {
          if (settled) return;
          settled = true;
          reject(new Error(err?.errMsg || "recorder failed to start"));
        });
        startFailure = (e) => {
          if (settled) return;
          settled = true;
          reject(e);
        };
        try {
          manager.start({
            format: env.format ?? "mp3",
            duration: env.maxDurationMs ?? 600_000,
            numberOfChannels: 1,
            encodeBitRate: 48_000,
            sampleRate: 16_000,
          });
        } catch (e) {
          if (!settled) {
            settled = true;
            reject(e instanceof Error ? e : new Error("recorder failed to start"));
          }
        }
      });
      // A cancel landed between start() and onStart: sweep the take.
      if (mine !== generation && manager) {
        try {
          manager.stop();
        } catch {
          /* already stopped */
        }
        clearHandlers();
      }
    },

    async stop(): Promise<RecordedTake<MiniTake> | null> {
      if (!manager) return null;
      const mine = generation;
      const done = new Promise<RecordedTake<MiniTake> | null>((resolve) => {
        settle = resolve;
      });
      manager.onStop((res) => {
        if (mine !== generation) return;
        const filePath = res?.tempFilePath ?? "";
        const fileSize = Number(res?.fileSize ?? 0);
        if (!filePath) {
          settle?.(null);
          settle = null;
          return;
        }
        settle?.({
          artifact: { filePath, fileSize, durationMs: Number(res?.duration ?? 0) },
          fileName: filePath.split("/").pop() || "recording.mp3",
          durationMs: Number(res?.duration ?? 0),
          empty: fileSize === 0,
        });
        settle = null;
      });
      manager.onError((err) => {
        if (mine !== generation) return;
        startFailure?.(new Error(err?.errMsg || "recording failed"));
        settle?.(null);
        settle = null;
      });
      manager.stop();
      return await done;
    },

    async cancel(): Promise<void> {
      generation += 1; // invalidates any in-flight stop()
      settle?.(null);
      settle = null;
      if (manager) {
        try {
          manager.stop();
        } catch {
          /* nothing was recording */
        }
        clearHandlers();
      }
    },
  };
}

// ── upload (task 2.2) ───────────────────────────────────────────────────────

export interface VoiceUploadDeps {
  apiBase: string;
  authHeaders(): Record<string, string>;
  refreshToken(): Promise<boolean>;
  /** Taro.uploadFile, injected so the retry law is testable in node. */
  uploadFile(opts: {
    url: string;
    filePath: string;
    name: string;
    header: Record<string, string>;
  }): Promise<{ statusCode: number; data: string }>;
}

export class VoiceUploadError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly connect: { panel: string } | null;
  constructor(message: string, status: number, code: string | null, connect: { panel: string } | null) {
    super(message);
    this.name = "VoiceUploadError";
    this.status = status;
    this.code = code;
    this.connect = connect;
  }
}

function parseBody(raw: string): { error?: string; code?: string; connect?: { panel: string }; text?: string } {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

/**
 * Send one take to /api/voice/transcriptions.
 *
 * A 401 means the 12h platform token lapsed: re-login silently and retry EXACTLY
 * once. A second failure is reported as-is — never a retry loop (that is how a
 * dead binding turns into a request storm).
 */
export async function uploadTakeToVoice(
  deps: VoiceUploadDeps,
  take: RecordedTake<MiniTake>,
): Promise<{ text: string }> {
  const url = `${deps.apiBase.replace(/\/+$/, "")}/api/voice/transcriptions`;
  const send = () =>
    deps.uploadFile({
      url,
      filePath: take.artifact.filePath,
      name: "file",
      header: deps.authHeaders(),
    });

  let res = await send();
  if (res.statusCode === 401 && (await deps.refreshToken())) {
    res = await send();
  }
  const body = parseBody(res.data);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new VoiceUploadError(
      body.error || `语音转写失败 (${res.statusCode})`,
      res.statusCode,
      body.code ?? null,
      body.connect ?? null,
    );
  }
  return { text: typeof body.text === "string" ? body.text : "" };
}
