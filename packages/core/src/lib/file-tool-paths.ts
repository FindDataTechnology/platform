// Tool-call path extraction, shared by the web's preview affordance and the
// turn artifact strip (add-artifact-delivery). Tool input arguments and
// results both name files; the first plausible path is what the affordances
// offer. Kept here (not in web-only code) so the mini program's strip can
// resolve links through the SAME rule instead of a drifting copy — the same
// discipline the file-ref rule follows.

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
