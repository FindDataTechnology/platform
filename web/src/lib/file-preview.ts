// Helpers shared by the preview drawer and its entry points: deciding which
// renderer a file gets, building the route URL the server resolves against an
// allowlisted root, and turning a tool argument or link into such a reference.
//
// The reference rule AND the tool-argument path scanner live in @platform/core
// (openspec: add-resource-library 6.1, add-artifact-delivery 4.1) so the mini
// program resolves links and tool paths through the SAME rules instead of
// drifting copies. This module keeps the web-only same-origin URL builder.

import {
  baseName,
  extOf,
  fileRefPath,
  findFilePath,
  kindOf,
  linkRef,
  resolveRef,
  type FileRef,
  type FileRoot,
  type PreviewKind,
} from "@platform/core";

export { baseName, extOf, findFilePath, kindOf, linkRef, resolveRef };
export type { FileRef, PreviewKind };

// The drawer's roots are the shared set (workspace, uploads, resources) —
// aliased to keep every existing call site reading naturally.
export type Root = FileRoot;

export function fileUrl(root: Root, rel: string): string {
  return fileRefPath({ root, rel });
}