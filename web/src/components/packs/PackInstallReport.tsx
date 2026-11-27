// ── 安装结果报告（pack-detail-as-page 6.x）─────────────────────────────────────
//
// 订阅发生在哪，报告就出现在哪。原先是市场页弹窗的 onSubscribed 回调里内联渲染的
// 125 行；订阅挪到详情页之后，那段内联代码会变成永远打不到的死码，所以抽成共享
// 组件：市场页（订阅后回到市场的老路径）与详情页（订阅当下）挂的是同一份。
//
// 边界仍是弹窗版的那几条：`report.connector` 只有声明了 connector_bindings 的包才
// 有（无声明 → 整个块不存在，与从前逐字节一致）；bot 的「等待凭据」是信息不是错误；
// `pendingGrant` 行不得借用设置面板的「已连接」措辞。
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import type { PackConnectorBindingReport, PackConnectorReport, PackReport } from "@/lib/packs-api";

function statusLabel(t: (k: string) => string, status: string) {
  const key = `packs.report.status.${status}`;
  const label = t(key);
  return label === key ? status : label;
}

/** One rendered row of the install-time connector gate. `kind` is what the
 *  row means (not what the ledger says): a `pendingGrant` row is *satisfied*
 *  yet unusable until the one-click grant, so it must not borrow the
 *  "已连接" wording the settings panel reserves for usable bindings. */
type ConnectorReportRow = {
  kind: "unresolved" | "pendingGrant" | "optionalUnmet";
  row: PackConnectorBindingReport;
};

function connectorReportRows(connector: PackConnectorReport): ConnectorReportRow[] {
  const out: ConnectorReportRow[] = [];
  const seen = new Set<string>();
  // Order is the customer's order of business: required-and-missing first,
  // then one click away, then the optional ones that only degrade.
  for (const kind of ["unresolved", "pendingGrant", "optionalUnmet"] as const) {
    for (const row of connector[kind] ?? []) {
      if (!row?.bindingKey) continue;
      const id = `${kind}\u0000${row.bindingKey}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ kind, row });
    }
  }
  return out;
}

/**
 * The install report's connector block. Rendered only when the manifest
 * declared `connector_bindings` (the server then always sets
 * `report.connector` — including on a gate failure, where we say "unknown"
 * instead of claiming either state: the install succeeded, we just do not know).
 *
 * Exported for the render check (`scripts/test-connector-report-render.mjs`),
 * which mounts it through react-dom/server — the same proof style used for the
 * pre-install block, because "it type-checks" says nothing about what a
 * customer reads.
 */
export function ConnectorReportBlock({ connector }: { connector: PackConnectorReport }) {
  const { t } = useTranslation();
  const rows = connectorReportRows(connector);
  // Only non-optional rows block use; optional-unmet ones are degradations.
  const open = rows.filter((r) => r.kind !== "optionalUnmet");
  const required = connector.required ?? 0;
  const headline = connector.error
    ? t("packs.report.connector.unknown")
    : open.length > 0
      ? t("packs.report.connector.pending", { count: open.length })
      : required > 0
        ? t("packs.report.connector.ready")
        : t("packs.report.connector.readyOptional");
  return (
    <div className="mt-3 space-y-1 border-t border-border pt-3" data-testid="pack-report-connector">
      <div className="flex gap-2">
        <span className="text-muted-foreground w-20 shrink-0">{t("packs.report.connector.title")}</span>
        <span
          className={connector.error || open.length > 0 ? "text-foreground" : "text-muted-foreground"}
          data-testid="pack-report-connector-summary"
          data-connected={String(connector.connected)}
          data-open={String(open.length)}
          // The raw gate error is for whoever debugs the install; the customer
          // gets the honest "we could not tell".
          title={connector.error || undefined}
        >
          {headline}
        </span>
      </div>
      {rows.map(({ kind, row }) => (
        <div
          key={`${kind}-${row.bindingKey}`}
          className="flex flex-wrap gap-x-2 gap-y-1"
          data-testid={`pack-report-connector-${row.bindingKey}`}
          data-kind={kind}
          data-state={row.status ?? "satisfied"}
        >
          <span className="w-20 shrink-0" />
          <span className="text-foreground">{row.provider || row.bindingKey}</span>
          {row.provider && row.provider !== row.bindingKey && (
            <span className="font-mono text-xs text-muted-foreground">{row.bindingKey}</span>
          )}
          {(row.operations ?? []).length > 0 && (
            <span className="text-xs text-muted-foreground">
              {(row.operations ?? [])
                .map((op) => t(`settings.connections.bindings.operations.${op}`, { defaultValue: op }))
                .join("·")}
            </span>
          )}
          {row.optional && kind === "optionalUnmet" && (
            <span className="text-xs text-muted-foreground">{t("settings.connections.bindings.optional")}</span>
          )}
          <span className="ml-auto text-xs">
            {kind === "pendingGrant"
              ? t("packs.report.connector.needsGrant")
              : t(`settings.connections.bindings.state.${row.status ?? "satisfied"}`, {
                  defaultValue: row.status ?? "satisfied",
                })}
          </span>
          {row.reason && <span className="w-full text-xs text-muted-foreground">{row.reason}</span>}
        </div>
      ))}
      <p className="text-xs text-muted-foreground" data-testid="pack-report-connector-hint">
        {t("packs.report.connector.hint")}
      </p>
    </div>
  );
}

export function PackInstallReport({
  report,
  packName,
  connector,
  onClose,
  footer,
}: {
  report: PackReport;
  packName: string;
  /** `report.connector` lifted out so the caller's gate reads the same field
   *  the block does — passing the whole report would let the two drift. */
  connector: PackConnectorReport | null;
  onClose: () => void;
  /** Host-supplied next-steps footer (the routing-dependent piece). Absent ⇒
   *  the report ends at the close button. */
  footer?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      data-testid="pack-install-report"
      onClick={onClose}
    >
      <div
        className="bg-background border border-border rounded-lg max-w-lg w-full max-h-[80vh] overflow-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold text-foreground mb-1">{t("packs.report.title", { name: packName })}</h3>
        <p className="text-xs text-muted-foreground mb-3">{t("packs.report.hint")}</p>
        <div className="space-y-1 text-sm">
          {report.skills.map((s) => (
            <div key={s.name} className="flex gap-2">
              <span className="text-muted-foreground w-20 shrink-0">{t("packs.report.skill")}</span>
              <span className="text-foreground">{s.name}</span>
              <span className="ml-auto">{statusLabel(t, s.status)}</span>
              {s.reason && <span className="text-xs text-destructive w-full">{s.reason}</span>}
              {/* Disclosure (add-packaged-skills 5.2): tree skills state
                  their file count and name their script files. */}
              {s.fileCount != null && (
                <span className="text-xs text-muted-foreground w-full" data-testid={`pack-report-files-${s.name}`}>
                  {s.scriptFiles?.length
                    ? t("packs.report.filesWithScripts", {
                        count: s.fileCount,
                        scripts: s.scriptFiles.join("、"),
                      })
                    : t("packs.report.files", { count: s.fileCount })}
                </span>
              )}
            </div>
          ))}
          {report.mcpServers.map((m) => (
            <div key={m.name} className="flex gap-2">
              <span className="text-muted-foreground w-20 shrink-0">{t("packs.report.mcp")}</span>
              <span className="text-foreground">{m.name}</span>
              <span className="ml-auto">{statusLabel(t, m.status)}</span>
              {m.reason && <span className="text-xs text-destructive w-full">{m.reason}</span>}
            </div>
          ))}
          {report.agents.map((a) => (
            <div key={a.id} className="flex gap-2">
              <span className="text-muted-foreground w-20 shrink-0">{t("packs.report.agent")}</span>
              <span className="text-foreground">{a.name}</span>
              <span className="ml-auto">{statusLabel(t, a.status)}</span>
              {a.reason && <span className="text-xs text-destructive w-full">{a.reason}</span>}
            </div>
          ))}
          {/* Bot units (pack-bot-units): mirror the agents rows; an
              awaiting-credential bot is information, not an error — the
              operator's channel setup is the explicit next step. */}
          {(report.bots ?? []).map((b) => (
            <div key={b.id} className="flex gap-2" data-testid={`pack-report-bot-${b.id}`}>
              <span className="text-muted-foreground w-20 shrink-0">{t("packs.report.bot")}</span>
              <span className="text-foreground">{b.name}</span>
              <span className="ml-auto">{statusLabel(t, b.status)}</span>
              {b.reason && <span className="text-xs text-muted-foreground w-full">{b.reason}</span>}
            </div>
          ))}
          {/* Connector bindings (add-connector-bindings D7): install resolves
              the declared external systems per identity and the server's
              report carries one entry per unmet binding *so that the surface
              can render one row per binding with the right fix* — that
              surface did not exist until now, so a required binding left
              unconnected read as "installed, ready". A pack without
              declarations carries no `report.connector` and this block does
              not exist (byte-identical to before). */}
          {connector && <ConnectorReportBlock connector={connector} />}
        </div>
        <div className="flex justify-end mt-4">
          <Button size="sm" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
        {footer}
      </div>
    </div>
  );
}
