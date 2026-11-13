// CredentialDoors — Settings → 连接 顶部「按门」总览
// (converge-line-identity-and-keys 4.2).
//
// The section below answers "is this brand connected". This block answers the
// question people actually arrive with: **how many keys does this cost me, and
// which one is missing**. The grouping is not editorial — it follows the two
// doors the change defines plus the third-party remainder:
//
//   门 K  客户级一把钥匙（词元）。一把钥匙喂多条线，按客户计费。
//   门 A  成员级代做。平台以"这个人"的名义在该线做事，不持有其登录态。默认关。
//   第三方 别的系统自己的凭据（市场登录、连接器、Chatwoot、搜索…）。
//
// Discipline:
//   · Additive. Every legacy card below still owns its flow; rows here only
//     deep-link into them (`?panel=`), so 4.4 can delete the old panels without
//     this block having duplicated a single mint/store/disconnect path.
//   · One read face. State comes from GET /api/connections (the connection
//     projection that already existed); this component re-shapes it and never
//     re-derives it — a second source of truth drifts, and the drifting side is
//     the one nobody looks at.
//   · State is read, never assumed. `unknown` (no entry for that id) renders as
//     its own state instead of folding into "not connected".
//   · 门 A 默认关：关闭时整组置灰并直说，绝不画成一个可点的"去连接"。

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import { Skeleton, ErrorState } from "@/components/ui/states-kit";
import type { StatusKind } from "@/lib/statusTokens";
import {
  fetchConnections,
  type Connection,
  type ConnectionsPayload,
  type DoorId,
} from "@/lib/credential-doors-api";
import { settingsPath } from "./sections";

//: UI 三态。服务端另有 `stale`（连过但失效）——它不是"没连"，要分开说。
type UiState = "connected" | "stale" | "missing" | "unknown";

const STATE_STATUS: Record<UiState, StatusKind> = {
  connected: "running",
  stale: "failed",
  missing: "waiting",
  unknown: "neutral",
};

function uiState(connection: Connection | undefined): UiState {
  if (!connection) return "unknown";
  switch (connection.state) {
    case "connected":
      return "connected";
    case "stale":
      return "stale";
    case "disconnected":
    case "not-configured":
      return "missing";
    default:
      return "unknown";
  }
}

function DoorRow({
  name,
  detail,
  state,
  panel,
  disabled,
}: {
  name: string;
  detail?: string | null;
  state: UiState;
  panel: string | null;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <li
      className={cn(
        "flex items-center gap-3 border-t border-border/60 px-1 py-2 first:border-t-0",
        disabled && "opacity-60",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-foreground">{name}</div>
        {detail ? <div className="truncate text-xs text-muted-foreground">{detail}</div> : null}
      </div>
      <StatusPill status={STATE_STATUS[state]} label={t(`settings.connections.doors.state.${state}`)} />
      {panel ? (
        <a
          href={`${settingsPath("connections")}?panel=${encodeURIComponent(panel)}`}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Link2 className="h-3 w-3" aria-hidden="true" />
          {t("settings.connections.doors.goConnect")}
        </a>
      ) : null}
    </li>
  );
}

function DoorBlock({
  title,
  subtitle,
  ready,
  count,
  children,
  muted,
}: {
  title: string;
  subtitle: string;
  ready: number;
  count: number;
  children: React.ReactNode;
  muted?: boolean;
}) {
  const { t } = useTranslation();
  const missing = count - ready;
  return (
    <section className={cn("min-w-0", muted && "opacity-80")}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {missing > 0
            ? t("settings.connections.doors.missingCount", { missing, count })
            : t("settings.connections.doors.allReady", { count })}
        </span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{subtitle}</p>
      <ul className="mt-2">{children}</ul>
    </section>
  );
}

export function CredentialDoors() {
  const { t } = useTranslation();
  const [data, setData] = useState<ConnectionsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchConnections()
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const byId = useMemo(() => {
    const map = new Map<string, Connection>();
    for (const c of data?.connections ?? []) map.set(c.id, c);
    return map;
  }, [data]);

  const idsOf = (door: DoorId) =>
    data?.doors.doors.find((d) => d.id === door)?.connections ?? [];

  const row = (id: string, opts?: { disabled?: boolean }) => {
    const c = byId.get(id);
    const purpose = t(`settings.connections.doors.refPurpose.${id}`, { defaultValue: "" });
    return (
      <DoorRow
        key={id}
        name={t(`settings.connections.doors.refName.${id}`, { defaultValue: c?.name ?? id })}
        detail={purpose || null}
        state={uiState(c)}
        panel={id}
        disabled={opts?.disabled}
      />
    );
  };

  const readyIn = (ids: string[]) =>
    ids.filter((id) => uiState(byId.get(id)) === "connected").length;

  const member = data?.doors.memberAssertion;
  const memberRows = member?.lines ?? [];
  const memberCount = memberRows.length;
  const memberReady = memberRows.filter((l) => l.enabled).length;

  return (
    <Card
      data-testid="credential-doors"
      title={t("settings.connections.doors.title")}
      actions={
        <span className="text-xs text-muted-foreground">{t("settings.connections.doors.lead")}</span>
      }
    >
      {loading ? (
        <Skeleton className="h-24 w-full" />
      ) : error ? (
        <ErrorState
          message={t("settings.connections.doors.loadFailed", { detail: error })}
          onRetry={load}
          retryLabel={t("common.retry")}
        />
      ) : (
        <div className="grid grid-cols-1 gap-x-6 gap-y-5 min-[1100px]:grid-cols-3">
          <DoorBlock
            title={t("settings.connections.doors.customerKey.title")}
            subtitle={t("settings.connections.doors.customerKey.subtitle")}
            count={idsOf("customer-key").length}
            ready={readyIn(idsOf("customer-key"))}
          >
            {idsOf("customer-key").map((id) => row(id))}
          </DoorBlock>

          <DoorBlock
            title={t("settings.connections.doors.memberAssertion.title")}
            subtitle={
              member?.enabled
                ? t("settings.connections.doors.memberAssertion.subtitle")
                : t("settings.connections.doors.memberAssertion.offSubtitle")
            }
            count={memberCount}
            ready={memberReady}
            muted={!member?.enabled}
          >
            {memberCount === 0 ? (
              <li className="flex items-start gap-2 py-2 text-xs text-muted-foreground">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{t("settings.connections.doors.memberAssertion.empty")}</span>
              </li>
            ) : (
              memberRows.map((l) => (
                <DoorRow
                  key={l.line}
                  name={t(`settings.connections.doors.lineName.${l.line}`, { defaultValue: l.line })}
                  detail={
                    l.ownTrack
                      ? t("settings.connections.doors.ownTrack", { track: l.ownTrack })
                      : t("settings.connections.doors.noOwnTrack")
                  }
                  state={l.enabled ? "connected" : "missing"}
                  panel={`line-${l.line}`}
                  disabled={!l.enabled}
                />
              ))
            )}
          </DoorBlock>

          <DoorBlock
            title={t("settings.connections.doors.thirdParty.title")}
            subtitle={t("settings.connections.doors.thirdParty.subtitle")}
            count={idsOf("third-party").length}
            ready={readyIn(idsOf("third-party"))}
          >
            {idsOf("third-party").map((id) => row(id))}
          </DoorBlock>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-border/60 pt-3">
        <p className="text-xs text-muted-foreground">{t("settings.connections.doors.footnote")}</p>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          {t("settings.connections.doors.refresh")}
        </Button>
      </div>
    </Card>
  );
}
