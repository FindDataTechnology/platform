// PackVersionList — the shared version-history presentation (add-facet-
// version-history): one component serves the public pack detail (壹座 and
// 谦面 market shells ride the same PackMarketView tree) and the facet
// creator console's #/mine — the surfaces cannot drift (spec:
// facet-platform, The facet surface carries a creator console). Lazy by
// contract: the list fetches only when the disclosure opens, so it never
// rides the detail's default payload; a row's skill bodies fetch only when
// that row expands. Rows are inspect-only — per-version manifest and skill
// links, never an install action for a non-latest version (spec:
// pack-marketplace, Browse, search, and inspect).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/lib/packs-api";
import type { PackVersionRow } from "@/lib/packs-api";

interface Props {
  packId: string;
  testId?: string;
}

export function PackVersionList({ packId, testId = "pack-version-list" }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<PackVersionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Row expansion (version → that version's skill names): the skill bodies
  // arrive only for the row the viewer opened, not for the whole list.
  const [expanded, setExpanded] = useState<Record<number, string[]>>({});
  const [rowBusy, setRowBusy] = useState<number | null>(null);

  useEffect(() => {
    if (!open || rows || error) return;
    api
      .listPackVersions(packId)
      .then((r) => setRows(r.versions))
      .catch((e) => setError((e as Error).message));
  }, [open, rows, error, packId]);

  const toggleRow = async (version: number) => {
    if (expanded[version] !== undefined) {
      setExpanded((x) => {
        const { [version]: _drop, ...rest } = x;
        return rest;
      });
      return;
    }
    setRowBusy(version);
    try {
      const doc = await api.getPackVersion(packId, version);
      setExpanded((x) => ({ ...x, [version]: (doc.manifest?.skills ?? []).map((s) => s.name) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRowBusy(null);
    }
  };

  return (
    <section className="rounded-md border border-border p-3" data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid={`${testId}-toggle`}
        className="flex w-full items-center justify-between text-left font-medium"
        aria-expanded={open}
      >
        <span>{t("packs.versions.title")}</span>
        <span className="text-xs text-muted-foreground">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-2" data-testid={`${testId}-body`}>
          {error && <p className="text-xs text-destructive">{t("packs.versions.failed", { message: error })}</p>}
          {!error && rows === null && <p className="text-xs text-muted-foreground">{t("common.loading")}</p>}
          {rows !== null && rows.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("packs.versions.empty")}</p>
          )}
          {rows !== null && rows.length > 0 && (
            <ul className="space-y-1">
              {rows.map((v, i) => {
                const names = expanded[v.version];
                return (
                <li key={v.version} className="border-t border-border pt-1 text-xs" data-testid={`${testId}-row-${v.version}`}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-mono text-foreground">v{v.version}</span>
                    {i === 0 && (
                      <span className="rounded-sm border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                        {t("packs.versions.current")}
                      </span>
                    )}
                    <span className="text-muted-foreground">{new Date(v.publishedAt).toLocaleString()}</span>
                    <span className="text-muted-foreground">{v.authorEmail}</span>
                    <a
                      href={`/api/packs/${packId}/versions/${v.version}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                      data-testid={`${testId}-manifest-${v.version}`}
                    >
                      {t("packs.detail.manifestJson")}
                    </a>
                    <button
                      type="button"
                      onClick={() => void toggleRow(v.version)}
                      className="text-primary hover:underline disabled:opacity-40"
                      disabled={rowBusy === v.version}
                      data-testid={`${testId}-skills-${v.version}`}
                    >
                      {t("packs.versions.skillsToggle")}
                    </button>
                  </div>
                  {v.notes && (
                    <p className="mt-0.5 leading-5 text-muted-foreground" data-testid={`${testId}-notes-${v.version}`}>
                      {v.notes}
                    </p>
                  )}
                  {names !== undefined && (
                    <ul className="mt-1 list-disc pl-4" data-testid={`${testId}-skill-links-${v.version}`}>
                      {names.length === 0 && (
                        <li className="text-muted-foreground">{t("packs.versions.noSkills")}</li>
                      )}
                      {names.map((name) => (
                        <li key={name}>
                          <a
                            href={`/api/packs/${packId}/versions/${v.version}/skills/${encodeURIComponent(name)}.md`}
                            download
                            className="font-mono text-primary hover:underline"
                          >
                            {name}.md
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
