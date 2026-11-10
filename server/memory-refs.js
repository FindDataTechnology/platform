// ── fd-memory reference 写主客户端（add-unified-memory-and-outputs D3/D6）──
//
// 真源 = fd-memory reference 页；成果行只存镜像。本模块是 paas 侧唯一出站口：
// write-master = fd-memory /pages/write + /pages/mutate（一条 person-token
// 车道），手势与自动落页都经这里，单写纪律成立。degrade-open：任何记忆未
// 配置或请求失败 → null / 静默跳过，绝不阻塞入仓或回话。

import { cellMemoryConfig, personTokenFor } from "@finddatatechnology/yongyi-client";
import { fetchWithTimeout } from "../lib/fetch-with-timeout.js";

export function memoryRefSlug(id) {
  return `r-${String(id).replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 24)}`;
}

export function summaryForResource(resource) {
  const title = String(resource?.title ?? "");
  const kind = resource?.type === "chart" ? "图表" : "文档";
  const bits = [kind, title, String(resource?.sessionTitle ?? "")].filter(Boolean).join(" · ");
  return bits.slice(0, 140) || title.slice(0, 140) || "成果条目";
}

// { writeReference, mutateReference } | null — same per-owner token cache
// story as clusterMemoryFor (one mint per owner via /admin/mint, stored on
// disk by the SDK's token cache).
export async function memoryRefClientFor(env, ownerEmail, fetchImpl = fetch) {
  const cfg = cellMemoryConfig(env);
  if (!cfg || !ownerEmail) return null;
  try {
    const token = await personTokenFor(cfg, ownerEmail, fetchImpl);
    if (!token) return null;
    const base = `${cfg.url}/pages`;
    const authH = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    return {
      async writeReference({ project = "default", title, summary, tags = [], tier = "draft", source_ref, slug }) {
        // Outbound call discipline: shared deadline wrapper (default env
        // bound); fetchImpl stays the test seam.
        const r = await fetchWithTimeout(`${base}/write`, {
          method: "POST", headers: authH,
          body: JSON.stringify({ project, type: "reference", title, body: summary, tags, tier, source_ref, slug }),
        }, { fetchImpl });
        if (!r.ok) throw new Error(`pages/write HTTP ${r.status}`);
        return await r.json(); // { path, created }
      },
      async mutateReference({ path, op, tier, tags, origin = "human" }) {
        const r = await fetchWithTimeout(`${base}/mutate`, {
          method: "POST", headers: authH,
          body: JSON.stringify({ path, op, tier, tags, origin }),
        }, { fetchImpl });
        if (!r.ok) {
          const err = new Error(`pages/mutate HTTP ${r.status}`);
          err.status = r.status;
          throw err;
        }
        return await r.json(); // { changed }
      },
    };
  } catch (e) {
    console.warn(`[memory-refs] unavailable (degrade open): ${e?.message || e}`);
    return null;
  }
}

// Reference page must exist before a tier/tag gesture can mutate it. The page
// is a mirror of the same resource, so registering it on demand IS the
// remember gesture — a user marking 正典 never has to click 记住 first.
export async function ensureReference(cli, resource) {
  if (resource.memoryRefPath) return resource.memoryRefPath;
  const out = await cli.writeReference({
    title: resource.title,
    summary: summaryForResource(resource),
    tier: resource.tier ?? "draft",
    tags: Array.isArray(resource.tags) ? resource.tags : JSON.parse(resource.tags || "[]"),
    source_ref: `resource:${resource.id}`,
    slug: memoryRefSlug(resource.id),
  });
  const path = out?.path ?? null;
  if (path) dbSetMemoryRef(resource, path);
  return path;
}

// Fire-and-forget the mirror for a freshly saved resource — the caller
// (resources.js insert points) never blocks on memory.
export function mirrorReferenceForResource({ env = process.env, ownerEmail, resource, fetchImpl = fetch } = {}) {
  if (!ownerEmail || !resource?.id) return Promise.resolve(false);
  const slug = memoryRefSlug(resource.id);
  const source_ref = `resource:${resource.id}`;
  return memoryRefClientFor(env, ownerEmail, fetchImpl)
    .then(async (cli) => {
      if (!cli) return false;
      try {
        const out = await cli.writeReference({
          title: resource.title, summary: summaryForResource(resource),
          tier: resource.tier ?? "draft", tags: Array.isArray(resource.tags) ? resource.tags : JSON.parse(resource.tags || "[]"),
          source_ref, slug,
        });
        try { dbSetMemoryRef(resource, out?.path ?? null); } catch { /* mirror write is companionary */ }
        return out?.path ?? null;
      } catch (e) {
        console.warn(`[memory-refs] write failed for ${resource.id} (degrade open): ${e?.message || e}`);
        return false;
      }
    });
}

// Local mirror setter (db.setResourceMemoryRef) — isolated so resources.js
// doesn't depend on db directly for the mirror column.
import * as db from "../db.js";
function dbSetMemoryRef(resource, memoryRefPath) {
  db.setResourceMemoryRef(resource.id, memoryRefPath, new Date().toISOString());
}
