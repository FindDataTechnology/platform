// In-app update check (add-mobile-distribution 3.1/3.2).
//
// Reads the public release manifest — no app store, no account, no silent
// install: the result is a version number and a URL the user opens in the
// system browser. A failed read is NOT an error the user must handle; it is a
// quiet "unknown", because a manifest outage must never make the settings
// screen unusable.

export const DEFAULT_MANIFEST_URL = "https://platform.finddatatech.cloud/dl/app/app-releases.json";

export interface ReleaseEntry {
  version: string;
  released_at?: string;
  prerelease?: boolean;
  filename?: string;
  size?: number;
  sha256?: string;
  url: string;
}

export interface UpdateCheck {
  status: "available" | "current" | "unknown";
  currentVersion: string;
  latest?: ReleaseEntry;
  /** Set when the check itself failed — recorded, never shown as a blocker. */
  error?: string;
}

export function compareVersions(a: string, b: string): number {
  const pa = String(a).split(/[-+]/)[0].split(".").map(Number);
  const pb = String(b).split(/[-+]/)[0].split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/** Newest formal release in a manifest, or null. */
export function newestRelease(manifest: unknown): ReleaseEntry | null {
  const releases = (manifest as { releases?: unknown })?.releases;
  if (!Array.isArray(releases)) return null;
  const formal = releases.filter(
    (r): r is ReleaseEntry =>
      !!r && typeof r === "object" && typeof (r as ReleaseEntry).version === "string" && typeof (r as ReleaseEntry).url === "string" && (r as ReleaseEntry).prerelease !== true,
  );
  if (!formal.length) return null;
  return formal.reduce((best, r) => (compareVersions(r.version, best.version) > 0 ? r : best));
}

export function judgeUpdate(currentVersion: string, manifest: unknown): UpdateCheck {
  const latest = newestRelease(manifest);
  if (!latest) return { status: "unknown", currentVersion, error: "manifest carried no release" };
  return compareVersions(latest.version, currentVersion) > 0
    ? { status: "available", currentVersion, latest }
    : { status: "current", currentVersion, latest };
}

export async function checkForUpdate({
  currentVersion,
  manifestUrl = DEFAULT_MANIFEST_URL,
  fetchImpl = fetch,
}: {
  currentVersion: string;
  manifestUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<UpdateCheck> {
  try {
    const res = await fetchImpl(manifestUrl, { signal: AbortSignal.timeout(15_000) } as RequestInit);
    if (!res.ok) return { status: "unknown", currentVersion, error: `manifest HTTP ${res.status}` };
    return judgeUpdate(currentVersion, await res.json());
  } catch (err) {
    // Silent by contract: the caller may log it, the UI shows nothing alarming.
    return { status: "unknown", currentVersion, error: String((err as Error)?.message ?? err) };
  }
}
