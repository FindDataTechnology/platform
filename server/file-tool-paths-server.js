// ── Server-side mirror of the produced-file rule ─────────────────────────────
//
// The rule's single home is `packages/core/src/lib/file-tool-paths.ts` (TS,
// consumed by web and mini program through the Vite build). The server is
// plain JS and ships without the packages tree, so the turn-capture path
// (resources.captureFilesFromTurn) cannot import it directly. This file is the
// sanctioned server mirror — design decision (b) of
// openspec: wire-produced-files-to-outputs, kept from drifting by
// scripts/test-file-tool-paths-contract.mjs, which feeds an identical command
// corpus to BOTH implementations and fails on any output difference. If the
// core rule changes, the contract test forces this mirror to follow.
//
// Mirroring is intentional duplication under a gate, not a fork: one pure
// function, one corpus, zero tolerance.

const FILE_EXTENSION_SRC =
  "png|jpe?g|gif|webp|bmp|svg|ico|pdf|txt|log|md|markdown|csv|tsv|html?|docx|xlsx?|doc|pptx?|json|ya?ml|xml|zip|tar|gz|tgz|7z|rar|bz2|xz";

const PATH_KEYS = ["file_path", "path", "filepath", "file", "filename", "output", "target"];

const CONTENT_KEYS = ["content", "file_text", "new_string", "new_str", "text", "contents", "body", "data"];

const MODE_COMMAND_TOOLS = new Set(["str_replace_editor"]);

const ARCHIVE_EXTENSIONS = "zip|tar|gz|tgz|7z|rar|bz2|xz";

const PRODUCING_VERBS = new Set([
  "zip", "tar", "gzip", "7z", "rar", "cp", "mv", "rsync",
  "pandoc", "ffmpeg", "convert", "soffice", "dd", "split",
]);

const SCRIPT_RUNNER_VERBS = new Set(["python3", "python", "node"]);

const COMMAND_PREFIXES = new Set(["sudo", "env", "command", "nice", "time", "nohup"]);

const PATH_TOKEN_SRC = `(?:[.~]?\\/)?[\\w./-]*[\\w-]\\.(?:${FILE_EXTENSION_SRC})`;

const REDIRECT_RE = />>?\s*("[^"]*"|'[^']*'|[^\s;&|<>()]+)/g;

const HEREDOC_RE = /<<-?/;

const HEREDOC_INTRO_RE = /<<-?\s*(?:"([^"\n]*)"|'([^'\n]*)'|(\S+))/;

const SEGMENT_SPLIT_RE = /&&|\|\||[;|\n]/;

const QUOTED_SYNTAX_RE = /[&|;\n<>]/g;

const MAX_CANDIDATES = 20;

function unquote(token) {
  return token.replace(/^["']|["']$/g, "");
}

function pathTokens(text) {
  return [...text.matchAll(new RegExp(PATH_TOKEN_SRC, "gi"))].map((m) => m[0]);
}

function glueHeredocs(command) {
  let out = "";
  let rest = command;
  for (;;) {
    const m = HEREDOC_INTRO_RE.exec(rest);
    if (!m) return out + rest;
    const introEnd = m.index + m[0].length;
    const delim = (m[1] ?? m[2] ?? m[3] ?? "EOF").replace(/^'/, "").replace(/'$/, "");
    const esc = delim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bodyRe = new RegExp(`\\n[ \\t]*${esc}[ \\t]*(?:\\n|$)`);
    const tail = rest.slice(introEnd);
    const bodyMatch = bodyRe.exec(tail);
    const body = bodyMatch ? tail.slice(0, bodyMatch.index) : tail;
    const after = bodyMatch ? tail.slice(bodyMatch.index + bodyMatch[0].length) : "";
    out += rest.slice(0, introEnd) + " " + body.replace(/\n/g, " ") + (bodyMatch ? "\n" : "\n");
    rest = after;
    if (!bodyMatch) return out;
  }
}

// Mirror of maskQuotedSyntax in packages/core/src/lib/file-tool-paths.ts —
// see that file for the rationale (production: `python3 -c "…;…"` split at the
// body's semicolons and the zip never reached Outputs).
function maskQuotedSyntax(command) {
  let out = "";
  let i = 0;
  while (i < command.length) {
    const ch = command[i] ?? "";
    if (ch === "\\") {
      out += ch + (command[i + 1] ?? "").replace(QUOTED_SYNTAX_RE, " ");
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < command.length) {
        const c = command[j] ?? "";
        if (c === "\\" && ch === '"') {
          j += 2;
          continue;
        }
        if (c === ch) break;
        j++;
      }
      if (j >= command.length) {
        out += command.slice(i);
        break;
      }
      out += ch + command.slice(i + 1, j).replace(QUOTED_SYNTAX_RE, " ") + ch;
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function commandCandidates(command) {
  const out = [];
  for (const segment of maskQuotedSyntax(glueHeredocs(command)).split(SEGMENT_SPLIT_RE)) {
    const trimmed = segment.trim();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && COMMAND_PREFIXES.has(tokens[i])) i++;
    const verb = (tokens[i] ?? "").split("/").pop() ?? "";
    const isHeredoc = HEREDOC_RE.test(trimmed);
    if (!isHeredoc) {
      for (const m of trimmed.matchAll(REDIRECT_RE)) {
        const target = unquote(m[1] ?? "");
        if (target && !target.startsWith("/dev/") && pathTokens(target).includes(unquote(target)))
          out.push(unquote(target));
      }
    }
    if (PRODUCING_VERBS.has(verb)) {
      for (const token of pathTokens(trimmed)) out.push(unquote(token));
    } else if (SCRIPT_RUNNER_VERBS.has(verb)) {
      const archiveToken = new RegExp(`[\\w./-]*[\\w-]\\.(?:${ARCHIVE_EXTENSIONS})\\b`, "gi");
      for (const m of trimmed.matchAll(archiveToken)) out.push(m[0]);
    }
  }
  return out;
}

export function producedFilePaths(name, args) {
  const tool = typeof name === "string" ? name : "";
  const a = args && typeof args === "object" ? args : null;
  const str = (key) => {
    const v = a?.[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const present = (key) => a?.[key] != null;

  const candidates = [];

  const command = str("command");
  if (command && !MODE_COMMAND_TOOLS.has(tool)) {
    candidates.push(...commandCandidates(command));
  }

  const path = PATH_KEYS.map(str).find((p) => Boolean(p)) ?? null;
  if (path && CONTENT_KEYS.some(present)) candidates.push(path);

  if (MODE_COMMAND_TOOLS.has(tool) && a?.command !== "view") {
    const p = str("path");
    if (p) candidates.push(p);
  }

  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}
