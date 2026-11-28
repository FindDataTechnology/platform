// Tool-call path extraction, shared by the web's preview affordance and the
// turn artifact strip (add-artifact-delivery) and the produced-file rule
// (wire-shell-produced-artifacts). Kept here (not in web-only code) so the mini
// program resolves tool paths through the SAME rule instead of a drifting copy
// — the same discipline the file-ref rule follows.
//
// Which files a turn produced is a question about the TOOL, not about whether a
// file path happens to appear in the call. A reader names a file it is reading;
// reporting that as a product is a false positive, and scanning a command's
// OUTPUT text produces them wholesale (a directory listing, a log line). So
// `producedFilePaths` dispatches on the tool and, for a shell call, reads only
// the command string — the one place a command declares what it writes.

// Extensions that mark a token as naming a file. One list, used by the path
// scan here and (as the broad produced-file set) by file-ref.ts, so the two
// cannot disagree about what a file looks like.
export const FILE_EXTENSION_SRC =
  "png|jpe?g|gif|webp|bmp|svg|ico|pdf|txt|log|md|markdown|csv|tsv|html?|docx|xlsx?|doc|pptx?|json|ya?ml|xml|zip|tar|gz|tgz|7z|rar|bz2|xz";

// The argument keys that can name the file a call operates on. Shared by the
// shape rule below; a harness spelling it `file` or `filename` is admitted for
// the same reason a new tool name is.
const PATH_KEYS = ["file_path", "path", "filepath", "file", "filename", "output", "target"];

// The argument keys that carry the CONTENT a call is writing. Their presence
// alongside a path is what distinguishes a producer from a reader — the
// discriminator that does not depend on what the tool is called.
const CONTENT_KEYS = [
  "content",
  "file_text",
  "new_string",
  "new_str",
  "text",
  "contents",
  "body",
  "data",
];

// Tools whose `command` argument is a MODE, not a command line. Their paths are
// handled by their own branch rather than by the shell scan.
const MODE_COMMAND_TOOLS = new Set(["str_replace_editor"]);

// A path-shaped token: an optional ./ or / prefix, word/dot/dash body, and a
// recognized final extension. Built fresh per scan — a module-level /g regex
// carries lastIndex between calls.
const PATH_TOKEN_SRC = `(?:[.~]?\\/)?[\\w./-]*[\\w-]\\.(?:${FILE_EXTENSION_SRC})`;

function pathTokens(text: string): string[] {
  return [...text.matchAll(new RegExp(PATH_TOKEN_SRC, "gi"))].map((m) => m[0]);
}

// The archive and compression extensions, cut out of FILE_EXTENSION_SRC: the
// shapes a script-runner segment (python3 heredoc, `node -c`) may contribute —
// an archive is the deliverable case; a csv a script merely reads is not.
const ARCHIVE_EXTENSIONS =
  "zip|tar|gz|tgz|7z|rar|bz2|xz";

// Commands that declare an output among their arguments. A command that
// produces a file through something not on this list (`make`, `python -c`, a
// bespoke script) contributes nothing unless it redirects; the list is one
// constant to extend when a real case shows up.
const PRODUCING_VERBS = new Set([
  "zip",
  "tar",
  "gzip",
  "7z",
  "rar",
  "cp",
  "mv",
  "rsync",
  "pandoc",
  "ffmpeg",
  "convert",
  "soffice",
  "dd",
  "split",
]);

// Script runners: not producers by verb, but a runner whose text names an
// archive-shaped path is building (or at least handling) that archive —
// empirically the deliverable case (python3 heredoc zips in production).
// Their segments contribute archive-shaped tokens only.
const SCRIPT_RUNNER_VERBS = new Set(["python3", "python", "node"]);

// Wrappers that sit in front of the real verb (`sudo zip …`). Skipped when
// finding a segment's verb, so the wrapper does not hide it.
const COMMAND_PREFIXES = new Set(["sudo", "env", "command", "nice", "time", "nohup"]);

// A redirection target is an output by construction. Stops at shell operators,
// so `2>&1` (a descriptor) matches nothing and `< input` is not considered.
const REDIRECT_RE = />>?\s*("[^"]*"|'[^']*'|[^\s;&|<>()]+)/g;

// A heredoc introducer. A segment containing one is exempt from redirect
// scanning: inside a heredoc body, `->` and `=>` are code, not redirections
// (production: a python heredoc's `print("... ->", out)` minted a candidate
// that was a multi-line span of Python source).
const HEREDOC_RE = /<<-?/;

// A heredoc introducer with its delimiter word, up to the end of its line —
// `python3 - <<'EOF'`, `bash <<< "x"`, `cat <<EOF`. Everything after the
// introducer to the next delimiter line is the heredoc BODY. The quoted
// delimiter forms are line-bounded: an unterminated `<<'EOF` must not let
// `[^']*` run across newlines and swallow body text as the delimiter.
const HEREDOC_INTRO_RE = /<<-?\s*(?:"([^"\n]*)"|'([^'\n]*)'|(\S+))/;

// Segment separators: a command may run several programs, each with its own
// verb (`cd out && zip -r …`). Newlines split too — a redirected line must not
// glue its verb onto the next line's command (production: `… | sort >
// /tmp/doclist.txt\ntar -czf workspace-docs.tar.gz …` made the `tar` line a
// `sort` segment, dropping the archive entirely).
const SEGMENT_SPLIT_RE = /&&|\|\||[;|\n]/;

// The shell-syntax characters that stop being syntax inside a quoted span:
// separators (`&&`, `||`, `;`, newline) and redirections (`<`, `>`). Inside
// quotes they are literal text of an argument, and masking them keeps the span
// scannable (an archive name lives in quotes) without minting boundaries or
// pseudo-redirects.
const QUOTED_SYNTAX_RE = /[&|;\n<>]/g;

// Mask shell-syntax characters inside well-formed quoted spans. Quoted text is
// not shell syntax: production's `python3 -c "import zipfile;z=…('out.zip','w');…"`
// split at the body's semicolons and the archive landed in a verb-less fragment
// — the zip never reached Outputs (cell 1da519d4c1c0bf89, 2026-10-15). Masking
// with spaces (not removal) keeps the body's tokens separated. A quote with no
// closing partner is left untouched (fail-open: malformed input keeps the old
// splitting rather than swallowing the rest of the line).
function maskQuotedSyntax(command: string): string {
  let out = "";
  let i = 0;
  while (i < command.length) {
    const ch = command[i] ?? "";
    if (ch === "\\") {
      // An escaped character is literal, never syntax.
      out += ch + (command[i + 1] ?? "").replace(QUOTED_SYNTAX_RE, " ");
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < command.length) {
        const c = command[j] ?? "";
        // Inside double quotes a backslash escapes the next character (so \"
        // does not close the span); inside single quotes it is literal.
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

// Glue every heredoc body onto its introducer's line before segment splitting.
// A heredoc body is not shell syntax — newlines inside it are not command
// separators, and splitting would scatter the body across verb-less segments
// (production: the zip built inside a `python3 - <<'EOF'` body landed in a
// segment with no verb and was lost). Replaces the body's newlines with
// spaces; the introducer keeps the heredoc marker so its segment is exempt
// from redirect scanning. Bounded scan: stops after the body of the last
// heredoc, walks the string once.
function glueHeredocs(command: string): string {
  let out = "";
  let rest = command;
  for (;;) {
    const m = HEREDOC_INTRO_RE.exec(rest);
    if (!m) return out + rest;
    const introEnd = m.index + m[0].length;
    const delim = (m[1] ?? m[2] ?? m[3] ?? "EOF").replace(/^'/, "").replace(/'$/, "");
    // Body: everything up to a line that is the bare delimiter. replaceAll,
    // not a regex escape — an escape-class bug here swallowed literal
    // newlines into the pattern and crashed on unterminated heredocs.
    const esc = delim.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// The server caps a status lookup at 20 paths (LOOKUP_MAX_PATHS); capping here
// too keeps a pathological command from pushing a real artifact off the list.
const MAX_CANDIDATES = 20;

function unquote(token: string): string {
  return token.replace(/^["']|["']$/g, "");
}

// Candidates from a shell command string. Three output signals admit one: an
// explicit redirection into a path-shaped target, a producing verb in the
// segment, or a script-runner segment naming an archive-shaped path. Neither
// present — `ls -la`, `curl …`, `git status`, `sed -n '1,40p' f`, `wc -c < f`
// — yields nothing, which is the point: those commands write no file.
function commandCandidates(command: string): string[] {
  const out: string[] = [];
  // Order: glue (heredoc structure) → mask (quoted literals) → split. Quoted
  // spans are masked before splitting so an archive named inside a `-c` body
  // stays in its runner's segment, and before redirect scanning so a quoted
  // `->` is not a redirection.
  for (const segment of maskQuotedSyntax(glueHeredocs(command)).split(SEGMENT_SPLIT_RE)) {
    const trimmed = segment.trim();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && COMMAND_PREFIXES.has(tokens[i] ?? "")) i++;
    // A leading path (`/usr/bin/zip`) still names the verb.
    const verb = (tokens[i] ?? "").split("/").pop() ?? "";
    const isHeredoc = HEREDOC_RE.test(trimmed);

    // Redirect targets are admitted under the same discipline as verb
    // candidates — path-shaped only. This is what kills the pseudo-redirect
    // (`->` inside a heredoc's print) that minted a code-text chip in
    // production. A heredoc segment skips the scan entirely: double defense.
    if (!isHeredoc) {
      for (const m of trimmed.matchAll(REDIRECT_RE)) {
        const target = unquote(m[1] ?? "");
        // /dev/null and friends are sinks, not files.
        if (target && !target.startsWith("/dev/") && pathTokens(target).includes(unquote(target)))
          out.push(unquote(target));
      }
    }

    if (PRODUCING_VERBS.has(verb)) {
      for (const token of pathTokens(trimmed)) out.push(unquote(token));
    } else if (SCRIPT_RUNNER_VERBS.has(verb)) {
      // The runner is not a producer by verb; an archive-shaped path in its
      // text (command line, -c body, heredoc body — all part of the segment)
      // is the deliverable case. Readers of a csv contribute nothing.
      const archiveToken = new RegExp(`[\\w./-]*[\\w-]\\.(?:${ARCHIVE_EXTENSIONS})\\b`, "gi");
      for (const m of trimmed.matchAll(archiveToken)) out.push(m[0]);
    }
  }
  return out;
}

// The files this tool call produced, deduplicated and capped. `name` is the
// tool that ran; `args` its parsed arguments. The call's RESULT is deliberately
// not a parameter: output text naming a file is not evidence the call made it.
//
// The discriminator is SHAPE, not a tool-name list. A call that supplies
// content for a path is writing that file; a call that supplies only a path is
// reading, listing, or searching it. Names were tried first and rejected: the
// platform is going multi-harness (Claude Code's `Write`, Gemini's
// `write_file`, dsh's `write`), and a name allowlist drops a harness silently
// the day it is added — the failure mode this whole change is about.
export function producedFilePaths(name: unknown, args: unknown): string[] {
  const tool = typeof name === "string" ? name : "";
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : null;
  const str = (key: string): string | null => {
    const v = a?.[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  // Present-and-non-null, so an empty replacement still counts: `edit` with an
  // empty new_string deletes text, and it wrote the file to do it.
  const present = (key: string): boolean => a?.[key] != null;

  const candidates: string[] = [];

  // A shell call. Its command string is the only place a shell declares what it
  // writes. `str_replace_editor` also carries a `command`, but its value is a
  // mode name (`view`/`create`), not a command line — excluded here and handled
  // by its own branch below.
  const command = str("command");
  if (command && !MODE_COMMAND_TOOLS.has(tool)) {
    candidates.push(...commandCandidates(command));
  }

  // A call that hands over content for a path is producing that path, whatever
  // the tool is called. This is what admits a writer from a harness this repo
  // has never seen, and what keeps `read`/`glob`/`grep` out (they carry no
  // content).
  const path = PATH_KEYS.map(str).find((p): p is string => Boolean(p)) ?? null;
  if (path && CONTENT_KEYS.some(present)) candidates.push(path);

  // `str_replace_editor` in a mutating mode: its path is the target regardless
  // of which content key the mode uses. `view` only reads.
  if (MODE_COMMAND_TOOLS.has(tool) && a?.command !== "view") {
    const p = str("path");
    if (p) candidates.push(p);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}
