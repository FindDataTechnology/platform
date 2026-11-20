// ── 1.4：空组请求之后，数据面仍在 profile 里 ──────────────────────────────────
//
// harden-fleet-tool-face-and-queue 1.4（端到端）。前半段（`noteOwnerGroups`
// 拒绝用空组覆盖非空快照）已有单测，但单测只证明**快照没被改**；这条要回答的
// 是那之后的下一步：**下一份 `mcp.patch.yml` 里数据面还在不在**。
//
// 2026-11-09 的真实故障链是两跳：一个「带 owner email + 显式空 `x-forwarded-groups`
// 头」的请求把快照改写成 `[]`，于是下一次 profile 合成时 `requiredGroups` 门把数据面
// 整片摘掉（30 → 26 个 server，`fd-open-data-mcp` 消失），岗位侧表现为「这几件工具
// 没给当前角色开启」，而数据其实好的。所以判据必须落在**产物**（mcp.patch.yml）上，
// 不能只看快照。
//
// 三段，最后一段是红证方向的反面：
//   1. 有组的身份 ⇒ 数据面在（基线，证明夹具真的把它放进去了）
//   2. 空组头那次请求之后 ⇒ **数据面仍在**（这是 1.4 的判据）
//   3. 真撤销（`revokeAll`）之后 ⇒ 数据面**必须**被门摘掉
// 少了第 3 段，第 2 段就可能是「门根本没生效」造成的假绿。
//
//   node --test scripts/test-owner-groups-data-plane.mjs

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import yaml from "js-yaml";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "owner-groups-plane-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.DSH_HOME = path.join(tmpRoot, "dsh-home");
process.env.MCP_CONFIG_PATH = path.join(tmpRoot, "mcp.json");
mkdirSync(process.env.PLATFORM_DATA_DIR, { recursive: true });
writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers: {} }));

const db = await import("../db.js");
await db.initDb();
const extensionStore = await import("../extension-store.js");
const ownerGroups = await import("../server/owner-groups.js");
const { writeMcpPatch } = await import("../dsh-profile.js");

const OWNER = "owner@lane.test";
const DATA_PLANE = "fd-open-data-mcp";
const DATA_GROUPS = ["data", "team"];

// 数据面这一行**带 requiredGroups**——线上就是组门控的，正是被抹掉的那一层。
extensionStore.addMcpServer({
  name: DATA_PLANE,
  config: { url: "http://127.0.0.1:9/mcp" },
  enabled: true,
  requiredGroups: ["data"],
});

const patchPath = path.join(process.env.DSH_HOME, "profiles", "platform", "mcp.patch.yml");

/**
 * 当前 profile 里的 server 名集合（失败即「这份 patch 还没写出来」）。
 *
 * 形状照抄产物本身，不照抄记忆：`writeMcpPatch` 写的是
 * `- insert: [{ id: mcp-<name>, name: @deepseek-ai/dsh-mcp-client, config: { serverName } }]`
 * ——条目是**数组**、真名在 `config.serverName`。第一版按 `{name: config}` 映射去解，
 * 于是基线那条就已经 `false`（什么都没证明就红），正是「解析别人的输出要照抄它的
 * 格式化函数」那条坑。两种形状都认，谁在用它都读得出来。
 */
function servers() {
  const rows = yaml.load(readFileSync(patchPath, "utf8"));
  const names = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const insert = row && typeof row === "object" ? row.insert : null;
    if (!insert) continue;
    if (Array.isArray(insert)) {
      for (const entry of insert) {
        const name = entry?.config?.serverName
          ?? (typeof entry?.id === "string" ? entry.id.replace(/^mcp-/, "") : null);
        if (name) names.add(name);
      }
    } else {
      for (const [key, entry] of Object.entries(insert)) {
        names.add(entry?.config?.serverName ?? key);
      }
    }
  }
  return names;
}

/** 用**快照里现在的组**重写一份 profile——真实路径就是这么取 userGroups 的。 */
async function rewrite() {
  const snap = ownerGroups.readOwnerGroups();
  await writeMcpPatch({ ownerEmail: OWNER, userGroups: snap?.groups ?? null });
}

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

test("空组请求之后，下一份 mcp.patch.yml 仍含数据面", async () => {
  // 1. 基线：身份带着组，数据面必须在。
  assert.equal(
    ownerGroups.noteOwnerGroups({ email: OWNER, groups: DATA_GROUPS }),
    true,
    "首次写入快照应该返回 true（否则夹具没建起来，后面的断言都是空的）",
  );
  await rewrite();
  assert.ok(servers().has(DATA_PLANE), "基线：有组的身份看得见数据面");

  // 2. 2026-11-09 那一次：owner email + 显式空组头。
  assert.equal(
    ownerGroups.noteOwnerGroups({ email: OWNER, groups: [] }),
    false,
    "空组不得覆盖非空快照",
  );
  assert.deepEqual(ownerGroups.readOwnerGroups().groups, DATA_GROUPS, "快照没被抹");

  await rewrite();
  assert.ok(
    servers().has(DATA_PLANE),
    "空组请求之后数据面仍在 mcp.patch.yml 里 —— 1.4 的判据（2026-11-09 时这里 30→26）",
  );

  // 3. 反向：真的全量撤销之后，门必须把它摘掉 —— 否则上面两条断言证明不了门在生效。
  //
  // 判据落在 `entries`（过滤后的组合结果）而不是盘上那份文件，因为写文件这一段有
  // 自己的形态：`fileEntries.length === 0` 时 `writeMcpPatch` 打一行
  // `[dsh-profile] no MCP servers configured; skipping --patch` 然后 **return**，
  // **盘上那份旧 patch 原样留着**。于是「撤销之后盘上还看得见数据面」是现行的真实
  // 行为，不是本用例要验的东西（2026-11-16 实测；已在 tasks.md 里单列为新发现）。
  // 这条臂只回答「组门确实按组摘行」——它红了说明过滤失效，不是文件没被重写。
  assert.equal(
    ownerGroups.noteOwnerGroups({ email: OWNER, groups: [] }, { revokeAll: true }),
    true,
    "显式 revokeAll 仍能清空快照",
  );
  assert.deepEqual(ownerGroups.readOwnerGroups().groups, [], "快照被清空");
  const revoked = await writeMcpPatch({
    ownerEmail: OWNER,
    userGroups: ownerGroups.readOwnerGroups().groups,
    returnEntries: true,
  });
  assert.ok(
    !revoked.entries.some((e) => e.config?.serverName === DATA_PLANE),
    "显式撤销后数据面的行被 requiredGroups 门摘掉——这条证明判据承重，不是恒真",
  );
});
