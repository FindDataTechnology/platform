// FleetTemplateWizard — 市场集群模板卡 → 默认参数向导 → 实化 → 点燃的动作链
// (add-fleet-owner-surface 装作路径)。
//
// 链的真实顺序（全部走既有面, 无任何新契约）:
//   付费门(若待成交) → 订阅+安装(若未装) → from-template(参数槽) → 点燃(显式)
// 每一步失败如实分类、零静默放行: 参数不合在表单上拦, 服务端 422 指名槽,
// 装前闸 402 走市场面错误文案的种类链。无参数槽的模板直达末尾（与落地前
// 同形状）。

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/lib/packs-api";
import type { PackDetail } from "@/lib/packs-api";
import * as owner from "@/lib/fleet-owner-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ParamDecl = {
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  options?: string[];
  default?: unknown;
  required?: boolean;
  label?: string;
};

export function FleetTemplateWizard({ pack, onCancel, onDone }: {
  pack: PackDetail;
  onCancel: () => void;
  onDone: (fleetId: string | null) => void;
}) {
  const { t } = useTranslation();
  const params = ((pack.manifest?.fleet as { params?: ParamDecl[] } | undefined)?.params ?? []) as ParamDecl[];
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(params.filter((p) => p.default !== undefined).map((p) => [p.name, p.default])),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"form" | "running" | "done">("form");
  const [log, setLog] = useState<{ id: number; text: string }[]>([]);
  const logSeq = useRef(0);
  const [fleetId, setFleetId] = useState<string | null>(null);
  const [lit, setLit] = useState<boolean>(false);
  const [startError, setStartError] = useState<string | null>(null);

  const push = (line: string) =>
    setLog((l) => {
      logSeq.current += 1;
      return [...l, { id: logSeq.current, text: line }];
    });

  const setField = (p: ParamDecl, raw: string | boolean) => {
    if (p.type === "boolean") setDraft((d) => ({ ...d, [p.name]: raw === true }));
    else if (p.type === "number") {
      setDraft((d) => {
        const v = String(raw).trim();
        const n = Number(v);
        const next = { ...d };
        if (v === "") delete next[p.name];
        else if (Number.isFinite(n)) next[p.name] = n;
        else next[p.name] = raw; // 交给服务端如实指错（类型不合）
        return next;
      });
    } else setDraft((d) => ({ ...d, [p.name]: String(raw) }));
  };

  const validateLocal = () => {
    for (const p of params) {
      if (p.required && p.default === undefined) {
        const v = draft[p.name];
        if (v === undefined || v === null || String(v).trim() === "") return p.name;
      }
    }
    return null;
  };

  const run = async () => {
    const missing = validateLocal();
    if (missing) {
      setFormError(t("packs.wizard.missingParam", { name: missing }));
      return;
    }
    setFormError(null);
    setPhase("running");
    try {
      // 付费门: 未成交的付费模板先买(读闸在用户点击装作之前已近闸, 此处二次
      // 执行幂等)。
      if (pack.pricing && pack.purchased !== true) {
        push(t("packs.wizard.stepPay"));
        await api.purchasePack(pack.id, true);
      }
      // 订阅+安装(未装时): 装的是版本快照, 与"市场=唯一分发通道"纪律一致。
      const installed = await api.listInstalledPacks();
      if (!installed.packs.some((p) => p.packId === pack.id)) {
        push(t("packs.wizard.stepInstall"));
        const sub = await api.subscribePack(pack.id);
        await api.installPack(sub.packId, sub.version);
      }
      push(t("packs.wizard.stepProvision"));
      const res = await owner.provisionFromTemplate(pack.id, params.length ? draft : null);
      if (res.status === 422 || res.body?.code === "params-invalid") {
        setPhase("form");
        const first = res.body?.errors?.[0];
        setFormError(first ? t("packs.wizard.paramInvalidServer", { name: first.name, reason: first.error }) : (res.body?.error ?? t("packs.wizard.paramInvalidServer")));
        return;
      }
      if (!res.body?.ok) {
        push(`✗ ${res.body?.error ?? "provision failed"}`);
        return;
      }
      setFleetId(res.body.fleet?.id ?? null);
      if (res.body.missing?.length) push(t("packs.wizard.missingTargets", { n: res.body.missing.length }));
      if (res.body.conflicts?.length) push(t("packs.wizard.conflictTargets", { n: res.body.conflicts.length }));
      setPhase("done");
    } catch (err) {
      push(`✗ ${(err as Error).message}`);
    }
  };

  const ignite = async () => {
    if (!fleetId) return;
    setStartError(null);
    try {
      await owner.startFleet(fleetId);
      setLit(true);
    } catch (err) {
      // 点燃失败(配额过闸/权限等) 如实分类呈现 — 不生假在跑。
      setStartError((err as Error).message);
    }
  };

  return (
    <section className="border border-primary/30 bg-primary/5 rounded-md p-3 space-y-3" data-testid="fleet-wizard">
      <div className="flex items-center justify-between">
        <h4 className="font-medium">{t("packs.wizard.title")}</h4>
        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={onCancel} data-testid="fleet-wizard-cancel">
          {t("packs.wizard.cancel")}
        </Button>
      </div>

      {phase === "form" && (
        <div className="space-y-2" data-testid="fleet-wizard-form">
          {params.length === 0 && <p className="text-xs text-muted-foreground">{t("packs.wizard.noParams")}</p>}
          {params.map((p) => (
            <div key={p.name} className="grid grid-cols-[8rem_1fr] items-center gap-2">
              <label className="text-xs text-muted-foreground" data-testid={`fleet-wizard-label-${p.name}`}>
                {p.label ?? p.name}
                {p.required && p.default === undefined && <span className="text-amber-600"> *</span>}
              </label>
              {p.type === "boolean" ? (
                <input
                  type="checkbox"
                  checked={draft[p.name] === true}
                  onChange={(e) => setField(p, e.target.checked)}
                  data-testid={`fleet-wizard-input-${p.name}`}
                />
              ) : p.type === "enum" ? (
                <select
                  className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                  value={String(draft[p.name] ?? p.default ?? "")}
                  onChange={(e) => setField(p, e.target.value)}
                  data-testid={`fleet-wizard-input-${p.name}`}
                >
                  {(p.options ?? []).map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <Input
                  value={draft[p.name] === undefined ? "" : String(draft[p.name] as string | number)}
                  onChange={(e) => setField(p, e.target.value)}
                  data-testid={`fleet-wizard-input-${p.name}`}
                />
              )}
            </div>
          ))}
          {formError && <p className="text-xs text-destructive" data-testid="fleet-wizard-error">{formError}</p>}
          <Button size="sm" onClick={() => void run()} data-testid="fleet-wizard-run">
            {t("packs.wizard.runBtn")}
          </Button>
        </div>
      )}

      {(phase === "running" || phase === "done") && (
        <ul className="text-xs space-y-1" data-testid="fleet-wizard-log">
          {log.map((entry) => (
            <li key={entry.id} className={entry.text.startsWith("✗") ? "text-destructive" : "text-muted-foreground"}>{entry.text}</li>
          ))}
          {phase === "running" && <li className="text-primary">{t("common.loading")}</li>}
        </ul>
      )}

      {phase === "done" && (
        <div className="flex items-center gap-2 pt-2 border-t border-primary/20" data-testid="fleet-wizard-done">
          <span className="text-xs text-muted-foreground">
            {lit ? t("packs.wizard.lit") : t("packs.wizard.donePaused")}
          </span>
          {!lit && fleetId && (
            <Button size="sm" onClick={() => void ignite()} data-testid="fleet-wizard-ignite">
              {t("packs.wizard.igniteBtn")}
            </Button>
          )}
          {startError && <span className="text-xs text-destructive" data-testid="fleet-wizard-start-error">{startError}</span>}
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => onDone(fleetId)} data-testid="fleet-wizard-done-btn">
            {t("packs.wizard.doneBtn")}
          </Button>
        </div>
      )}
    </section>
  );
}
