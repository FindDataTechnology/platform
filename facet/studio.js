// Supply-domain Studio assembly (add-supply-studio-migration 1.x, W2 D1/D5).
//
// 蓝图创作面迁谦面：路由树、生命周期状态机、校验、凭据禁带闸**逐字复用**
// platform 侧同一模块（server/routes/blueprints.js + blueprint-validate.js +
// blueprint-trial.js），这里只做进程装配——同镜像双角色拆分（壹座=platform
// 角色、谦面=facet 角色）的核心改动点：
//
//   * store    = createBlueprintDatabase({ file: FACET_DATA_ROOT/studio-docs.db })
//                （D1：谦面侧独立文档库，schema/语义与壹座 blueprints.db 逐字
//                对齐——文档 id/形状跨迁移稳定，迁移=对账 content_json 相等）
//   * identity = 谦面 resolveUser（Logto 轻账号一张票；ctx.resolveUser 注入缝）
//   * publisher= 进程内 pack registry 直调（publish/publishVersion + getPack
//                读 packRowPublic），替代 platform 侧的 HTTP publish client——
//                发布闸（collectPublishVerdict 的闸序）在 packs.js 路由层，
//                Studio 铸造仍要过它：这里不走路由，直接调 registry 的
//                publish 原语 **不绕闸** 是错误的做法，因此铸出路径保持与
//                pack 发布同闸（见 publisher 的闸调用）。
//   * resolveRefs = 进程内市场解析（registry.list by name），同 HTTP 分支
//                语义（pick name 精确匹配的第一条）。
//   * trialDeps = 跨域 client（RUN_DOMAIN_BASE_URL 配置时：runWhole 交壹座
//                trial-exec 执行整链，报告单体返回）或诚实 503 桩（未配置
//                时，trial 端点挂出、ribbon 投影与 409 语义保持——task 5.3）。
//
// 设计锚：design.md D1（宿主）、D4（跨域边界）、D5（退役映射）。

import path from "node:path";
import { createBlueprintRoutes } from "../server/routes/blueprints.js";
import { createBlueprintDatabase } from "../server/routes/blueprints-db.js";
import { createStudioDraftRoutes } from "../server/routes/studio-draft.js";
import { createPreviewSandboxRoutes } from "./preview-sandbox.js";
import { collectPublishVerdict } from "../gateway/packs.js";
import { findAuthorPackByName } from "./publish-gate.js";

// ── 进程内发布客户端 ─────────────────────────────────────────────────────────
// 与 platform 侧 createFacetPublishClient 同一应答形状（{ok, packId, version,
// status, error, body}），发布原语换进程内 registry。闸序说明：platform 侧的
// HTTP client 打 facet POST /api/packs（全闸 collectPublishVerdict+限速+署名
// 在路由层），进程内直调绕开了路由层的闸——这是本装配必须补齐的缝。Studio 铸
// 出物与手工 pack 发布同闸同 UX（spec「发布经供给域发布闸」），因此这里按路
// 由同序先跑 collectPublishVerdict（shortCircuit 同款），再调 registry 原语。
// 署名（vendor）与价格：蓝图铸出物不带 vendor/pricing（manifest 内不出现），
// 与 platform 侧 HTTP 通道的缺省一致。
function createInProcessPublishClient({ registry, env = process.env }) {
  const officialAuthor = (email) =>
    String(env.OFFICIAL_AUTHOR_EMAILS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(String(email || ""));

  const rate = { map: new Map() }; // author email -> { count, windowStart }
  const RATE_LIMIT = 10;
  const RATE_WINDOW_MS = 3600_000;

  function publishAllowed(email) {
    const now = Date.now();
    const bucket = rate.map.get(email);
    if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
      rate.map.set(email, { count: 1, windowStart: now });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= RATE_LIMIT;
  }

  return {
    async publish({ manifest, packId, user }) {
      const email = user?.email;
      if (!email) {
        return { ok: false, status: 401, error: "cast needs a resolved caller identity (no email on the request user)" };
      }
      // 闸序与 facet POST /api/packs 逐字节同款（shortCircuit 同款——首失败即回）。
      const verdict = await collectPublishVerdict(manifest, { shortCircuit: true, officialAuthor: officialAuthor(email) });
      if (verdict.length > 0) {
        return { ok: false, status: verdict[0].status ?? 400, error: verdict[0].body?.error ?? "publish gate rejected", body: verdict[0].body };
      }
      // Same-name gate (add-mixed-fleet D5, one author one name): the HTTP
      // face runs it as a pre-route on POST /api/packs; the in-process cast
      // path bypasses that route, so the identical check runs here — same
      // wording, same structured body (publish-gate.js is the single source;
      // this is its in-process twin, not a second wording).
      if (!packId) {
        const existing = findAuthorPackByName(registry, email, String(manifest?.name ?? ""));
        if (existing) {
          return {
            ok: false,
            status: 409,
            error: `同名包已存在：你名下已有名为「${manifest.name}」的 pack（listed 或 unlisted 均算）。请勿另发新包——在该包下发布新版本（POST /api/packs，body 带 packId: "${existing.id}"），或先经管理面 unlist 旧包后再发新包。`,
            body: { code: "DUPLICATE_PACK_NAME", existingPackId: existing.id },
          };
        }
      }
      if (!publishAllowed(email)) {
        return { ok: false, status: 429, error: "Too many publishes, try again later" };
      }
      const result = packId
        ? registry.publishVersion({ email, id: packId, manifest })
        : registry.publish({ email, manifest });
      if (result?.error === "not_found") {
        return { ok: false, status: 404, error: "Pack not found" };
      }
      if (result?.error === "forbidden") {
        return { ok: false, status: 403, error: "Only the pack author may publish new versions" };
      }
      return { ok: true, packId: result?.id ?? packId ?? null, version: result?.version ?? null, body: result };
    },

    // 读一枚包（自愈认回用）：与 HTTP client.getPack 同形状——返回
    // { id, manifest, authorEmail } 或 null。认回判据读 manifest._casting
    // .blueprintId。storage 版 getVersion 无可见性过滤（owner 认回自己的包
    // 恒可读——语义与 HTTP 路由的 author-self widen 一致）。
    async getPack({ packId }) {
      if (!packId) return null;
      const pack = registry.packRowPublic(packId);
      if (!pack) return null;
      const latest = registry.versions(packId);
      const row = latest?.error ? null : registry.getVersion(packId, latest?.[0]?.version);
      const manifest = row?.manifest ?? null;
      if (!manifest) return null;
      return { id: packId, manifest, authorEmail: pack.author_email ?? null };
    },
  };
}

// ── 进程内依赖解析 ───────────────────────────────────────────────────────────
// 与 HTTP 分支语义同款：按名精确匹配市场清单的第一条 → { packId, name }。
// pick() 的形状契约见 pack-manifest-source.js（buildCastManifest 只读 packId）。
function createInProcessPackResolver({ registry }) {
  return {
    async resolveRefs({ refs, viewer }) {
      const wanted = [...new Set((refs ?? []).filter((r) => typeof r === "string" && r.trim()))];
      const out = {};
      if (!wanted.length) return out;
      for (const ref of wanted) {
        try {
          const body = registry.list({ search: ref, pageSize: 50, viewer });
          const hit = (body?.packs ?? []).find((p) => p?.name === ref);
          if (hit?.id) out[ref] = { packId: hit.id, name: hit.name };
        } catch (err) {
          console.warn(`[studio] pack reference '${ref}' unresolved (market listing failed: ${err?.message || err})`);
        }
      }
      return out;
    },
  };
}

// ── 试跑依赖：跨域 client 或诚实不可用 ──────────────────────────────────────
// D3：真执行需要壹座运行域（cell/凭据/舰队语境）。两条形态：
//   ① RUN_DOMAIN_BASE_URL 配置时 → createRemoteTrialDeps：runWhole 把整份蓝图
//      交给壹座 trial-exec（共享内部凭据 x-facet-token，与 gateway/facet-proxy
//      同一凭据反向使用），报告单体返回，文档与签字链仍落本侧 studio-docs.db。
//   ② 未配置时 → createDeferredTrialDeps：trial 端点仍挂出（ribbon 投影 +
//      agent 409 + cast 前置 409 语义全保留），执行通道答显式 503 语义码
//      ——不伪造、不静默。
function createDeferredTrialDeps() {
  const unavailable = () => {
    throw Object.assign(new Error("trial execution is not available on the supply-domain deployment yet (run-domain channel pending; see task 5.3)"), {
      status: 503,
      code: "trial_channel_pending",
    });
  };
  return {
    now: Date.now,
    fetchManifest: unavailable,
    install: unavailable,
    provision: unavailable,
    runTurn: unavailable,
    judge: unavailable,
  };
}

function createRemoteTrialDeps({ base, token, fetchImpl = fetch } = {}) {
  const cleanBase = (base || "").replace(/\/+$/, "");
  // collectAndWait 的证据窗受平台 HTTP 请求顶棚（Node 默认 300s）约束——
  // 请求体带 timeoutMs，服务端再夹到 [30s, 270s]；客户端放宽到 5 分钟整，
  // 慢在收证而非连接。
  return {
    now: Date.now,
    runWhole: async ({ blueprint, user }) => {
      const res = await fetchImpl(`${cleanBase}/api/trial-exec`, {
        method: "POST",
        headers: {
          "x-facet-token": token,
          "x-facet-user": Buffer.from(JSON.stringify({ email: user?.email, groups: user?.groups ?? [] })).toString("base64url"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ blueprint, timeoutMs: 270_000 }),
        signal: AbortSignal.timeout(300_000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw Object.assign(new Error(body?.error || `trial-exec failed (HTTP ${res.status})`), {
          status: res.status,
          code: body?.code || "trial_exec_remote_failed",
        });
      }
      return body.report;
    },
  };
}

// ── 装配 ─────────────────────────────────────────────────────────────────────
export function createStudioDocDatabase({ file } = {}) {
  return createBlueprintDatabase(file ? { file } : {});
}

export function registerStudioRoutes(app, {
  resolveUser,
  registry, // facet pack registry（createPackRegistry 实例）
  dataRoot, // FACET_DATA_ROOT
  studioDb = null, // 测试注入；缺省落 dataRoot/studio-docs.db
  publishClient = null, // 测试注入
  packResolver = null, // 测试注入
  trialDeps = null, // 测试注入
  env = process.env,
}) {
  const db = studioDb ?? createStudioDocDatabase({ file: path.join(dataRoot, "studio-docs.db") });  const publisher = publishClient ?? createInProcessPublishClient({ registry, env });
  const resolver = packResolver ?? createInProcessPackResolver({ registry });
  const trial = trialDeps
    ?? (env.RUN_DOMAIN_BASE_URL
      ? createRemoteTrialDeps({ base: env.RUN_DOMAIN_BASE_URL, token: env.FACET_INTERNAL_TOKEN || "" })
      : createDeferredTrialDeps());
  const ctx = { authEnabled: true, resolveUser };

  createBlueprintRoutes(app, ctx, {
    db,
    publishClient: publisher,
    packResolver: resolver,
    trialDeps: trial,
  });
  // AI 起草（task 2.4）：判官桥逻辑同模块复用，env 车道（LLM_BASE_URL/KEY/
  // BLUEPRINT_JUDGE_MODEL→sub2api 内网）在 facet 进程生效；per-user 名册在
  // facet 数据目录为空 → rosterVisible=false → env 路由照发（同壹座 cell 进
  // 程的已实证形态）。
  createStudioDraftRoutes(app, ctx);
  // 预览沙箱（task 3.x）：干跑三件套+三闸，零持久化。
  createPreviewSandboxRoutes(app, { resolveUser });
  return { db };
}
