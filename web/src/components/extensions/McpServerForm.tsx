// McpServerForm.tsx
// Modal form for adding/editing MCP server configurations.
// Three modes:
//   - edit:      raw form prefilled from an existing server
//   - setup:     data-driven form generated from a MarketMcpServer configTemplate
//                (one field per env key + one field per placeholder arg)
//   - manual add: raw form (command/args/env-JSON/url/headers-JSON)

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { McpServer, MarketMcpServer } from "@platform/core";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { RegistryConnectPanel } from "./RegistryConnectPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Icon } from "@/components/ui/icon";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

// Same placeholder rule as extension-store.js isPlaceholderArg.
// Duplicated client-side so the setup form needs no extra round-trip; the rule
// is tiny and stable. If they drift, the e2e badge/field split assertion catches it.
function isPlaceholderArg(arg: string): boolean {
  return /\/path\//.test(arg) || /^your_/.test(arg) || /^<.*>$/.test(arg);
}

// Same header-value rule as extension-store.js hasPlaceholder: header values
// embed the placeholder ("Bearer <your_token>") rather than being bare.
function hasPlaceholder(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (/\/path\//.test(value) || /your_/.test(value) || /<[^<>]+>/.test(value))
  );
}

interface McpServerFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server?: McpServer | null;
  initialConfig?: McpServer["config"] | null;
  setupServer?: MarketMcpServer | null;
  // Fired after a successful add (setup or manual). Lets the caller (Market tab)
  // switch to the Installed tab so the new card is visible.
  onInstalled?: () => void;
}

export function McpServerForm({ open, onOpenChange, server, initialConfig, setupServer, onInstalled }: McpServerFormProps) {
  const { t } = useTranslation();
  const { addMcpServer, updateMcpServer, registryConnection, refreshRegistryConnection } = useExtensionsStore();

  const isEdit = !!server;
  const isSetup = !!setupServer && !isEdit;
  // Registry-origin entries authenticate with the user's stored market
  // credential, resolved at profile-write time — so the form never asks for a
  // secret. Without a live credential the install is refused server-side, and
  // the form routes to connect/paste first (registry-sso-credentials).
  const isRegistrySetup = isSetup && setupServer?.origin === "registry";
  const registryLive = Boolean(registryConnection?.connected);

  const [name, setName] = useState("");
  const [type, setType] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Setup-mode field values: env key -> filled value, arg index -> filled value,
  // header name -> filled value (http templates, e.g. gateway Bearer tokens).
  const [setupEnv, setSetupEnv] = useState<Record<string, string>>({});
  const [setupArgs, setSetupArgs] = useState<Record<number, string>>({});
  const [setupHeaders, setSetupHeaders] = useState<Record<string, string>>({});

  // biome-ignore lint/correctness/useExhaustiveDependencies: `open` is a deliberate trigger — reset the form fields each time the modal (re)opens
  useEffect(() => {
    if (server) {
      setName(server.name);
      setType(server.config.command ? "stdio" : "http");
      setCommand(server.config.command || "");
      setArgs(server.config.args?.join(" ") || "");
      setEnv(JSON.stringify(server.config.env || {}, null, 2));
      setUrl(server.config.url || "");
      setHeaders(JSON.stringify(server.config.headers || {}, null, 2));
      setEnabled(server.enabled);
    } else if (setupServer) {
      const tmpl = setupServer.configTemplate;
      setName(setupServer.name);
      setType(tmpl.command ? "stdio" : "http");
      setCommand(tmpl.command || "");
      setUrl(tmpl.url || "");
      // Initialize fillable fields empty per template key / placeholder index.
      const envKeys = Object.keys(tmpl.env || {});
      const initEnv: Record<string, string> = {};
      envKeys.forEach((k) => {
        initEnv[k] = "";
      });
      setSetupEnv(initEnv);
      const argList = tmpl.args || [];
      const initArgs: Record<number, string> = {};
      argList.forEach((a, i) => {
        if (isPlaceholderArg(a)) initArgs[i] = "";
      });
      setSetupArgs(initArgs);
      const initHeaders: Record<string, string> = {};
      if (setupServer.origin !== "registry") {
        Object.entries(tmpl.headers || {}).forEach(([k, v]) => {
          if (hasPlaceholder(v)) initHeaders[k] = "";
        });
      }
      setSetupHeaders(initHeaders);
      setEnabled(true);
    } else if (initialConfig) {
      setName("");
      setType(initialConfig.command ? "stdio" : "http");
      setCommand(initialConfig.command || "");
      setArgs(initialConfig.args?.join(" ") || "");
      setEnv(JSON.stringify(initialConfig.env || {}, null, 2));
      setUrl(initialConfig.url || "");
      setHeaders(JSON.stringify(initialConfig.headers || {}, null, 2));
      setEnabled(true);
    } else {
      setName("");
      setType("stdio");
      setCommand("");
      setArgs("");
      setEnv("{}");
      setUrl("");
      setHeaders("{}");
      setEnabled(true);
    }
    setError("");
  }, [server, initialConfig, setupServer, open]);

  // Setup form is valid when every placeholder field is non-empty — and, for a
  // registry entry, when a live market credential exists (Add stays disabled
  // until then, per the marketplace spec).
  const setupValid =
    Object.values(setupEnv).every((v) => v.trim().length > 0) &&
    Object.values(setupArgs).every((v) => v.trim().length > 0) &&
    (isRegistrySetup ? registryLive : Object.values(setupHeaders).every((v) => v.trim().length > 0));

  const handleSetupSubmit = async () => {
    setError("");
    if (!name.trim()) {
      setError(t("extensions.mcp.errors.nameRequired"));
      return;
    }
    const tmpl = setupServer!.configTemplate;
    let config: McpServer["config"];
    if (tmpl.command) {
      config = {
        command: tmpl.command,
        args: (tmpl.args || []).map((a, i) =>
          isPlaceholderArg(a) ? (setupArgs[i] || "").trim() : a
        ),
      };
      const envObj: Record<string, string> = {};
      Object.keys(tmpl.env || {}).forEach((k) => {
        envObj[k] = (setupEnv[k] || "").trim();
      });
      if (Object.keys(envObj).length > 0) config.env = envObj;
    } else if (isRegistrySetup) {
      // Registry install: the backend stamps credentialRef and resolves the
      // Authorization header per request, so no header travels from here.
      config = { url: tmpl.url };
    } else {
      // http template: url is fixed; placeholder headers take the user's values.
      config = {
        url: tmpl.url,
        headers: Object.fromEntries(
          Object.entries(tmpl.headers || {}).map(([k, v]) => [
            k,
            hasPlaceholder(v) ? (setupHeaders[k] || "").trim() : v,
          ])
        ),
      };
    }

    setLoading(true);
    try {
      await addMcpServer(name.trim(), config, enabled);
      onInstalled?.();
      onOpenChange(false);
    } catch (err) {
      const e = err as Error & { code?: string };
      setError(e.message);
      // The market refused the install because the credential is no longer
      // live (it expired between render and submit, or the profile marked it
      // stale): re-read so the panel offers the connect flow again.
      if (e.code === "credential-required") refreshRegistryConnection();
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    setError("");
    if (!name.trim()) {
      setError(t("extensions.mcp.errors.nameRequired"));
      return;
    }

    let config: McpServer["config"];
    if (type === "stdio") {
      if (!command.trim()) {
        setError(t("extensions.mcp.errors.commandRequired"));
        return;
      }
      let envObj = {};
      try {
        envObj = env.trim() ? JSON.parse(env) : {};
      } catch {
        setError(t("extensions.mcp.errors.envInvalid"));
        return;
      }
      config = {
        command: command.trim(),
        args: args.trim().split(/\s+/).filter(Boolean),
        env: envObj,
      };
    } else {
      if (!url.trim()) {
        setError(t("extensions.mcp.errors.urlRequired"));
        return;
      }
      let headersObj = {};
      try {
        headersObj = headers.trim() ? JSON.parse(headers) : {};
      } catch {
        setError(t("extensions.mcp.errors.headersInvalid"));
        return;
      }
      config = {
        url: url.trim(),
        headers: headersObj,
      };
    }

    setLoading(true);
    try {
      if (isEdit) {
        await updateMcpServer(server!.name, config, enabled);
      } else {
        await addMcpServer(name.trim(), config, enabled);
        onInstalled?.();
      }
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Which args in the template are fillable vs literal.
  const tmplArgs = setupServer?.configTemplate.args || [];
  const tmplEnvKeys = Object.keys(setupServer?.configTemplate.env || {});

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <Icon name="database" size={20} />
            {isEdit ? t("extensions.mcp.editTitle") : t("extensions.mcp.addTitle")}
          </DialogTitle>
          <DialogDescription>
            {isSetup
              ? setupServer?.installInstructions
              : t("extensions.mcp.subtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && (
            <div
              className="flex items-start gap-2 border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2 rounded-md text-sm"
              data-testid="form-error"
              role="alert"
            >
              <Icon name="alert-circle" size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Name field — shared by all modes. Editable in setup (test clears + refills). */}
          <div className="space-y-2">
            <Label htmlFor="name">{t("extensions.mcp.fields.name")}</Label>
            <Input
              id="name"
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              disabled={isEdit}
              placeholder="my-mcp"
            />
          </div>

          {isSetup ? (
            <>
              {!setupServer!.configTemplate.command && (
                <div className="space-y-2">
                  <Label>{t("extensions.mcp.fields.url")}</Label>
                  <div className="text-xs font-mono px-3 py-2 rounded-md bg-muted text-muted-foreground break-all">
                    {setupServer!.configTemplate.url}
                  </div>
                </div>
              )}

              {/* Registry entries: the credential comes from the connect flow
                  (or the paste fallback), never from a field here. */}
              {isRegistrySetup && (
                <RegistryConnectPanel compact className="rounded-md border border-border p-3" />
              )}

              {/* Placeholder headers: one labeled field per fillable header. */}
              {Object.entries(setupServer!.configTemplate.headers || {}).map(([k, v]) =>
                !isRegistrySetup && hasPlaceholder(v) ? (
                  <div key={`header-${k}`} className="space-y-2">
                    <Label htmlFor={`header-${k}`}>{k}</Label>
                    <Input
                      id={`header-${k}`}
                      value={setupHeaders[k] || ""}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setSetupHeaders((prev) => ({ ...prev, [k]: e.target.value }))
                      }
                      placeholder={String(v)}
                    />
                  </div>
                ) : null
              )}

              {/* Placeholder args: one labeled field per fillable arg, literals read-only. */}
              {tmplArgs.map((a, i) =>
                isPlaceholderArg(a) ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: args are an ordered list where duplicate values are legal; position is the identity
                  <div key={`arg-${i}`} className="space-y-2">
                    <Label htmlFor={`arg-${i}`}>{a}</Label>
                    <Input
                      id={`arg-${i}`}
                      value={setupArgs[i] || ""}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setSetupArgs((prev) => ({ ...prev, [i]: e.target.value }))
                      }
                      placeholder={a}
                    />
                  </div>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: see the placeholder branch above — position is the arg's identity
                  <div key={`arg-${i}`} className="space-y-2">
                    <Label>{t("extensions.mcp.fields.args")}</Label>
                    <div className="text-xs font-mono px-3 py-2 rounded-md bg-muted text-muted-foreground">
                      {a}
                    </div>
                  </div>
                )
              )}

              {/* Env keys: one labeled field per key, placeholder = template value. */}
              {tmplEnvKeys.map((k) => (
                <div key={`env-${k}`} className="space-y-2">
                  <Label htmlFor={`env-${k}`}>{k}</Label>
                  <Input
                    id={`env-${k}`}
                    value={setupEnv[k] || ""}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setSetupEnv((prev) => ({ ...prev, [k]: e.target.value }))
                    }
                    placeholder={setupServer!.configTemplate.env?.[k] || ""}
                  />
                </div>
              ))}
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label>{t("extensions.mcp.fields.type")}</Label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={type === "stdio"}
                      onChange={() => setType("stdio")}
                      disabled={isEdit}
                    />
                    <span className="text-sm">stdio</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={type === "http"}
                      onChange={() => setType("http")}
                      disabled={isEdit}
                    />
                    <span className="text-sm">http</span>
                  </label>
                </div>
              </div>

              {type === "stdio" ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="command">{t("extensions.mcp.fields.command")}</Label>
                    <Input
                      id="command"
                      value={command}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCommand(e.target.value)}
                      placeholder="npx"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="args">{t("extensions.mcp.fields.args")}</Label>
                    <Input
                      id="args"
                      value={args}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setArgs(e.target.value)}
                      placeholder="-y @modelcontextprotocol/server-memory"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="env">{t("extensions.mcp.fields.env")}</Label>
                    <Textarea
                      id="env"
                      value={env}
                      onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEnv(e.target.value)}
                      rows={4}
                      className="font-mono text-xs"
                      placeholder='{"API_KEY": "value"}'
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="url">{t("extensions.mcp.fields.url")}</Label>
                    <Input
                      id="url"
                      value={url}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
                      placeholder="https://example.com/mcp"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="headers">{t("extensions.mcp.fields.headers")}</Label>
                    <Textarea
                      id="headers"
                      value={headers}
                      onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setHeaders(e.target.value)}
                      rows={4}
                      className="font-mono text-xs"
                      placeholder='{"Authorization": "Bearer token"}'
                    />
                  </div>
                </>
              )}
            </>
          )}

          <div className="flex items-center gap-2">
            <Switch id="enabled" checked={enabled} onCheckedChange={setEnabled} />
            <Label htmlFor="enabled">{t("extensions.fields.enabled")}</Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={isSetup ? handleSetupSubmit : handleSubmit}
            disabled={loading || (isSetup && !setupValid)}
            data-testid="form-submit"
          >
            {loading && <Icon name="sparkles" size={14} className="animate-pulse" />}
            {loading ? t("common.saving") : isEdit ? t("common.save") : t("common.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
