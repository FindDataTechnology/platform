// Helpers shared by the preview drawer and its entry points: deciding which
// renderer a file gets, building the route URL the server resolves against an
// allowlisted root, and turning a tool argument or link into such a reference.
//
// The reference rule itself lives in @platform/core (openspec:
// add-resource-library 6.1) so the mini program's file chip resolves links
// through the SAME rule instead of a drifting copy. This module keeps the
// web-only pieces: the same-origin URL builder and the tool-argument scanner.

import {
  baseName,
  extOf,
  fileRefPath,
  kindOf,
  linkRef,
  resolveRef,
  type FileRef,
  type FileRoot,
  type PreviewKind,
} from "@platform/core";

export { baseName, extOf, kindOf, linkRef, resolveRef };
export type { FileRef, PreviewKind };

// The drawer's roots are the shared set (workspace, uploads, resources) —
// aliased to keep every existing call site reading naturally.
export type Root = FileRoot;

export function fileUrl(root: Root, rel: string): string {
  return fileRefPath({ root, rel });
}

// Tool-call arguments and results both name files; the first plausible path is
// what the preview action offers.
const PATH_KEYS = ["path", "file_path", "filepath", "file", "filename", "output", "target"];
const PATH_RE =
  /(?:^|[\s"'`[(=:])((?:\.{1,2}\/|~?\/)?[\w./-]*[\w-]\.(?:png|jpe?g|gif|webp|bmp|svg|ico|pdf|txt|log|md|markdown|csv|html?|docx|xlsx?|doc|pptx?|json|ya?ml|xml|zip))/i;

export function findFilePath(args: unknown, result: unknown): string | null {
  if (args && typeof args === "object") {
    for (const k of PATH_KEYS) {
      const v = (args as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  for (const src of [result, args]) {
    if (typeof src !== "string") continue;
    const m = PATH_RE.exec(src);
    if (m?.[1]) return m[1];
  }
  return null;
}