// MemoryDrawer.tsx — 萬星 console 部署者记忆浏览（add-unified-memory-and-outputs
// 4.1, spec: memory-portal-ui「萬星 console 部署者记忆浏览」）。部署者看自己
// 部署的记忆根（d-<packId>，project=<agentId>），经 /api/memory/deployer-entries
// 的 platform lane，与壹座面板共用同一 visibility 读面语义。

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getPackDeclaration, getPackPolicy, listDeployerMemoryEntries, type MemoryEntry, type PackDeclaration, type PackPolicy } from "@/api/memory";

const LAYERS = ["L0", "L1", "L2"] as const;

export function MemoryDrawer({
  agentId,
  packId,
  onClose,
}: {
  agentId: string | null;
  packId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<MemoryEntry[]>([]);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [layer, setLayer] = useState<string | null>(null);

  const [policy, setPolicy] = useState<PackPolicy | null>(null);
  const [policyDegraded, setPolicyDegraded] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);

  // The pack's own declaration (fix-memory-axes-executed-truth). Deliberately a
  // SEPARATE load from the policy: this is computed from the installed manifest, so
  // it still renders while the memory service is down — and it is the only place a
  // "declared but nothing executes it" row can appear for the author-side axes,
  // because the service never stores those.
  const [declaration, setDeclaration] = useState<PackDeclaration | null>(null);
  const [declarationDegraded, setDeclarationDegraded] = useState(false);

  const rootKey = packId ? `d-${packId}` : null;
  const scope = agentId || undefined;

  const load = useCallback(async () => {
    if (!rootKey) return;
    setLoading(true);
    setDegraded(null);
    try {
      const out = await listDeployerMemoryEntries(rootKey, { scope, layer: layer ?? undefined, limit: 100 });
      setItems(out.items);
    } catch {
      setDegraded(t("memory.degraded.unavailable"));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [rootKey, scope, layer, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Pack memory policy (add-pack-memory-declaration 3.4). Loaded on demand: the
  // entries list is what a deployer opens this drawer for, and the policy is a
  // four-row table they consult occasionally. A failure degrades to a line —
  // the drawer still browses.
  useEffect(() => {
    if (!packId || !policyOpen) return;
    let alive = true;
    setPolicyDegraded(false);
    void getPackPolicy(packId)
      .then((doc) => { if (alive) setPolicy(doc); })
      .catch(() => { if (alive) { setPolicy(null); setPolicyDegraded(true); } });
    void getPackDeclaration(packId)
      .then((doc) => { if (alive) setDeclaration(doc); })
      .catch(() => { if (alive) { setDeclaration(null); setDeclarationDegraded(true); } });
    return () => { alive = false; };
  }, [packId, policyOpen]);

  return (
    <div className="flex h-full flex-col" data-testid="fleet-memory-drawer">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="text-sm font-semibold">{t("memory.deployer.title")}</div>
        <button className="text-xs text-muted-foreground hover:text-foreground" onClick={onClose} data-testid="fleet-memory-close">
          {t("memory.deployer.close")}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-4 py-2">
        {([null, ...LAYERS] as const).map((l) => (
          <button
            key={String(l)}
            className={`rounded-md px-2 py-0.5 text-xs ${layer === l ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted"}`}
            onClick={() => setLayer(l)}
            data-testid={`fleet-memory-layer-${l ?? "all"}`}
          >
            {l ?? t("memory.all")}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">{rootKey ?? "—"}{scope ? ` / ${scope}` : ""}</span>
      </div>
      {/* Pack memory policy (add-pack-memory-declaration 3.4): the four columns
          an operator needs to catch "declared but not in force". Collapsed by
          default — the entries list is the drawer's job, the policy is a table
          you consult. The scope line is not decoration: this row is keyed by
          PACK, so the same document governs every team landed from it. */}
      {rootKey ? (
        <div className="border-b border-border px-4 py-2" data-testid="fleet-memory-policy">
          <button
            className="flex w-full items-center justify-between text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setPolicyOpen((v) => !v)}
            data-testid="fleet-memory-policy-toggle"
          >
            <span>{t("memory.policy.title")}</span>
            <span className="font-mono">{policyOpen ? "−" : "+"}</span>
          </button>

          {policyOpen ? (
            policyDegraded ? (
              <div className="mt-2 text-xs text-muted-foreground" data-testid="fleet-memory-policy-degraded">
                {t("memory.policy.degraded")}
              </div>
            ) : !policy ? (
              <div className="mt-2 text-xs text-muted-foreground">{t("memory.loading")}</div>
            ) : (
              <div className="mt-2 space-y-2">
                {/* What the pack ASKS FOR (from its installed manifest). Rendered
                    above the stored policy on purpose: a reader who sees only the
                    table below would conclude the pack declared nothing, when in
                    fact the service simply never stores the author-side axes. */}
                <div className="text-[11px] font-medium text-foreground" data-testid="fleet-memory-declaration-title">
                  {t("memory.declaration.title")}
                </div>
                {declarationDegraded ? (
                  <div className="text-[11px] text-muted-foreground" data-testid="fleet-memory-declaration-degraded">
                    {t("memory.declaration.degraded")}
                  </div>
                ) : !declaration ? (
                  <div className="text-[11px] text-muted-foreground">{t("memory.loading")}</div>
                ) : (
                  <div className="space-y-1">
                    <table className="w-full table-fixed text-[11px]" data-testid="fleet-memory-declaration-table">
                      <thead>
                        <tr className="text-muted-foreground">
                          <th className="w-[26%] truncate text-left font-normal">{t("memory.policy.col.key")}</th>
                          <th className="w-[22%] truncate text-left font-normal">{t("memory.policy.col.declared")}</th>
                          <th className="w-[24%] truncate text-left font-normal">{t("memory.policy.col.inherited")}</th>
                          <th className="w-[28%] truncate text-left font-normal">{t("memory.policy.col.effective")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(declaration.rows ?? {}).map(([key, row]) => (
                          <tr key={key} className="border-t border-border/60" data-testid={`fleet-memory-declaration-row-${key}`}>
                            <td className="truncate py-1 pr-1 font-mono">{key}</td>
                            <td className="truncate py-1 pr-1">
                              {row.declared === null ? <span className="text-muted-foreground">{t("memory.policy.unset")}</span> : String(row.declared)}
                            </td>
                            <td className="truncate py-1 pr-1 text-muted-foreground">{row.inherited_from ?? "—"}</td>
                            <td className="min-w-0 py-1">
                              <span className="block truncate">{row.effective === null ? "—" : String(row.effective)}</span>
                              {row.executed ? null : (
                                <span className="ml-1 inline-block max-w-[6rem] truncate rounded-sm bg-warning/15 px-1 align-middle text-[10px] text-warning" data-testid={`fleet-memory-declaration-unexecuted-${key}`}>
                                  {t("memory.policy.notExecuted")}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {declaration.not_executed?.length ? (
                      <div className="text-[10px] text-muted-foreground" data-testid="fleet-memory-declaration-summary">
                        {t("memory.declaration.unexecutedList", { keys: declaration.not_executed.join(", ") })}
                      </div>
                    ) : null}
                    <div className="text-[10px] text-muted-foreground" data-testid="fleet-memory-declaration-hint">
                      {t("memory.declaration.hint")}
                    </div>
                  </div>
                )}
                <div className="text-[11px] font-medium text-foreground">{t("memory.policy.title")}</div>
                <div className="text-[11px] text-muted-foreground" data-testid="fleet-memory-policy-scope">
                  {t("memory.policy.scope", { root: policy.policy_root ?? rootKey })}
                </div>
                {/* One table, four columns. Rendered with fixed text sizes and
                    `truncate` so a 390px drawer cannot push a column out of the
                    card — the narrow-screen case a wide flex row would break. */}
                <table className="w-full table-fixed text-[11px]" data-testid="fleet-memory-policy-table">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="w-[26%] truncate text-left font-normal">{t("memory.policy.col.key")}</th>
                      <th className="w-[22%] truncate text-left font-normal">{t("memory.policy.col.declared")}</th>
                      <th className="w-[24%] truncate text-left font-normal">{t("memory.policy.col.inherited")}</th>
                      <th className="w-[28%] truncate text-left font-normal">{t("memory.policy.col.effective")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(policy.rows ?? {}).map(([key, row]) => (
                      <tr key={key} className="border-t border-border/60" data-testid={`fleet-memory-policy-row-${key}`}>
                        <td className="truncate py-1 pr-1 font-mono">{key}</td>
                        <td className="truncate py-1 pr-1">
                          {row.declared === null ? <span className="text-muted-foreground">{t("memory.policy.unset")}</span> : String(row.declared)}
                        </td>
                        <td className="truncate py-1 pr-1 text-muted-foreground">{row.inherited_from ?? "—"}</td>
                        {/* `min-w-0` + truncate on the VALUE, and badges that can
                            clip: an error code like
                            `policy_cold_after_days_invalid` has no break
                            opportunity and measurably pushed this table 107px
                            past a 390px drawer before it was bounded. */}
                        <td className="min-w-0 py-1">
                          <span className="block truncate">{row.effective === null ? "—" : String(row.effective)}</span>
                          {/* "executed: false" is the whole point of the column:
                              a declared value with no consumer must never read as
                              in force. The colour comes from the status
                              vocabulary — status-waiting IS the amber token
                              (--color-warning) — never a palette shade, same
                              posture as the invalid badge below (destructive). */}
                          {row.executed ? null : (
                            <span className="ml-1 inline-block max-w-[6rem] truncate rounded-sm bg-status-waiting/15 px-1 align-middle text-[10px] text-status-waiting" data-testid={`fleet-memory-policy-unexecuted-${key}`}>
                              {t("memory.policy.notExecuted")}
                            </span>
                          )}
                          {row.invalid ? (
                            <span className="ml-1 inline-block max-w-[6rem] truncate rounded-sm bg-destructive/15 px-1 align-middle text-[10px] text-destructive" title={row.invalid.message} data-testid={`fleet-memory-policy-invalid-${key}`}>
                              {row.invalid.code}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {policy.stored_invalid?.length ? (
                  <div className="space-y-0.5 text-[10px] text-destructive" data-testid="fleet-memory-policy-stored-invalid">
                    {policy.stored_invalid.map((e) => (
                      <div key={`${e.level}:${e.key}`} className="truncate" title={e.message}>
                        {e.level} · {e.key} · {e.code}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!rootKey ? (
          <div className="text-sm text-muted-foreground" data-testid="fleet-memory-nopack">
            {t("memory.deployer.noPack")}
          </div>
        ) : degraded ? (
          <div className="text-sm text-muted-foreground" data-testid="fleet-memory-degraded">{degraded}</div>
        ) : loading ? (
          <div className="text-sm text-muted-foreground">{t("memory.loading")}</div>
        ) : items.length === 0 ? (
          <div className="text-sm text-muted-foreground" data-testid="fleet-memory-empty">{t("memory.deployer.empty")}</div>
        ) : (
          <div className="space-y-2">
            {items.map((it) => (
              <div key={it.path} className="rounded-md border border-border px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{it.layer}·{it.type ?? "page"}</span>
                  {it.tier && it.tier !== "draft" ? (
                    // 正典（canonical）= 钉住/被分享/被 prompt 召回/同题终审胜出,
                    // 是最高一级 —— 原来用 amber（= status-waiting/warning）读起来
                    // 像"有问题"。按状态语汇改成正典=status-running（在册/生效）,
                    // 其余层级仍是 primary,两者靠色相区分而不是靠"有色 vs 无色"。
                    <span className={`rounded-full px-2 py-0.5 text-xs border ${it.tier === "canonical" ? "border-status-running/50 bg-status-running/10 text-status-running" : "border-primary/40 bg-primary/10 text-primary"}`}>
                      {t(`resources.memory.tier.${it.tier}`)}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-sm">{it.title}</span>
                  <span className="text-xs text-muted-foreground">{String(it.ts ?? "").slice(0, 10)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
