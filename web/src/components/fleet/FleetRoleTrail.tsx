// FleetRoleTrail — 角色成长轨迹 (agent-as-employee-model)
//
// 一个岗一行：当前版本、最近一次变化来自哪（自学 / 外部指导 / 晋升）、谁改的、
// 还有几条补丁在等属主。读 /api/fleets/:id/roles，只读；没有角色行的岗不出现。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";

type RoleRow = {
  memberId: string;
  title: string | null;
  currentVersion: number;
  latestSource: "self" | "guidance" | "promotion" | null;
  latestActor: string | null;
  latestAt: number | null;
  changes: number;
  pendingPatches: number;
};

export function FleetRoleTrail({ fleetId }: { fleetId: string }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<RoleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/fleets/${encodeURIComponent(fleetId)}/roles`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => alive && setRows(b.roles ?? []))
      .catch((e) => alive && setError(String(e?.message || e)));
    return () => { alive = false; };
  }, [fleetId]);

  if (error) return <Card className="p-3 text-sm text-destructive" data-testid="role-trail-error">{t("fleets.roleTrail.loadFailed")}：{error}</Card>;
  if (!rows || rows.length === 0) return null;

  return (
    <Card className="p-3 space-y-2" data-testid="role-trail">
      <div className="font-medium text-sm">{t("fleets.roleTrail.title")}</div>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th className="text-left">{t("fleets.roleTrail.post")}</th>
            <th className="text-right">{t("fleets.roleTrail.version")}</th>
            <th className="text-left">{t("fleets.roleTrail.lastChange")}</th>
            <th className="text-right">{t("fleets.roleTrail.pending")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.memberId} data-testid={`role-trail-${r.memberId}`}>
              <td className="text-left">{r.title ?? r.memberId}</td>
              <td className="text-right">v{r.currentVersion}</td>
              <td className="text-left">
                {r.latestSource
                  ? `${t(`fleets.roleTrail.source.${r.latestSource}`)}${r.latestActor ? ` · ${r.latestActor}` : ""}`
                  : t("fleets.roleTrail.unchanged")}
              </td>
              <td className="text-right">{r.pendingPatches > 0 ? r.pendingPatches : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
