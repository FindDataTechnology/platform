// ── 版本区块（pack-detail-as-page 3.x）────────────────────────────────────────
//
// 取代原来的「折叠披露 + 行展开看技能名」。两个变化：
//
//   1. **常驻**（不是点开才加载）：版本历史是「这个包怎么长成现在这样」的核心内容，
//      折叠在最末等于没有。数据仍在页面渲染时按需取，不进默认 detail payload。
//   2. **快照对比**：选中任一历史版，按 manifest 结构与之当前版并排比，只列变化的项。
//
// 对比的边界写在 UI 上：「按 manifest 声明对比」——manifest 没声明的东西，
// 两版之间比不出来。不说这句会让人以为「没差异 = 没改动」。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import * as api from "@/lib/packs-api";
import type { PackManifest, PackVersionRow } from "@/lib/packs-api";
import { shapeOf, diffShape, changedOnly, type ShapeDiffRow } from "./version-diff";

export function PackVersionSection({
  packId,
  currentVersion,
  currentManifest,
}: {
  packId: string;
  currentVersion: number;
  /** 当前版的 manifest——对比的另一侧。没有它就只剩「看旧版」，不是对比。 */
  currentManifest: PackManifest | null;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<PackVersionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<PackManifest | null>(null);
  const [busy, setBusy] = useState(false);

  // 常驻加载：页面渲染这一段就取，不等用户点开。
  useEffect(() => {
    let alive = true;
    api
      .listPackVersions(packId)
      .then((r) => alive && setRows((r.versions as PackVersionRow[]) ?? []))
      .catch((e) => alive && setError(String((e as Error)?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [packId]);

  // 选中的历史版：取它的 manifest 快照（只在选中时取，不预取全部）。
  useEffect(() => {
    if (selected == null) {
      setSnapshot(null);
      return;
    }
    let alive = true;
    setBusy(true);
    api
      .getPackVersion(packId, selected)
      .then((d) => alive && setSnapshot((d.manifest as PackManifest) ?? null))
      .catch(() => alive && setSnapshot(null))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [packId, selected]);

  const diff = useMemo<ShapeDiffRow[]>(() => {
    if (!snapshot || !currentManifest) return [];
    return changedOnly(
      diffShape(
        shapeOf(snapshot as unknown as Record<string, unknown>),
        shapeOf(currentManifest as unknown as Record<string, unknown>),
      ),
    );
  }, [snapshot, currentManifest]);

  return (
    <section data-testid="pack-version-section" className="space-y-3">
      {error && (
        <p className="text-sm text-destructive" data-testid="pack-version-error">
          {t("packPage.versions.error", { message: error })}
        </p>
      )}
      {!rows && !error && <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}

      {rows && rows.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="pack-version-empty">
          {t("packPage.versions.empty")}
        </p>
      )}

      {rows && rows.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border" data-testid="pack-version-rows">
          {rows.map((r) => {
            const isCurrent = r.version === currentVersion;
            return (
              <li key={r.version} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <span className="font-mono font-medium">v{r.version}</span>
                {isCurrent && (
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
                    {t("packPage.versions.current")}
                  </span>
                )}
                {r.publishedAt && (
                  <span className="text-xs text-muted-foreground">
                    {new Date(r.publishedAt).toLocaleDateString()}
                  </span>
                )}
                {r.authorEmail && <span className="text-xs text-muted-foreground">{r.authorEmail}</span>}
                {r.notes && <span className="text-xs">{r.notes}</span>}
                {/* 逐版的检视链接（迁移时漏掉的能力，pack-detail-as-page 6.0）：
                    常驻版式取代了折叠披露，但**可检视**不能跟着丢——每一版都能
                    直接取它的清单与技能正文，这正是「历史迭代详情」的物证。
                    只读：历史版永远没有安装入口。 */}
                <a
                  href={`/api/packs/${packId}/versions/${r.version}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-primary hover:underline"
                  data-testid={`pack-version-manifest-${r.version}`}
                >
                  {t("packPage.versions.manifestJson")}
                </a>
                {!isCurrent && (
                  <button
                    type="button"
                    className="ml-auto text-xs text-primary hover:underline"
                    onClick={() => setSelected(r.version === selected ? null : r.version)}
                    data-testid={`pack-version-compare-${r.version}`}
                  >
                    {selected === r.version ? t("packPage.versions.hideCompare") : t("packPage.versions.compare")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {busy && <p className="text-xs text-muted-foreground">{t("common.loading")}</p>}

      {snapshot && (
        <div className="rounded-md border border-border p-3" data-testid="pack-version-snapshot">
          {/* 边界必须写在界面上：「按 manifest 声明对比」。 */}
          <p className="mb-2 text-xs text-muted-foreground">{t("packPage.versions.compareNote")}</p>
          {/* 该版的技能正文（只读下载）：与旧折叠披露里的 skill-links 等价。 */}
          {((snapshot as unknown as { skills?: { name: string }[] }).skills ?? []).length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-x-3 gap-y-1" data-testid={`pack-version-skill-links-${selected}`}>
              {((snapshot as unknown as { skills?: { name: string }[] }).skills ?? []).map((sk) => (
                <li key={sk.name}>
                  <a
                    href={`/api/packs/${packId}/versions/${selected}/skills/${encodeURIComponent(sk.name)}.md`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs text-primary hover:underline"
                  >
                    {sk.name}.md
                  </a>
                </li>
              ))}
            </ul>
          )}
          {diff.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="pack-version-no-diff">
              {t("packPage.versions.noDiff", { version: selected ?? "" })}
            </p>
          ) : (
            <table className="w-full text-xs" data-testid="pack-version-diff">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-normal">{t("packPage.versions.field")}</th>
                  <th className="py-1 pr-3 font-normal">v{selected}</th>
                  <th className="py-1 font-normal">v{currentVersion}</th>
                </tr>
              </thead>
              <tbody>
                {diff.map((r) => (
                  <tr key={r.field} className="border-t border-border/50">
                    <td className="py-1 pr-3">{t(`packPage.versions.fields.${r.field}`, r.field)}</td>
                    <td className="py-1 pr-3 font-mono text-muted-foreground">{String(r.before)}</td>
                    <td className="py-1 font-mono">{String(r.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
