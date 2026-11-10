// Settings → User roles (openspec: role-system). The admin surface for
// business-role assignment: every known user with their primary role,
// secondary roles and the orthogonal admin flag. One row edit = one PUT of
// the whole assignment (server replaces wholesale, mirrors the route).
//
// The section is admin-gated in sections.ts when auth is on; when auth is off
// the machine owner sees it too, exactly like the REST gate (requireAdmin is
// open without auth). Role labels resolve through the i18n bundle keyed by
// slug so the copy follows the locale while slugs stay stable.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

interface RoleInfo {
  slug: string;
  labelKey: string;
}

interface AssignmentRow {
  email: string;
  primary: string;
  secondary: string[];
  admin: boolean;
  source?: string;
}

const selectCls =
  "rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none";

export function RolesSection() {
  const { t } = useTranslation();
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [rows, setRows] = useState<AssignmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingEmail, setSavingEmail] = useState<string | null>(null);

  const roleLabel = useCallback(
    (slug: string) => {
      const entry = roles.find((r) => r.slug === slug);
      return entry ? t(entry.labelKey) : slug;
    },
    [roles, t],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [rolesRes, listRes] = await Promise.all([
        fetch("/api/roles"),
        fetch("/api/roles/assignments"),
      ]);
      if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
      const rolesBody = await rolesRes.json();
      const listBody = await listRes.json();
      setRoles(
        (rolesBody?.roles ?? []).map((slug: string) => ({ slug, labelKey: `roles.slug.${slug}` })),
      );
      setRows(listBody?.assignments ?? []);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (row: AssignmentRow, next: Partial<AssignmentRow>) => {
      const merged = { ...row, ...next };
      setSavingEmail(row.email);
      setError("");
      try {
        const res = await fetch(`/api/roles/assignments/${encodeURIComponent(row.email)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ primary: merged.primary, secondary: merged.secondary, admin: merged.admin }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        const saved = await res.json();
        setRows((prev) => prev.map((r) => (r.email === row.email ? { ...r, ...saved } : r)));
      } catch (err) {
        setError(String(err instanceof Error ? err.message : err));
      } finally {
        setSavingEmail(null);
      }
    },
    [],
  );

  return (
    <div className="space-y-4" data-testid="roles-section">
      <p className="text-sm text-muted-foreground">{t("settings.roles.intro")}</p>
      {error ? (
        <p className="text-sm text-destructive" data-testid="roles-error">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="text-sm text-muted-foreground">{t("settings.roles.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="roles-empty">
          {t("settings.roles.empty")}
        </p>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {rows.map((row) => (
            <div
              key={row.email}
              className={cn("flex flex-wrap items-center gap-3 px-3 py-2.5", savingEmail === row.email && "opacity-60")}
              data-testid={`roles-row-${row.email}`}
            >
              <span className="min-w-40 flex-1 truncate text-sm text-foreground">{row.email}</span>
              <select
                className={selectCls}
                aria-label={t("settings.roles.primaryLabel")}
                value={row.primary}
                disabled={savingEmail === row.email}
                onChange={(e) => void save(row, { primary: e.target.value })}
                data-testid={`roles-primary-${row.email}`}
              >
                {roles.map((r) => (
                  <option key={r.slug} value={r.slug}>
                    {roleLabel(r.slug)}
                  </option>
                ))}
              </select>
              <div className="flex flex-wrap items-center gap-1.5" data-testid={`roles-secondary-${row.email}`}>
                {roles
                  .filter((r) => r.slug !== row.primary)
                  .map((r) => {
                    const active = row.secondary.includes(r.slug);
                    return (
                      <button
                        key={r.slug}
                        type="button"
                        disabled={savingEmail === row.email}
                        aria-pressed={active}
                        onClick={() =>
                          void save(row, {
                            secondary: active ? row.secondary.filter((s) => s !== r.slug) : [...row.secondary, r.slug],
                          })
                        }
                        className={cn(
                          "rounded-full border px-2.5 py-0.5 text-xs",
                          active
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {roleLabel(r.slug)}
                      </button>
                    );
                  })}
              </div>
              <button
                type="button"
                disabled={savingEmail === row.email}
                aria-pressed={row.admin}
                onClick={() => void save(row, { admin: !row.admin })}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs",
                  row.admin
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
                data-testid={`roles-admin-${row.email}`}
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                {t("settings.roles.adminLabel")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
