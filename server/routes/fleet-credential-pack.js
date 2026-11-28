// 舰队级凭据包读面（change converge-line-identity-and-keys 4.1）。
//
// 为什么要有这条路由：建舰队时属主面对的是"装了三个 pack、要填几套身份"这个
// 问题，而答案分散在各处的装包逻辑里。规划本身是纯函数
// （`server/lib/fleet-credential-pack.js`），这里只负责把**真实的**解析器喂给它：
//
//   packId → 已安装 pack 的 manifest → mcpServers[].registryName
//   registryName → 市场条目 → metadata.credential_ref → ref
//   ref → 装包时用的同一个连通性解析器（credentialConnected / MissingReason /
//         connectPath）+ 门归类（doorOf）
//
// 两处刻意的克制：
//   1. **不新增状态读面**。状态一律来自装包路径既有的解析器；界面上的连接页
//      仍然是 `/api/connections` 那一个投影。这条路由输出的是"要填几次、填哪
//      几处"，不是第二份连接状态。
//   2. **不写库**。规划是只读计算；真正的凭据落库仍走既有卡片。
//
// DB 不可用 = 503 而不是"不需要填"：后者是一句我们无法知道的话。

import { planFleetCredentials } from "../lib/fleet-credential-pack.js";
import { doorOfRef } from "../lib/credential-doors.js";
import { getFleetDatabase } from "./fleets-db.js";
import * as credentialRefs from "../../credential-refs.js";

function identity(req) {
  return req.ssoUser || req.user || null;
}

export function registerFleetCredentialPackRoutes(ctx) {
  const { app, db, extensionStore } = ctx;

  // 一个 server 名 → 规划器要的形状。查不到返回 null（规划器会点名，不当成
  // "不需要凭据"）。
  async function resolveServer(name, email) {
    let entry = null;
    try {
      entry = await extensionStore.findMarketMcpEntry(name);
    } catch {
      // 市场不可达 → 按"查不到"处理：不能替它编一个凭据要求。
      return null;
    }
    if (!entry) return null;
    const refName = credentialRefs.credentialRefForEntry(entry);
    if (!refName) return { refName: null, door: null, connected: true };
    return {
      refName,
      // 这里拿到的是**凭据 ref 名**（`wire-customer` / `lex`），连接页条目 id 是
      // 另一套（`line-wire-customer`）。用 doorOfRef 对齐，别直接查 DOOR_OF。
      door: doorOfRef(refName),
      connected: credentialRefs.credentialConnected(refName, email),
      missingReason: credentialRefs.credentialMissingReason(refName),
      connectPath: credentialRefs.connectPathForRef(refName),
    };
  }

  app.post("/api/fleets/credential-plan", async (req, res) => {
    const user = identity(req);
    const email = user?.email ?? null;
    if (ctx.authEnabled && !email) {
      return res.status(401).json({ error: "Authentication is required" });
    }
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Credential state is disabled (database unavailable)" });
    }

    const rawIds = Array.isArray(req.body?.packIds) ? req.body.packIds : [];
    let packIds = rawIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim());
    const fleetId = typeof req.body?.fleetId === "string" ? req.body.fleetId.trim() : "";

    // 两种入口：直接给 packIds（装配预览），或给 fleetId（打开某个舰队时问
    // "它要填几次"）。后者是界面真正需要的形状——建舰队对话框只有名字，成员
    // 是后加的，所以"装配"发生在舰队详情而不是创建弹窗。
    if (packIds.length === 0 && fleetId) {
      const fleets = getFleetDatabase();
      const fleet = fleets.getFleet(fleetId);
      if (!fleet) return res.status(404).json({ error: "fleet not found" });
      const owned = new Set();
      // 模板建出来的舰队把来源 pack 记在 fleet 上；成员各自也可能带 packId。
      if (typeof fleet.sourceTemplate?.packId === "string") owned.add(fleet.sourceTemplate.packId);
      for (const member of fleets.listMembers(fleetId)) {
        if (typeof member?.packId === "string" && member.packId) owned.add(member.packId);
      }
      packIds = [...owned];
    }

    if (packIds.length === 0) {
      // 空舰队是合法状态（还没装 pack），不是错误——但也不能回一句"已满足"
      // 让人以为测过了。这里如实回 200 + 空计划 + emptyReason。
      if (fleetId) {
        return res.json({
          doors: [],
          fillsRequired: 0,
          fills: [],
          satisfied: true,
          unknown: [],
          noCredential: [],
          unclassified: [],
          missingPacks: [],
          emptyReason: "fleet has no pack-backed members yet",
          asOf: new Date().toISOString(),
        });
      }
      return res.status(400).json({ error: "packIds or fleetId required" });
    }

    const packs = [];
    const missingPacks = [];
    for (const packId of packIds) {
      const installed = db.getInstalledPack(packId);
      if (!installed) {
        missingPacks.push(packId);
        continue;
      }
      const servers = (installed.manifest?.mcpServers ?? [])
        .map((m) => (typeof m?.registryName === "string" ? m.registryName : null))
        .filter(Boolean);
      packs.push({ packId, servers });
    }

    // 同一个 server 可能在多个 pack 里出现：只解析一次。
    const names = [...new Set(packs.flatMap((p) => p.servers))];
    const cache = new Map();
    await Promise.all(
      names.map(async (name) => {
        cache.set(name, await resolveServer(name, email));
      }),
    );
    const plan = planFleetCredentials({
      packs,
      resolveServer: (name) => cache.get(name) ?? null,
    });

    res.json({
      ...plan,
      // 没装过的 pack 单独列：它是"这一项压根不存在"，不是"不需要凭据"。
      missingPacks,
      // 回带来源，便于界面说清"这份计划是拿哪几个 pack 算出来的"——
      // 没有来源的数字最容易被相信，也最容易被误读。
      fleetId: fleetId || null,
      packIds,
      asOf: new Date().toISOString(),
    });
  });
}
