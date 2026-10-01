// Markdown renderer. remark-gfm for tables/strikethrough/task-lists.
// Code blocks are highlighted with shiki, loaded lazily so the initial paint
// isn't blocked. Inline code renders unhighlighted, monospace.
//
// SAFETY: rehype-raw is deliberately NOT enabled — raw HTML in model output
// is rendered as text, closing the XSS surface without needing DOMPurify.

import { memo, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { showToast } from "@/components/Toast";
import { EChart } from "@/components/EChart";
import { useChatStore } from "@platform/core";
import { usePreviewStore } from "@/hooks/usePreviewStore";
import { baseName, fileUrl, linkRef } from "@/lib/file-preview";

const LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "python",
  "bash",
  "shellscript",
  "json",
  "markdown",
  "sql",
  "html",
  "css",
  "diff",
  "yaml",
] as const;

// Alias map for common shorthands users write in code fences.
const LANG_ALIAS: Record<string, (typeof LANGS)[number]> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  sh: "bash",
  shell: "bash",
  md: "markdown",
  yml: "yaml",
};

// Lazy shiki singleton. Loaded on first code block render.
// Uses the fine-grained /core + engine-oniguruma-wasm + explicit lang imports
// so the bundle contains ONLY the langs we register — not every one shiki
// ships. Without this, Vite pulls in ~15 MB of language grammars.
let highlighterPromise: Promise<import("shiki/core").HighlighterCore> | null = null;
async function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/oniguruma"),
      ]);
      return createHighlighterCore({
        themes: [
          import("@shikijs/themes/github-dark-dimmed"),
          import("@shikijs/themes/github-light"),
        ],
        langs: [
          import("@shikijs/langs/typescript"),
          import("@shikijs/langs/tsx"),
          import("@shikijs/langs/javascript"),
          import("@shikijs/langs/jsx"),
          import("@shikijs/langs/python"),
          import("@shikijs/langs/bash"),
          import("@shikijs/langs/shellscript"),
          import("@shikijs/langs/json"),
          import("@shikijs/langs/markdown"),
          import("@shikijs/langs/sql"),
          import("@shikijs/langs/html"),
          import("@shikijs/langs/css"),
          import("@shikijs/langs/diff"),
          import("@shikijs/langs/yaml"),
        ],
        engine: createOnigurumaEngine(import("shiki/wasm")),
      });
    })();
  }
  return highlighterPromise;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="text-sm leading-relaxed text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Override everything explicitly — no @tailwindcss/typography needed.
          p: (props) => <p className="my-2 whitespace-pre-wrap" {...props} />,
          ul: (props) => <ul className="my-2 list-disc pl-6" {...props} />,
          ol: (props) => <ol className="my-2 list-decimal pl-6" {...props} />,
          li: (props) => <li className="my-1" {...props} />,
          h1: (props) => <h1 className="mb-2 mt-4 text-lg font-semibold" {...props} />,
          h2: (props) => <h2 className="mb-2 mt-4 text-base font-semibold" {...props} />,
          h3: (props) => <h3 className="mb-2 mt-3 text-sm font-semibold" {...props} />,
          a: MarkdownLink,
          code: CodeRenderer,
          pre: ({ children }) => <>{children}</>, // pre is emitted by CodeRenderer instead
          table: (props) => (
            <div className="my-2 overflow-x-auto">
              <table className="min-w-full border-collapse text-xs" {...props} />
            </div>
          ),
          th: (props) => (
            <th className="border-b border-border px-2 py-1 text-left font-semibold" {...props} />
          ),
          td: (props) => <td className="border-b border-border px-2 py-1" {...props} />,
          blockquote: (props) => (
            <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground" {...props} />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

// A file reference in model output opens the preview drawer instead of
// navigating: our own file route verbatim, or a relative path with a previewable
// extension (a model writing `[report](report.pdf)` should still land in the
// drawer). Every other link keeps its normal behaviour.
// biome-ignore lint/suspicious/noExplicitAny: react-markdown passes an opaque, untyped props bag to custom renderers
function MarkdownLink({ href, children, ...rest }: any) {
  const openPreview = usePreviewStore((s) => s.open);
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    // Read the workspace at click time rather than subscribing: the drawer
    // resolves the path against the root the server currently serves from.
    const ref = linkRef(href, useChatStore.getState().currentWorkspace);
    if (!ref) return;
    e.preventDefault();
    openPreview({ name: baseName(ref.rel), url: fileUrl(ref.root, ref.rel), ref });
  };
  return (
    <a
      className="text-primary underline underline-offset-2 hover:opacity-80"
      target="_blank"
      rel="noopener noreferrer"
      href={href}
      onClick={onClick}
      {...rest}
    >
      {children}
    </a>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// biome-ignore lint/suspicious/noExplicitAny: react-markdown v9 passes an opaque, untyped props bag to custom code renderers
function CodeRenderer(props: any) {
  const { className, children, inline } = props;
  const raw = String(children ?? "").replace(/\n$/, "");
  // react-markdown v9 sometimes omits `inline` — infer from the presence of a
  // language className (block) or absence of newlines (inline).
  const isBlock = inline === false || /language-/.test(className ?? "") || raw.includes("\n");
  if (!isBlock) {
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{raw}</code>
    );
  }
  const lang = (className ?? "").replace(/^language-/, "").split(/\s+/)[0] || "text";
  if (lang === "echarts") return <ChartBlock code={raw} />;
  return <HighlightedCode code={raw} lang={lang} />;
}

// A fenced `echarts` block renders as a chart when its body parses as a JSON
// object, and as the ordinary code block otherwise — which is also the streaming
// case, since a half-arrived fence is simply unparseable and upgrades to a chart
// once it completes. No error state, no streaming-aware branch.
function ChartBlock({ code }: { code: string }) {
  const option = useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(code);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as object)
        : null;
    } catch {
      return null;
    }
  }, [code]);
  if (!option) return <HighlightedCode code={code} lang="echarts" />;
  return <EChart option={option} />;
}

function HighlightedCode({ code, lang }: { code: string; lang: string }) {
  const { t } = useTranslation();
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const canonical = (LANG_ALIAS[lang] ?? lang) as (typeof LANGS)[number];
  const effectiveLang = (LANGS as readonly string[]).includes(canonical) ? canonical : null;

  useEffect(() => {
    if (!effectiveLang) {
      setHtml(null);
      return;
    }
    let live = true;
    (async () => {
      try {
        const h = await getHighlighter();
        // Dual-theme output: shiki emits both palettes as --shiki-light /
        // --shiki-dark custom properties per token, and CSS picks (see
        // globals.css). Switching themes is then a repaint, not a re-highlight
        // — no async work, no re-render, nothing to thread the theme through.
        const out = h.codeToHtml(code, {
          lang: effectiveLang,
          themes: { light: "github-light", dark: "github-dark-dimmed" },
          defaultColor: false,
        });
        if (live) setHtml(out);
      } catch {
        if (live) setHtml(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [code, effectiveLang]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      showToast(t("markdown.copied"));
      setTimeout(() => setCopied(false), 1200);
    } catch {
      showToast(t("markdown.copyFailed"));
    }
  };

  return (
    <div className="group relative my-3 overflow-hidden rounded-md border border-border bg-[#22272e]">
      <div className="flex items-center justify-between border-b border-border px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>{effectiveLang ?? (lang || "text")}</span>
        <button
          onClick={copy}
          className="flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? t("markdown.copied") : t("markdown.copy")}
        </button>
      </div>
      {html ? (
        <div
          className="overflow-x-auto px-3 py-2 text-xs [&_pre]:!bg-transparent [&_pre]:!p-0"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: `html` is shiki output — shiki escapes the source text, so this is rendered-highlight HTML, not user HTML
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto px-3 py-2 text-xs">
          <code className="font-mono">{code}</code>
        </pre>
      )}
    </div>
  );
}
