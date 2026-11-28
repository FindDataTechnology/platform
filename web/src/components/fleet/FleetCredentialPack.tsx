// FleetCredentialPack — 舰队凭据包 (change converge-line-identity-and-keys 4.1)
//
// 一块面板回答一个问题：**这个团队还要属主填几次凭据**。
//
// 为什么不做成"每条线一张卡"：钥匙的切分轴和产品的切分轴是反的——三条线可能
// 共用一把词元钥，一次填完就够；而 chatwoot 的 token 喂不通 registry，必须各填
// 各的。所以数字按"凭据单位"算，不按线数算（服务端的口径，见
// server/lib/fleet-credential-pack.js）；这块面板只负责把这个数字与去处说清楚。
//
// 四条产品纪律：
//   1. **不复制连接流程**：每一行只给深链，落到既有连接页的对应卡片；本组件
//      不铸造、不存钥、不探活。
//   2. **不另起第二个状态面**：数据来自 /api/fleets/credential-plan，那是装包
//      解析器的投影，连接页仍是 /api/connections。
//   3. **"读不到"与"齐了"不同形**：失败如实报错，不渲染绿色的"凭据齐了"。
//   4. **空团队不说话**：还没装能力包时这块不渲染——没有凭据问题可答。

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";

type Fill = {
  key: string;
  door: string | null;
  refName: string | null;
  connected: boolean;
  missingReason: string | null;
  connectPath: string | null;
  servers: string[];
  packs: string[];
};

type Plan = {
  fillsRequired: number;
  fills: Fill[];
  satisfied: boolean;
  unknown: { server: string; packId: string | null }[];
  noCredential: { server: string; packId: string | null }[];
  missingPacks: string[];
  emptyReason?: string;
};

const DOOR_LABEL_KEY: Record<string, string> = {
  "customer-key": "fleets.credentialPack.doorCustomerKey",
  "member-assertion": "fleets.credentialPack.doorMemberAssertion",
  "third-party": "fleets.credentialPack.doorThirdParty",
};

export function FleetCredentialPack({ fleetId }: { fleetId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let alive = true;
    fetch("/api/fleets/credential-plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fleetId }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
        return body as Plan;
      })
      .then((body) => {
        if (!alive) return;
        setPlan(body);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // 读不到就说读不到；不要让面板空着被当成"齐了"。
        setError(String((e as Error)?.message ?? e));
        setPlan(null);
      });
    return () => {
      alive = false;
    };
  }, [fleetId]);

  useEffect(() => load(), [load]);

  // 什么时候不渲染：没有可答的问题时，一块"一切正常"的绿卡纯属噪声。
  // 空团队（还没装能力包）、齐了且没有查不到的项 —— 都不占版面。
  // 反过来：只要还有"查不到"或"包已不在本机"，就必须显示，那是真问题。
  if (!error && plan) {
    const quiet =
      plan.fillsRequired === 0 && plan.unknown.length === 0 && plan.missingPacks.length === 0;
    if (plan.emptyReason || quiet) return null;
  }

  const chip = (door: string | null) =>
    t(DOOR_LABEL_KEY[door ?? ""] ?? "fleets.credentialPack.doorUnclassified");

  return (
    <Card
      className="mb-3"
      data-testid="fleet-credential-pack"
      title={t("fleets.credentialPack.title")}
      actions={
        error ? (
          <StatusPill status="failed" label={t("fleets.credentialPack.unreadable")} />
        ) : plan ? (
          plan.fillsRequired > 0 ? (
            <StatusPill
              status="waiting"
              label={t("fleets.credentialPack.needFills", { count: plan.fillsRequired })}
            />
          ) : (
            <StatusPill status="running" label={t("fleets.credentialPack.ready")} />
          )
        ) : null
      }
    >
      {error ? (
        <p className="text-xs text-muted-foreground">
          {t("fleets.credentialPack.loadFailed", { message: error })}
        </p>
      ) : !plan ? (
        <p className="text-xs text-muted-foreground">{t("fleets.credentialPack.loading")}</p>
      ) : (
        <>
          {plan.fills.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {plan.fills.map((fill) => (
                <li
                  key={fill.key}
                  className="flex items-center gap-2 rounded-md px-1 py-1.5 hover:bg-muted/60"
                  data-testid="fleet-credential-fill"
                >
                  <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {chip(fill.door)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="truncate font-mono text-xs">{fill.refName}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {fill.missingReason ?? t("fleets.credentialPack.reasonFallback")}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="fleet-credential-connect"
                    onClick={() => fill.connectPath && navigate(fill.connectPath)}
                  >
                    {t("fleets.credentialPack.connect")}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}

          {/* 如实报三种"其余情况"：查不到 / 本来不需要 / 包已不在本机。 */}
          {plan.unknown.length || plan.noCredential.length || plan.missingPacks.length ? (
            <p className="mt-2 border-t border-border pt-2 text-[11px] leading-5 text-muted-foreground">
              {[
                plan.unknown.length
                  ? t("fleets.credentialPack.unknown", { count: plan.unknown.length })
                  : null,
                plan.noCredential.length
                  ? t("fleets.credentialPack.noCredential", { count: plan.noCredential.length })
                  : null,
                plan.missingPacks.length
                  ? t("fleets.credentialPack.missingPacks", { count: plan.missingPacks.length })
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}
