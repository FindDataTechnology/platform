// McpCredentialPanel — per-owner endpoint override and tool-level credentials
// (openspec: add-user-supplied-credentials, L3/L4).
//
// Both capabilities are opt-in per server, and the SERVER decides:
//   · endpoint — only when the manifest says `endpointOverridable: true`
//   · tool credentials — only when `credentialScopes` includes "tool" AND the
//     manifest names an env destination for that tool
//
// The UI's job is to say so. Offering a form the API will 403 is the exact
// "configured but ineffective" failure this change exists to remove, so an
// unsupported server renders a plain explanation and no inputs.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { showToast } from "@/components/ui/toast";
import {
  fetchMcpEndpoint,
  fetchMcpToolCredentials,
  saveMcpEndpoint,
  saveMcpToolCredential,
  type McpEndpointState,
  type McpToolCredentialsState,
} from "@platform/core";

interface Props {
  serverName: string;
}

export function McpCredentialPanel({ serverName }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [endpoint, setEndpoint] = useState<McpEndpointState | null>(null);
  const [tools, setTools] = useState<McpToolCredentialsState | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ep, tc] = await Promise.all([
        fetchMcpEndpoint(serverName).catch(() => null),
        fetchMcpToolCredentials(serverName).catch(() => null),
      ]);
      setEndpoint(ep);
      setTools(tc);
      setUrlDraft(ep?.url ?? "");
    } finally {
      setLoading(false);
    }
  }, [serverName]);

  useEffect(() => { void load(); }, [load]);

  const saveEndpoint = async () => {
    setBusy(true);
    try {
      const next = await saveMcpEndpoint(serverName, urlDraft.trim());
      setEndpoint(next);
      setUrlDraft(next.url ?? "");
      showToast({ severity: "success", title: t("extensions.credentials.endpointSaved") });
    } catch (e) {
      showToast({ severity: "error", title: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const saveTool = async (tool: string) => {
    setBusy(true);
    try {
      await saveMcpToolCredential(serverName, tool, (keyDrafts[tool] ?? "").trim());
      setKeyDrafts((d) => ({ ...d, [tool]: "" }));
      await load();
      showToast({ severity: "success", title: t("extensions.credentials.toolSaved") });
    } catch (e) {
      showToast({ severity: "error", title: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="px-1 py-2 text-xs text-muted-foreground" data-testid="mcp-cred-loading">
        <Loader2 className="inline h-3 w-3 animate-spin" /> {t("common.loading")}
      </div>
    );
  }

  const endpointSupported = Boolean(endpoint?.overridable);
  const toolSupported = Boolean(tools?.supported);
  // Nothing is configurable for this server: stay invisible rather than show an
  // empty panel (most servers are in this state — they did not opt in).
  if (!endpointSupported && !toolSupported) return null;

  const configuredTools = Object.entries(tools?.tools ?? {});

  return (
    <div className="mt-2 flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3" data-testid="mcp-credential-panel">
      {endpointSupported && (
        <div data-testid="mcp-endpoint-section">
          <p className="text-xs font-medium">{t("extensions.credentials.endpointTitle")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("extensions.credentials.endpointHint")}</p>
          <div className="mt-1.5 flex items-center gap-2">
            <Input
              data-testid="mcp-endpoint-input"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="https://…"
              className="h-8 text-xs"
            />
            <Button
              data-testid="mcp-endpoint-save"
              size="sm"
              disabled={busy}
              onClick={() => void saveEndpoint()}
            >
              {t("common.save")}
            </Button>
          </div>
          {endpoint?.configured && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="mcp-endpoint-active">
              {t("extensions.credentials.endpointActive")}
            </p>
          )}
        </div>
      )}

      {endpointSupported && toolSupported && <hr className="border-border" />}

      {toolSupported ? (
        <div data-testid="mcp-tool-cred-section">
          <p className="text-xs font-medium">{t("extensions.credentials.toolTitle")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("extensions.credentials.toolHint")}</p>
          {configuredTools.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="mcp-tool-cred-empty">
              {t("extensions.credentials.toolEmpty")}
            </p>
          ) : (
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {configuredTools.map(([tool, entry]) => (
                <li key={tool} className="flex items-center gap-2" data-testid={`mcp-tool-cred-${tool}`}>
                  <span className="min-w-0 flex-1 truncate text-xs">{tool}</span>
                  <span className="text-xs text-muted-foreground">{entry.env ?? "—"}</span>
                  <Input
                    data-testid={`mcp-tool-cred-input-${tool}`}
                    value={keyDrafts[tool] ?? ""}
                    onChange={(e) => setKeyDrafts((d) => ({ ...d, [tool]: e.target.value }))}
                    placeholder={entry.configured ? t("extensions.credentials.replaceKey") : t("extensions.credentials.pasteKey")}
                    className="h-8 w-40 text-xs"
                  />
                  <Button
                    data-testid={`mcp-tool-cred-save-${tool}`}
                    size="sm"
                    disabled={busy}
                    onClick={() => void saveTool(tool)}
                  >
                    {t("common.save")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        // The server declared endpoint capability but NOT tool capability, or
        // neither. Say it plainly — silence would read as "no such feature".
        endpointSupported && (
          <p className="text-xs text-muted-foreground" data-testid="mcp-tool-cred-unsupported">
            {t("extensions.credentials.toolUnsupported")}
          </p>
        )
      )}
    </div>
  );
}
