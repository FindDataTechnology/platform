// Blueprint persistence (add-blueprint-studio Slice 1, tasks 1.1/1.3).
//
// 蓝图 = 与活舰队独立的资产对象（design D2）：自己的实体、版本号、批准
// 流水、铸造追溯、试跑报告位。Storage pattern mirrors fleets-db.js（per-cell
// sqlite file、WAL、snake_case columns、camelCase API）；测试以构造器注入
// `file` 重指到 tmp——不走环境变量（design 实施口径对账）。
//
// 凭据禁带闸（task 1.3 / spec「蓝图不含凭据」）：create/update 落笔前先过
// blueprint-validate.js 的凭据扫描——携带端点/token/secret 的蓝图在任何写
// 路径（路由、脚本、未来执行器）上都结构性不可存储。

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { storeDir } from "../../paths.js";
import { credentialFindings, v1FormatFindings } from "../blueprint-validate.js";

export const BLUEPRINT_STATUSES = ["draft", "approved", "cast"];

// Stored blueprints NEVER contain credentials (spec scenario 蓝图不含凭据) and are
// always the v2 shape (remove-blueprint-v1-compat) — this is the storage-layer
// enforcement; route-layer reporting is advisory only. v1 dialect is not "an
// unfilled WIP draft" but a different set of key names the form can never fill in,
// so it is structurally unstorable too. Throws a status-marked error the routes
// map to 422.
function assertStorable(content) {
  const v1 = v1FormatFindings(content);
  if (v1.length) {
    throw Object.assign(
      // 只取首行：多行迁移指引走 findings，message 保持单行可读。
      new Error(v1[0].error.split("\n")[0]),
      { status: 422, findings: v1 },
    );
  }
  const findings = credentialFindings(content);
  if (findings.length) {
    throw Object.assign(
      new Error(`blueprint carries forbidden endpoint/credential material: ${findings[0].error}`),
      { status: 422, findings },
    );
  }
}

export function createBlueprintDatabase({ file } = {}) {
  const dbPath = file || path.join(storeDir("data"), "blueprints.db");

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  // created_at/updated_at 是机器时间戳（ms int，随 fleets 仓俗）；approved_at
  // 是批准凭据（ISO 文本，原样进铸造追溯 _casting 段）。
  db.exec(`CREATE TABLE IF NOT EXISTS blueprints (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL,
    name TEXT NOT NULL,
    one_line TEXT NOT NULL DEFAULT '',
    out_of_scope TEXT NOT NULL DEFAULT '',
    content_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    version INTEGER NOT NULL DEFAULT 1,
    approved_by TEXT,
    approved_at TEXT,
    diff_summary TEXT,
    cast_pack_id TEXT,
    cast_pack_version INTEGER,
    trial_report_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS blueprints_owner_idx ON blueprints(owner_email, updated_at DESC)`);

  function deserialize(row) {
    if (!row) return null;
    return {
      id: row.id,
      ownerEmail: row.owner_email,
      name: row.name,
      oneLine: row.one_line,
      outOfScope: row.out_of_scope,
      content: JSON.parse(row.content_json),
      status: row.status,
      version: row.version,
      approvedBy: row.approved_by ?? null,
      approvedAt: row.approved_at ?? null,
      diffSummary: row.diff_summary ?? null,
      castPackId: row.cast_pack_id ?? null,
      castPackVersion: row.cast_pack_version ?? null,
      trialReport: row.trial_report_json ? JSON.parse(row.trial_report_json) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // 清单行不驮 content / trial report 两个重列。
  function deserializeSummary(row) {
    return {
      id: row.id,
      ownerEmail: row.owner_email,
      name: row.name,
      oneLine: row.one_line,
      // add-agent-builder-workspace 4.4: 清单行投影 kind（正文缺省 team），
      // 文档库/最近文档板按 kind 统一列并出徽章。
      kind: row.kind_json === "agent" ? "agent" : "team",
      status: row.status,
      version: row.version,
      approvedBy: row.approved_by ?? null,
      approvedAt: row.approved_at ?? null,
      castPackId: row.cast_pack_id ?? null,
      castPackVersion: row.cast_pack_version ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  return {
    createBlueprint({ id, ownerEmail, name, oneLine = "", outOfScope = "", content }) {
      assertStorable(content);
      const now = Date.now();
      db.prepare(
        `INSERT INTO blueprints (id, owner_email, name, one_line, out_of_scope, content_json, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?)`,
      ).run(id, ownerEmail, name, oneLine, outOfScope, JSON.stringify(content), now, now);
      return deserialize(db.prepare("SELECT * FROM blueprints WHERE id = ?").get(id));
    },

    getBlueprint(id) {
      return deserialize(db.prepare("SELECT * FROM blueprints WHERE id = ?").get(id));
    },

    listBlueprints(ownerEmail) {
      return db
        .prepare(
          `SELECT id, owner_email, name, one_line, status, version, approved_by, approved_at,
                  cast_pack_id, cast_pack_version, created_at, updated_at,
                  json_extract(content_json, '$.kind') AS kind_json
           FROM blueprints WHERE owner_email = ? ORDER BY updated_at DESC`,
        )
        .all(ownerEmail)
        .map(deserializeSummary);
    },

    // 编辑 = 新草稿版：version +1 并清旧批准（approved_by/at 置空）——旧稿
    // 批准永不延用给新稿（否则 apply 重校验兜底形同虚设）。cast 追溯作为
    // 上一次铸造的谱系记录保留；status 一律回到 draft（新版未经批准与铸造）。
    updateBlueprintContent(id, { name, oneLine, outOfScope, content, diffSummary }) {
      const row = db.prepare("SELECT * FROM blueprints WHERE id = ?").get(id);
      if (!row) return null;
      assertStorable(content);
      db.prepare(
        `UPDATE blueprints
         SET name = ?, one_line = ?, out_of_scope = ?, content_json = ?,
             status = 'draft', version = version + 1,
             approved_by = NULL, approved_at = NULL, diff_summary = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        name ?? row.name,
        oneLine ?? row.one_line,
        outOfScope ?? row.out_of_scope,
        JSON.stringify(content),
        diffSummary ?? null,
        Date.now(),
        id,
      );
      return deserialize(db.prepare("SELECT * FROM blueprints WHERE id = ?").get(id));
    },

    // 批准凭据：批准人 + ISO 时间。diff_summary 已在编辑时落定，批准只盖戳。
    stampApproval(id, { by, at }) {
      db.prepare(
        `UPDATE blueprints SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?`,
      ).run(by, at, Date.now(), id);
      return deserialize(db.prepare("SELECT * FROM blueprints WHERE id = ?").get(id));
    },

    stampCast(id, { packId, packVersion }) {
      db.prepare(
        `UPDATE blueprints SET status = 'cast', cast_pack_id = ?, cast_pack_version = ?, updated_at = ? WHERE id = ?`,
      ).run(packId, packVersion, Date.now(), id);
      return deserialize(db.prepare("SELECT * FROM blueprints WHERE id = ?").get(id));
    },

    // 删除（构造间卫生）：只许删「从未铸造」的草稿/已批准稿——一旦有
    // cast_pack_id，市场里的包才是账，删蓝图会留下孤儿包（路由层拦）。
    deleteBlueprint(id) {
      const row = db.prepare("SELECT cast_pack_id FROM blueprints WHERE id = ?").get(id);
      if (!row) return false;
      if (row.cast_pack_id) return false;
      db.prepare("DELETE FROM blueprints WHERE id = ?").run(id);
      return true;
    },

    // 试跑报告位（task 4.x 的存储半）——执行器随 Slice 3 接入，这里只落/读。
    saveTrialReport(id, report) {
      db.prepare(`UPDATE blueprints SET trial_report_json = ?, updated_at = ? WHERE id = ?`).run(
        JSON.stringify(report),
        Date.now(),
        id,
      );
      return deserialize(db.prepare("SELECT * FROM blueprints WHERE id = ?").get(id));
    },

    close() {
      db.close();
    },
  };
}

// Export singleton (server.js uses the default per-cell file; tests inject).
let blueprintDb = null;

export function getBlueprintDatabase() {
  if (!blueprintDb) {
    blueprintDb = createBlueprintDatabase({});
  }
  return blueprintDb;
}

export function setBlueprintDatabase(db) {
  blueprintDb = db;
}
