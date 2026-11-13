// ── kf 通道的数据库句柄 ─────────────────────────────────────────────────────
//
// 与 `server/routes/fleets-db.js` 同一个模式：模块自持一个文件库，导出单例 getter
// 与 `setKfDatabase` 供测试注入。
//
// 为什么单独一个库而不是进 cell 主库：kf 的数据来源是外部接口，生命周期与主库不同
// （可以整库删掉重拉），而且它的表全是本模块自建的。放一起会让「回滚=摘通道」
// 变成「回滚=删表」，风险不对称。
//
// ⚠ 用 `node:sqlite`（`DatabaseSync`），而 cell 主库是 `better-sqlite3`。
// 我们的 store 层只用了 `.exec / prepare().run/get/all` 这五个方法，两边行为一致，
// 所以同一份 store 代码也能跑在注入的 better-sqlite3 连接上——测试正是在验证这一点。

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { storeDir } from "../../../paths.js";
import { ensureKfSchema } from "./store.js";

let kfDb = null;

export function createKfDatabase({ file } = {}) {
  const dbPath = file || process.env.KF_DB || path.join(storeDir("data"), "kf.db");
  const dir = path.dirname(dbPath);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  ensureKfSchema(db);
  return db;
}

export function getKfDatabase() {
  if (!kfDb) kfDb = createKfDatabase({});
  return kfDb;
}

export function setKfDatabase(db) {
  kfDb = db;
}

/** 只读视图的默认数量上限，避免一次请求把整库吐出来。 */
export const KF_ROUTE_LIMITS = { messages: 200, conversations: 50, search: 50, inbox: 50 };
