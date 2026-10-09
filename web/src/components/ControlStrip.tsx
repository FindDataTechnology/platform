// ControlStrip — the composer's single control row, in two clusters:
//
//   left  (context)  : the `+` menu (attach a file / insert a command) and the
//                      permission chip
//   right (runtime)  : the model, the reasoning effort, the `⋯` overflow
//                      (workspace + agent, the two low-frequency long-label
//                      controls), and the send/stop control the composer passes
//                      in as `trailing`
//
// This is the SOLE surface for per-turn runtime configuration. Persistent
// configuration (which providers exist, what the default is) lives in Settings.
// That split is why the sidebar no longer carries a model chip or agent select.
//
// Workspace, model and effort change dsh runtime config, and dsh bakes config
// into the `initialize` handshake — there is no setModel/setCwd RPC. So each of
// those restarts the child process. That cost is deliberately visible: the
// changed control shows a spinner and the send button disables until the
// server's confirming broadcast lands (see `pendingConfig` in the store).
// Agent follows the same rule when the deployment serves that agent locally
// (a vertical pack is a persona preset, so its switch restarts the runtime);
// only a remote-fork agent switches without a restart.
//
// Nothing here holds optimistic local state. A control renders what the store
// says the runtime IS, not what was requested — so a dropdown briefly shows
// the old value after a click. That is correct: the strip reports reality.
//
// The `+` menu owns no upload path of its own: its attachment entry clicks the
// composer's file input, and its commands entry drives the same text-derived
// SlashCommandPicker the typed `/` path uses.

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAuthStore } from "@/hooks/useAuth";
import { useChatStore } from "@platform/core";
import { savePersonalModel } from "@platform/core";
import type { ClientMessage } from "@platform/core";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { OverlayPanel } from "@/components/OverlayPanel";
import { cn } from "@/lib/utils";

interface Props {
  send: (m: ClientMessage) => void;
  // Inserts "/" into the composer, which opens the existing SlashCommandPicker
  // through its normal text-derived path. The picker needs no click-mode.
  onOpenCommands: () => void;
  // Opens the composer's own file picker. The input (and the upload path it
  // feeds) stays in the composer — this menu only triggers it.
  onAttach: () => void;
  // The send/stop control, rendered as the row's rightmost element.
  trailing?: React.ReactNode;
}

// Shared popover shell for the menu-style controls. Dismisses on outside
// click, Escape, and selection — same behavior as the settings modal.
function StripMenu({
  label,
  value,
  icon,
  pending,
  disabled,
  testId,
  children,
}: {
  label: string;
  // Absent for icon-only triggers (the `+` button).
  value?: string;
  icon: React.ReactNode;
  pending?: boolean;
  disabled?: boolean;
  testId: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        data-pending={pending ? "true" : undefined}
        className={cn(
          "flex max-w-[14rem] items-center gap-1 rounded-md px-1.5 py-1 text-xs",
          "text-muted-foreground hover:bg-muted hover:text-foreground",
          "disabled:cursor-not-allowed disabled:opacity-40",
          open && "bg-muted text-foreground",
        )}
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : icon}
        {value !== undefined && <span className="truncate">{value}</span>}
        {value !== undefined && <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />}
      </button>
      {open && (
        <div
          role="menu"
          data-testid={`${testId}-menu`}
          className={cn(
            "absolute bottom-full left-0 z-50 mb-1 min-w-[17rem] max-w-[24rem]",
            "overflow-hidden rounded-md border border-border bg-popover shadow-lg",
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  active,
  disabled,
  onClick,
  primary,
  secondary,
  badge,
  testId = "strip-menu-item",
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  primary: string;
  secondary?: string;
  badge?: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={!!active}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-xs",
        "disabled:cursor-not-allowed disabled:opacity-40",
        active ? "bg-muted text-foreground" : "text-foreground hover:bg-muted/60",
      )}
    >
      <span className="flex w-full items-center gap-1.5">
        <span className="min-w-0 truncate font-mono">{primary}</span>
        {badge}
      </span>
      {secondary && <span className="w-full truncate text-[10px] text-muted-foreground">{secondary}</span>}
    </button>
  );
}

// Section header inside the overflow popover (two stacked sections, one
// popover — no nested menus).
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

// Shipped permission presets have localized labels/descriptions in the web
// bundles (the runtime table carries raw keys); anything else renders the
// server-provided label verbatim — the same rule the agent-preset picker uses.
const PERMISSION_I18N = {
  "read-only": "permissionReadonly",
  "workspace-write": "permissionWrite",
  "danger-full-access": "permissionFull",
} as const;

// The native folder picker exists only inside the Electron shell (exposed via
// the preload bridge); in a plain browser the path input is the only entry.
const CAN_PICK_NATIVE =
  typeof window !== "undefined" && typeof window.platform?.pickWorkdir === "function";

// The full-access risk gate. Selecting `danger-full-access` disables the
// sandbox and the approval prompts, so it is the one preset the client asks
// about first: nothing is sent until the acknowledgement is checked and
// confirmed. Cancel, Escape, and a mask click send nothing.
function FullAccessDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const [ack, setAck] = useState(false);

  // Each opening starts unacknowledged — the gate is per selection.
  useEffect(() => {
    if (open) setAck(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="full-access-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("composer.strip.permissionFull.confirmTitle")}
        className="max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{t("composer.strip.permissionFull.confirmTitle")}</DialogTitle>
          <DialogDescription>{t("composer.strip.permissionFull.confirmBody")}</DialogDescription>
        </DialogHeader>
        <label className="mt-4 flex items-start gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            data-testid="full-access-ack"
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
          />
          <span>{t("composer.strip.permissionFull.acknowledge")}</span>
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            data-testid="full-access-cancel"
            className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={!ack}
            onClick={onConfirm}
            data-testid="full-access-confirm"
            className={cn(
              "rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-primary-foreground",
              "hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            {t("composer.strip.permissionFull.confirm")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ControlStrip({ send, onOpenCommands, onAttach, trailing }: Props) {
  const { t } = useTranslation();
  const status = useChatStore((s) => s.status);
  const models = useChatStore((s) => s.models);
  const currentModel = useChatStore((s) => s.currentModel);
  const currentEffort = useChatStore((s) => s.currentEffort);
  const currentWorkspace = useChatStore((s) => s.currentWorkspace);
  const workspaceRecents = useChatStore((s) => s.workspaceRecents);
  const pendingConfig = useChatStore((s) => s.pendingConfig);
  const setPendingConfig = useChatStore((s) => s.setPendingConfig);
  const turns = useChatStore((s) => s.turns);
  const agents = useChatStore((s) => s.agents);
  const currentAgent = useChatStore((s) => s.currentAgent);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const permissionOptions = useChatStore((s) => s.permissionOptions);
  const currentPermission = useChatStore((s) => s.currentPermission);
  // Non-null only when the socket carries an identity the server can bind to.
  const userBindings = useChatStore((s) => s.userBindings);
  const runtimePending = useChatStore((s) => s.runtimePending);
  const ssoConfigured = useAuthStore((s) => s.ssoConfigured);
  const [bindingMsg, setBindingMsg] = useState<string | null>(null);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false);
  // The focused role whose 资源微调 dialog is open (add-focus-overlay). The
  // panel is preset-scoped, not agent-scoped: the diff applies whenever that
  // role is next selected, not only while it is live.
  const [overlayRole, setOverlayRole] = useState<{ id: string; name: string; packName?: string } | null>(null);

  // Pinning the model currently in effect is a separate, explicit act — the
  // picker above stays a global operation and never writes a personal row.
  const saveAsMyModel = async () => {
    const m = models.find((x) => x.id === currentModel);
    if (!m) return;
    setBindingMsg(null);
    setBindingError(null);
    try {
      const res = await savePersonalModel(m.provider ?? "", m.id);
      setBindingMsg(res.pending ? t("bindings.pending") : t("bindings.saved"));
    } catch (e) {
      setBindingError((e as Error).message);
    }
  };

  const agentLabel =
    agents.find((a) => a.id === currentAgent)?.name ??
    currentAgent ??
    t("composer.strip.agentUnset");

  const [pathDraft, setPathDraft] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);

  const disabled = status !== "connected" || pendingConfig !== null;

  // The effort control exists only for models that declare levels. A
  // permanently-disabled control teaches users to ignore this region.
  const efforts = models.find((m) => m.id === currentModel)?.reasoningEfforts ?? [];

  const switchWorkspace = (path: string, close: () => void) => {
    const next = path.trim();
    if (!next) return;
    // Validation proper is server-side; this catches the one mistake worth
    // catching before a round-trip.
    if (!next.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(next)) {
      setPathError(t("composer.strip.workspaceAbsolute"));
      return;
    }
    if (next === currentWorkspace) {
      close();
      return;
    }
    // Switching mid-conversation leaves the transcript referencing paths that
    // no longer resolve — make that the user's call, not a side effect.
    if (turns.length > 0 && !window.confirm(t("composer.strip.workspaceConfirm", { path: next }))) {
      return;
    }
    setPathError(null);
    setPathDraft("");
    setPendingConfig("workspace");
    send({ type: "set_workspace", path: next });
    close();
  };

  // Electron only: hand the picked folder to the same validation/confirm/
  // restart path as a typed one. A cancelled dialog resolves null — the menu
  // simply stays open.
  const browseWorkspace = async (close: () => void) => {
    const picked = await window.platform?.pickWorkdir();
    if (picked) switchWorkspace(picked, close);
  };

  // Chip label: localized name for known presets, the server label for any
  // user-defined table entry, `custom` when the knobs match no preset, and a
  // placeholder while no session has pinned a value yet.
  const permissionLabel = (name: string | null) => {
    if (!name) return t("composer.strip.permissionUnset");
    if (name === "custom") return t("composer.strip.permissionCustom");
    const known = PERMISSION_I18N[name as keyof typeof PERMISSION_I18N];
    return known ? t(`composer.strip.${known}.label`) : name;
  };

  // Full access is the one preset that goes through a risk gate; every other
  // preset applies on selection exactly as before.
  const choosePermission = (name: string, close: () => void) => {
    close();
    if (name === currentPermission) return;
    if (name === "danger-full-access") {
      setConfirmingFullAccess(true);
      return;
    }
    send({ type: "set_permission", name });
  };

  return (
    <div
      className="flex min-w-0 flex-1 items-center justify-between gap-2"
      data-testid="composer-control-strip"
    >
      {/* ── Left cluster: context and input affordances ───────────────────── */}
      <div className="flex min-w-0 items-center gap-0.5">
        {/* The `+` menu: the two ways to add something to a prompt. Attachment
            is first because it is the frequent one; commands keep the same
            text-derived picker the typed `/` path uses. */}
        <StripMenu
          label={t("composer.strip.add")}
          icon={<Plus className="h-4 w-4 shrink-0" />}
          disabled={disabled}
          testId="strip-plus"
        >
          {(close) => (
            <div className="py-1">
              <MenuItem
                testId="composer-attach"
                primary={t("composer.attach")}
                onClick={() => {
                  close();
                  onAttach();
                }}
              />
              <MenuItem
                testId="strip-commands"
                primary={t("composer.strip.commands")}
                onClick={() => {
                  close();
                  onOpenCommands();
                }}
              />
            </div>
          )}
        </StripMenu>

        {/* Permission preset (sandbox + approval bundle). Hidden until the
            roster arrives — a control showing nothing real teaches users to
            ignore the strip. Unlike every restart-carrying control above, a
            permission switch applies to the LIVE session, so there is no
            pending window and send stays enabled; the chip re-renders when the
            confirming current_permission broadcast lands. The current value can
            be `custom` (knobs match no preset) — shown, never switchable. */}
        {permissionOptions.length > 0 && (
          <StripMenu
            label={t("composer.strip.permission")}
            value={permissionLabel(currentPermission)}
            icon={<ShieldCheck className="h-3.5 w-3.5 shrink-0" />}
            disabled={status !== "connected" || isStreaming}
            testId="strip-permission"
          >
            {(close) => (
              <div className="max-h-72 overflow-y-auto py-1">
                {permissionOptions.map((o) => {
                  const known = PERMISSION_I18N[o.name as keyof typeof PERMISSION_I18N];
                  return (
                    <MenuItem
                      key={o.name}
                      active={o.name === currentPermission}
                      primary={known ? t(`composer.strip.${known}.label`) : o.label}
                      secondary={known ? t(`composer.strip.${known}.desc`) : o.description || undefined}
                      onClick={() => choosePermission(o.name, close)}
                    />
                  );
                })}
              </div>
            )}
          </StripMenu>
        )}
      </div>

      {/* ── Right cluster: runtime configuration, then send/stop ──────────── */}
      <div className="flex shrink-0 items-center gap-0.5">
        <StripMenu
          label={t("composer.strip.model")}
          value={currentModel || t("composer.strip.modelUnset")}
          icon={<Sparkles className="h-3.5 w-3.5 shrink-0" />}
          pending={pendingConfig === "model"}
          disabled={disabled || models.length === 0}
          testId="strip-model"
        >
          {(close) => (
            <div className="max-h-72 overflow-y-auto py-1">
              {userBindings
                ? currentModel && (
                    <div className="border-b border-border px-3 py-2">
                      <button
                        type="button"
                        data-testid="strip-save-model"
                        onClick={saveAsMyModel}
                        className="text-xs font-medium text-primary hover:underline"
                      >
                        {t("bindings.saveAsMyModel")}
                      </button>
                      {userBindings.model && (
                        <div className="mt-1 text-[10px] text-muted-foreground" data-testid="strip-model-source">
                          {userBindings.model.source === "personal"
                            ? t("bindings.myModel")
                            : t("bindings.globalSource")}
                        </div>
                      )}
                      {runtimePending && (
                        <div className="mt-1 text-[10px] text-warning" data-testid="strip-model-pending">
                          {t("bindings.pending")}
                        </div>
                      )}
                      {bindingMsg && <div className="mt-1 text-[10px] text-muted-foreground">{bindingMsg}</div>}
                      {bindingError && <div className="mt-1 text-[10px] text-destructive">{bindingError}</div>}
                    </div>
                  )
                : ssoConfigured && (
                    <div className="border-b border-border px-3 py-2">
                      <Link
                        to="/login"
                        data-testid="strip-model-signin"
                        className="text-xs font-medium text-primary hover:underline"
                      >
                        {t("bindings.signIn")}
                      </Link>
                    </div>
                  )}
              {models.map((m) => (
                <MenuItem
                  key={m.id}
                  active={m.id === currentModel}
                  primary={m.id}
                  secondary={m.provider}
                  onClick={() => {
                    close();
                    if (m.id === currentModel) return;
                    setPendingConfig("model");
                    send({ type: "set_model", id: m.id });
                  }}
                />
              ))}
            </div>
          )}
        </StripMenu>

        {efforts.length > 0 && (
          <StripMenu
            label={t("composer.strip.effort")}
            value={currentEffort || t("composer.strip.effortDefault")}
            icon={<SlidersHorizontal className="h-3.5 w-3.5 shrink-0" />}
            pending={pendingConfig === "effort"}
            disabled={disabled}
            testId="strip-effort"
          >
            {(close) => (
              <div className="py-1">
                {efforts.map((e) => (
                  <MenuItem
                    key={e}
                    active={e === currentEffort}
                    primary={e}
                    onClick={() => {
                      close();
                      if (e === currentEffort) return;
                      setPendingConfig("effort");
                      send({ type: "set_effort", effort: e });
                    }}
                  />
                ))}
              </div>
            )}
          </StripMenu>
        )}

        {/* Overflow: the workspace and the agent — both low-frequency, and the
            workspace's value is a path basename of unbounded length. They share
            one popover as two labeled sections (no nested menus, one open/close
            state machine). The agent section is omitted for a single-agent
            deployment: a control showing one unchangeable value is noise, and
            the catalog is optional. */}
        <StripMenu
          label={t("composer.strip.more")}
          icon={<MoreHorizontal className="h-4 w-4 shrink-0" />}
          // A workspace switch restarts the child; its control lives in here
          // now, so the overflow trigger is what carries the pending spinner.
          pending={pendingConfig === "workspace"}
          disabled={disabled}
          testId="strip-more"
        >
          {(close) => (
            <div className="max-h-80 overflow-y-auto py-1">
              <div className="border-b border-border py-1">
                <SectionLabel>{t("composer.strip.workspace")}</SectionLabel>
                <div data-testid="strip-workspace">
                  {currentWorkspace && (
                    <div className="px-3 pb-1 text-[10px] text-muted-foreground">
                      <span className="break-all font-mono">{currentWorkspace}</span>
                    </div>
                  )}
                  {workspaceRecents.filter((p) => p !== currentWorkspace).length > 0 && (
                    <div className="py-1">
                      <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        {t("composer.strip.workspaceRecents")}
                      </div>
                      {workspaceRecents
                        .filter((p) => p !== currentWorkspace)
                        .map((p) => (
                          <MenuItem key={p} onClick={() => switchWorkspace(p, close)} primary={p} />
                        ))}
                    </div>
                  )}
                  {/* In a plain browser, picking a server-side directory is
                      impossible — typing the absolute path once is the cost, and
                      the recents list above pays it back. Inside the Electron
                      shell the browse button opens the native picker instead. */}
                  <div className="p-2">
                    <input
                      type="text"
                      value={pathDraft}
                      onChange={(e) => {
                        setPathDraft(e.target.value);
                        if (pathError) setPathError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          switchWorkspace(pathDraft, close);
                        }
                      }}
                      placeholder={t("composer.strip.workspacePlaceholder")}
                      aria-label={t("composer.strip.workspacePlaceholder")}
                      data-testid="strip-workspace-input"
                      className={cn(
                        "w-full rounded-md border bg-background px-2 py-1 font-mono text-xs outline-none",
                        pathError ? "border-destructive" : "border-border focus:border-primary",
                      )}
                    />
                    {pathError && (
                      <p data-testid="strip-workspace-error" className="mt-1 text-[10px] text-destructive">
                        {pathError}
                      </p>
                    )}
                    {CAN_PICK_NATIVE && (
                      <button
                        type="button"
                        onClick={() => void browseWorkspace(close)}
                        data-testid="strip-workspace-browse"
                        className="mt-1 flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <FolderOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {t("composer.strip.workspaceBrowse")}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {agents.length > 1 && (
                <div className="py-1">
                  <SectionLabel>{t("composer.strip.agent")}</SectionLabel>
                  <div
                    data-testid="strip-agent"
                    className="px-3 pb-1 text-[10px] text-muted-foreground"
                  >
                    <span className="break-all font-mono">{agentLabel}</span>
                  </div>
                  {agents.map((a) => (
                    // A pack role runs focused on its own resource set, so it
                    // also carries the 资源微调 affordance — a sibling button,
                    // never nested inside the select control (add-focus-
                    // overlay D4). It opens the role's diff dialog; applying
                    // follows the next-session contract.
                    <div key={a.id} className="flex items-center gap-0.5">
                      <div className="min-w-0 flex-1">
                        <MenuItem
                          active={a.id === currentAgent}
                          disabled={isStreaming}
                          primary={a.name || a.id}
                          secondary={a.name ? a.id : undefined}
                          badge={
                            a.packId || a.customPreset ? (
                              // Focused roles run on their OWN resource set —
                              // pack personas (add-persona-resource-sets D5)
                              // and custom presets (add-custom-presets D5)
                              // alike — marked with the role-level summary
                              // (skill/MCP counts of the effective set) so the
                              // cost of the choice is visible before the switch.
                              <span
                                data-testid="strip-agent-focus-badge"
                                title={a.packId ?? a.id}
                                className="ml-auto shrink-0 rounded-sm border border-primary/40 bg-primary/10 px-1 py-px text-[9px] font-medium leading-tight text-primary"
                              >
                                {a.customPreset
                                  ? t("composer.strip.agentFocusedCustom", {
                                      skills: a.resourceSummary?.skillCount ?? 0,
                                      mcp: a.resourceSummary?.mcpCount ?? 0,
                                    })
                                  : t("composer.strip.agentFocused", {
                                      pack: a.packName || a.packId,
                                      skills: a.resourceSummary?.skillCount ?? 0,
                                      mcp: a.resourceSummary?.mcpCount ?? 0,
                                    })}
                              </span>
                            ) : undefined
                          }
                          testId="strip-agent-option"
                          onClick={() => {
                            close();
                            if (a.id === currentAgent) return;
                            // An agent the deployment serves locally (a vertical
                            // pack) applies its persona through the preset switch,
                            // which restarts the runtime — so this control waits for
                            // `agent_changed` like the model/workspace ones do. A
                            // remote-fork agent answers immediately.
                            setPendingConfig("agent");
                            send({ type: "set_agent", id: a.id });
                          }}
                        />
                      </div>
                      {(a.packId || a.customPreset) && (
                        <button
                          type="button"
                          onClick={() => {
                            close();
                            setOverlayRole({ id: a.id, name: a.name || a.id, packName: a.packName });
                          }}
                          aria-label={t("overlay.adjust")}
                          title={t("overlay.adjust")}
                          data-testid={`strip-agent-adjust-${a.id}`}
                          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </StripMenu>

        {trailing}
      </div>

      <FullAccessDialog
        open={confirmingFullAccess}
        onOpenChange={setConfirmingFullAccess}
        onConfirm={() => {
          setConfirmingFullAccess(false);
          send({ type: "set_permission", name: "danger-full-access" });
        }}
      />

      <OverlayPanel
        role={overlayRole}
        open={overlayRole !== null}
        onOpenChange={(o) => {
          if (!o) setOverlayRole(null);
        }}
      />
    </div>
  );
}
