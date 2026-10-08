// Preview drawer (openspec: file-preview-drawer).
//
// Loaded lazily on first open — App mounts it through React.lazy behind the
// store's "is anything open" flag — and rendered as a fixed right-hand overlay,
// so opening it never unmounts the chat or its socket.
//
// Anything that renders authored markup (an HTML file, the docx renderer's
// output, an external preview service) goes inside a sandboxed <iframe> with no
// allow-same-origin: an opaque origin that cannot reach this app, its storage,
// or its WebSocket credentials.
//
// Every type that has no renderer — and every renderer that fails — ends at the
// same download action. There is deliberately no "error" state: a file the
// drawer cannot show is still a file the user can have.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, FolderPlus, Loader2, X } from "lucide-react";
import { saveErrorKey, saveResource, useChatStore } from "@platform/core";
import { Markdown } from "@/components/Markdown";
import { showToast } from "@/components/Toast";
import { usePreviewStore, type PreviewTarget } from "@/hooks/usePreviewStore";
import { baseName, kindOf } from "@/lib/file-preview";

const DOCX_STYLE =
  "body{font-family:system-ui,sans-serif;line-height:1.6;color:#111;background:#fff;margin:0;padding:24px}" +
  "img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}";

export default function PreviewDrawer() {
  const { t } = useTranslation();
  const target = usePreviewStore((s) => s.target);
  const close = usePreviewStore((s) => s.close);
  const [saving, setSaving] = useState(false);

  // Save-to-resources (openspec: add-resource-library): only workspace files
  // can be saved — uploads already belong to the document library, and a local
  // blob was never on the server. The resource is a COPY, so it keeps working
  // after the workspace file changes or disappears; the session id is passed
  // for provenance, nothing more.
  const saveToResources = async () => {
    const ref = target?.ref;
    if (!ref || ref.root !== "workspace") return;
    setSaving(true);
    try {
      const { inserted } = await saveResource({
        path: ref.rel,
        sessionId: useChatStore.getState().currentSessionId,
      });
      showToast(inserted ? t("resources.save.saved") : t("resources.save.exists"));
    } catch (err) {
      // A known refusal gets the LOCALIZED reason; an unknown one falls back to
      // the server's own text rather than swallowing it.
      const key = saveErrorKey(err);
      showToast(
        key
          ? t(`resources.save.errors.${key}`)
          : t("resources.save.failed", { message: (err as Error).message }),
      );
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  if (!target) return null;

  return (
    <aside
      data-testid="preview-drawer"
      aria-label={t("preview.title")}
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-2xl animate-in flex-col border-l border-border bg-background shadow-xl slide-in-from-right"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
        <span data-testid="preview-name" className="min-w-0 flex-1 truncate text-sm font-medium">
          {target.name}
        </span>
        {target.ref?.root === "workspace" ? (
          <button
            type="button"
            onClick={() => void saveToResources()}
            disabled={saving}
            data-testid="preview-save-resource"
            aria-label={t("resources.actions.save")}
            title={t("resources.actions.save")}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <FolderPlus className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
        <DownloadAction
          url={target.url}
          name={target.name}
          testId="preview-download"
          label={t("preview.download")}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
        </DownloadAction>
        <button
          type="button"
          onClick={close}
          data-testid="preview-close"
          aria-label={t("preview.close")}
          title={t("preview.close")}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <Renderer target={target} />
      </div>
    </aside>
  );
}

function Renderer({ target }: { target: PreviewTarget }) {
  switch (kindOf(target.name)) {
    case "image":
      return <ImagePreview target={target} />;
    case "pdf":
      return <PdfPreview target={target} />;
    case "text":
      return <TextPreview target={target} markdown={false} />;
    case "markdown":
      return <TextPreview target={target} markdown />;
    case "csv":
      return <CsvPreview target={target} />;
    case "html":
      return <HtmlPreview target={target} />;
    case "docx":
      return <DocxPreview target={target} />;
    default:
      return <DownloadOnly target={target} />;
  }
}

// Image and PDF renderers hand the URL to the browser, which loads it with no
// built-in feedback — a large file over a slow link used to read as a blank
// pane (perf-session-open). Both now carry the drawer's busy state until the
// element reports load; a failed image load is still a downloadable file.
function ImagePreview({ target }: { target: PreviewTarget }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  if (state === "failed") return <DownloadOnly target={target} />;
  return (
    <div className="relative">
      <img
        src={target.url}
        alt={target.name}
        onLoad={() => setState("ready")}
        onError={() => setState("failed")}
        data-testid="preview-image"
        className="mx-auto max-w-full p-4"
      />
      {state === "loading" && (
        <BusyOverlay />
      )}
    </div>
  );
}

function PdfPreview({ target }: { target: PreviewTarget }) {
  const [ready, setReady] = useState(false);
  return (
    <div className="relative h-full w-full">
      <iframe
        src={target.url}
        title={target.name}
        onLoad={() => setReady(true)}
        data-testid="preview-pdf"
        className="h-full w-full"
      />
      {!ready && <BusyOverlay />}
    </div>
  );
}

// The drawer's universal busy state (perf-session-open): centered spinner +
// label, the same affordance the text fetch renderers already had. Rendered
// as an overlay for element-driven renderers (image/pdf/external) so the
// element can keep loading underneath it.
function BusyOverlay() {
  const { t } = useTranslation();
  return (
    <div
      data-testid="preview-loading"
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/80 text-sm text-muted-foreground"
    >
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
      {t("preview.loading")}
    </div>
  );
}

// Shared fetch for the text-shaped renderers. A failed fetch is not an error
// state — it falls back to the download action like any unrenderable type.
function useText(target: PreviewTarget): { text: string | null; failed: boolean } {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setText(null);
    setFailed(false);
    fetch(target.url)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then((v) => live && setText(v))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [target.url]);
  return { text, failed };
}

function TextPreview({ target, markdown }: { target: PreviewTarget; markdown: boolean }) {
  const { text, failed } = useText(target);
  if (failed) return <DownloadOnly target={target} />;
  if (text === null) return <Loading />;
  if (markdown)
    return (
      <div className="p-4" data-testid="preview-markdown">
        <Markdown text={text} />
      </div>
    );
  return (
    <pre
      data-testid="preview-text"
      className="whitespace-pre-wrap break-words p-4 font-mono text-xs"
    >
      {text}
    </pre>
  );
}

// Minimal RFC4180-ish parser: quoted fields, escaped quotes, CRLF. Handles the
// quoted-comma case a naive split(",") gets wrong.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function CsvPreview({ target }: { target: PreviewTarget }) {
  const { text, failed } = useText(target);
  if (failed) return <DownloadOnly target={target} />;
  if (text === null) return <Loading />;
  const rows = parseCsv(text);
  const [head, ...body] = rows;
  return (
    <div className="overflow-auto p-4" data-testid="preview-csv">
      <table className="min-w-full border-collapse text-xs">
        {head && (
          <thead>
            <tr>
              {head.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a CSV row is positional and never reorders
                <th key={i} className="border border-border bg-muted px-2 py-1 text-left font-semibold">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a CSV row is positional and never reorders
            <tr key={i}>
              {r.map((c, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a CSV cell is positional and never reorders
                <td key={j} className="border border-border px-2 py-1">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HtmlPreview({ target }: { target: PreviewTarget }) {
  const { text, failed } = useText(target);
  if (failed) return <DownloadOnly target={target} />;
  if (text === null) return <Loading />;
  return <Sandbox html={text} title={target.name} testId="preview-html" />;
}

function DocxPreview({ target }: { target: PreviewTarget }) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setHtml(null);
    setFailed(false);
    (async () => {
      // mammoth's browser build turns the .docx into an HTML string, which then
      // renders in the same sandbox as an HTML file rather than in this DOM.
      const [mammoth, buffer] = await Promise.all([
        import("mammoth"),
        fetch(target.url).then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.arrayBuffer();
        }),
      ]);
      const { value } = await mammoth.convertToHtml({ arrayBuffer: buffer });
      if (live) setHtml(value);
    })().catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [target.url]);
  if (failed) return <DownloadOnly target={target} />;
  if (html === null) return <Loading />;
  return (
    <Sandbox
      html={`<!doctype html><meta charset="utf-8"><style>${DOCX_STYLE}</style>${html}`}
      title={target.name}
      testId="preview-docx"
    />
  );
}

// The single sandbox policy for active content. allow-scripts WITHOUT
// allow-same-origin is the load-bearing combination: scripts may run, but in an
// opaque origin that has no access to this app's origin, storage, or socket.
function Sandbox({ html, title, testId }: { html: string; title: string; testId: string }) {
  return (
    <iframe
      srcDoc={html}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      data-testid={testId}
      className="h-full w-full"
    />
  );
}

function Loading() {
  const { t } = useTranslation();
  return (
    <div
      data-testid="preview-loading"
      className="flex items-center gap-2 p-4 text-sm text-muted-foreground"
    >
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {t("preview.loading")}
    </div>
  );
}

// Fetched download with a busy state and a plain-anchor fallback
// (perf-session-open): the anchor's own navigation is the pre-change
// behavior, so a fetch that cannot complete degrades to exactly what worked
// before — a busy download must never become a failed download.
function DownloadAction({
  url,
  name,
  testId,
  label,
  className,
  children,
}: {
  url: string;
  name: string;
  testId: string;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const onDownload = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (busyRef.current) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    busyRef.current = true;
    setBusy(true);
    (async () => {
      try {
        // Same-origin fetch so the auth cookie rides; the blob+object-URL
        // handoff gives the save a stable local source.
        const r = await fetch(url);
        if (!r.ok) throw new Error(String(r.status));
        const blob = await r.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Chrome captures the blob synchronously; Safari's save dialog may
        // not — hold the object URL briefly, then let it go.
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
      } catch {
        // Plain fallback: a handler-free anchor with the download attribute,
        // i.e. the browser's own download path for this same URL.
        const plain = document.createElement("a");
        plain.href = url;
        plain.download = name;
        document.body.appendChild(plain);
        plain.click();
        plain.remove();
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    })();
  };
  return (
    <a
      href={url}
      download={name}
      onClick={onDownload}
      data-testid={testId}
      aria-label={label}
      title={label}
      aria-busy={busy || undefined}
      className={className}
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        children
      )}
    </a>
  );
}

// The universal terminal state: no renderer (or a renderer that failed). Offers
// the file, never an apology.
function DownloadOnly({ target }: { target: PreviewTarget }) {
  const { t } = useTranslation();
  const [external, setExternal] = useState<string | null>(null);
  const [externalReady, setExternalReady] = useState(false);
  useEffect(() => {
    let live = true;
    setExternalReady(false);
    // A catalog external-service tagged for file preview can render long-tail
    // formats (legacy Office, media, archives) by fetching the file itself.
    // Absent or unreachable, the drawer simply stays on the download action.
    fetch("/api/catalog")
      .then((r) => (r.ok ? r.json() : null))
      .then((cat) => {
        const svc = cat?.apps?.find(
          (a: { kind?: string; tags?: string[] }) =>
            a.kind === "external-service" && a.tags?.includes("file-preview"),
        );
        if (!live || !svc) return;
        const absolute = new URL(target.url, window.location.origin).href;
        setExternal(`/external/${svc.id}?url=${encodeURIComponent(absolute)}`);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [target.url]);

  if (external) {
    return (
      <div className="relative h-full w-full">
        <iframe
          src={external}
          title={target.name}
          onLoad={() => setExternalReady(true)}
          data-testid="preview-external"
          className="h-full w-full"
        />
        {!externalReady && <BusyOverlay />}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 p-8 text-center">
      <p className="text-sm text-muted-foreground">{t("preview.noRenderer")}</p>
      <DownloadAction
        url={target.url}
        name={target.name}
        testId="preview-fallback-download"
        label={t("preview.downloadName", { name: baseName(target.name) })}
        className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
      >
        <Download className="h-4 w-4" aria-hidden="true" />
        {t("preview.downloadName", { name: baseName(target.name) })}
      </DownloadAction>
    </div>
  );
}
