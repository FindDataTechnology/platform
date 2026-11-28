// Room attachment transport — the app's only platform-shaped part of the
// attachment lane (openspec: zhiyu-room-attachments-and-voice).
//
// Why this is its own module: it is the ONE thing about attachments that
// differs per client, and it is the thing a test must be able to drive. Kept
// free of `@platform/core` and of React Native imports so `node --test` can
// import it directly (Node strips the types); the caller injects `http`, RN
// supplies the FormData.
//
// The shape it must get right: RN's FormData does NOT take a Blob. It takes a
// `{ uri, name, type }` descriptor. Passing anything else uploads the literal
// string "[object Object]" and the server stores garbage — a bug that typechecks
// and passes every lint rule.

export interface RoomAttachmentFile {
  uri: string;
  name: string;
  mimeType?: string;
}

/** The RN file descriptor FormData expects. */
export function attachmentFormEntry(file: RoomAttachmentFile) {
  return {
    uri: file.uri,
    name: file.name,
    type: file.mimeType || "application/octet-stream",
  };
}

/** The room's attachment route, with the id escaped exactly once. */
export function roomAttachmentPath(roomId: string) {
  return `/api/zhiyu/rooms/${encodeURIComponent(roomId)}/attachments`;
}

/** The server's answer → this client's attachment, or a throwable reason. */
export function readUploadResult(res: { ok: boolean; status: number; body: unknown }): { id: string; status?: string } {
  const body = res.body as { attachment?: { id: string; status?: string }; error?: string } | null;
  if (!res.ok || !body?.attachment) {
    throw new Error(String(body?.error || `HTTP ${res.status}`).slice(0, 120));
  }
  return body.attachment;
}

/**
 * The picker seam.
 *
 * On a device this IS `expo-document-picker`. Why it is swappable at all: the
 * Android system file chooser is a separate process's UI, and Maestro cannot
 * drive it — so a device test of "attach a file" had no way in without either
 * a human or a seam. The CI build sets EXPO_PUBLIC_E2E_ATTACHMENT=(a bundled
 * file path) and this returns that file instead of opening the chooser; every
 * step AFTER the pick (upload → server → card state) is production's.
 *
 * Production never sets the variable, so `pickedFile()` is always
 * `DocumentPicker.getDocumentAsync` there. The seam is READ-ONLY: it cannot
 * change what gets uploaded, only where the file came from.
 */
export interface PickedFile {
  uri: string;
  name: string;
  size?: number;
  mimeType?: string;
}

/** The e2e fixture path, or null in any normal build. */
export function e2eAttachmentPath(env: Record<string, string | undefined> = process.env): string | null {
  const raw = String(env.EXPO_PUBLIC_E2E_ATTACHMENT ?? "").trim();
  return raw || null;
}

/** A picked file as the e2e seam presents it (a bundled asset, fixed name). */
export function e2ePickedFile(fixturePath: string): PickedFile {
  const name = fixturePath.split("/").pop() || "fixture.txt";
  return { uri: fixturePath, name, mimeType: "text/plain" };
}
