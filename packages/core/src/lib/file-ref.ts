// The path/href → file-reference rule, shared by the web app and the mini
// program (openspec: add-resource-library 6.1). It lives in core so the two
// clients cannot disagree about what counts as a file: the web preview drawer,
// the chat's file links, and the mini program's file chip all resolve through
// this one rule instead of two drifting copies.
//
// Pure — no DOM, no transport, no base URL. `fileRefPath` returns the route
// PATH (query string included): the web uses it as a same-origin URL, the mini
// program prepends its configured base.

export type PreviewKind =
  | "image"
  | "pdf"
  | "text"
  | "markdown"
  | "csv"
  | "html"
  | "docx"
  | "none";

/** Roots the serving route resolves a reference against. */
export type FileRoot = "workspace" | "uploads" | "resources";

export interface FileRef {
  root: FileRoot;
  rel: string;
}

export const FILE_ROOTS: FileRoot[] = ["workspace", "uploads", "resources"];

const EXT_KIND: Record<string, PreviewKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  svg: "image",
  ico: "image",
  pdf: "pdf",
  txt: "text",
  log: "text",
  md: "markdown",
  markdown: "markdown",
  csv: "csv",
  html: "html",
  htm: "html",
  docx: "docx",
};

// Extensions that mark a link as a PRODUCED FILE even when the client cannot
// preview the type. The mini program's chip uses this broader set: it cannot
// render an .xlsx, but it can still save or forward it, and that is the whole
// point of the chip. Longest-first where one extension prefixes another
// (markdown before md, jpeg before jpg is irrelevant, but keep the habit).
export const FILE_EXTENSIONS: string[] = [
  "markdown",
  "md",
  "jpeg",
  "jpg",
  "png",
  "gif",
  "webp",
  "bmp",
  "svg",
  "ico",
  "pdf",
  "txt",
  "log",
  "csv",
  "tsv",
  "html",
  "htm",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "json",
  "yaml",
  "yml",
  "xml",
  "zip",
];

export function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m?.[1]?.toLowerCase() ?? "";
}

/** The drawer's renderer for a name, or "none" when there is no preview. */
export function kindOf(name: string): PreviewKind {
  return EXT_KIND[extOf(name)] ?? "none";
}

export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** Whether a name looks like a produced file (previewable or not). */
export function looksLikeFile(name: string): boolean {
  return FILE_EXTENSIONS.includes(extOf(name));
}

/** The route path serving a reference — the web's href, the mini program's tail. */
export function fileRefPath(ref: FileRef): string {
  return `/api/files?root=${ref.root}&path=${encodeURIComponent(ref.rel)}`;
}

// A path from a tool argument or a link → a route reference, or null when it is
// not addressable: a URL, or an absolute path outside the agent workspace (the
// only absolute root the server knows is the workspace).
export function resolveRef(input: string, workspace: string | null): FileRef | null {
  const raw = input.trim().replace(/^["'`]|["'`]$/g, "");
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.includes("\0")) return null;
  if (raw.startsWith("/")) {
    if (!workspace) return null;
    const ws = workspace.replace(/\/+$/, "");
    if (raw === ws || !raw.startsWith(`${ws}/`)) return null;
    return { root: "workspace", rel: raw.slice(ws.length + 1) };
  }
  const rel = raw.replace(/^\.\//, "");
  if (!rel || rel.startsWith("../") || rel === "..") return null;
  return { root: "workspace", rel };
}

// Our own route links are taken verbatim (any allowlisted root); anything else
// that names a file is treated as a workspace path, so a model that writes
// `[report](report.pdf)` still resolves.
function routeRef(href: string): FileRef | null {
  if (!href.startsWith("/api/files?")) return null;
  const q = new URLSearchParams(href.slice(href.indexOf("?") + 1));
  const root = q.get("root") as FileRoot | null;
  const rel = q.get("path");
  if (root && FILE_ROOTS.includes(root) && rel) return { root, rel };
  return null;
}

// The href of an anchor in assistant text → a reference, when the anchor is a
// file the preview drawer can render. Non-previewable types fall through to
// null here (the web has nothing to show); the mini program's chip wants the
// broader rule below.
export function linkRef(href: string | undefined, workspace: string | null): FileRef | null {
  if (!href) return null;
  const route = routeRef(href);
  if (route) return route;
  if (kindOf(href) === "none") return null;
  return resolveRef(href, workspace);
}

// The href of an anchor → a reference whenever it names a produced file, even
// one the client cannot preview (openspec: resource-library-ui — the mini
// program's file chip is exactly this case: preview when possible, save or
// forward otherwise).
export function fileLinkRef(href: string | undefined, workspace: string | null): FileRef | null {
  if (!href) return null;
  const route = routeRef(href);
  if (route) return route;
  if (!looksLikeFile(href)) return null;
  return resolveRef(href, workspace);
}