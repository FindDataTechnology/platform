// Database persistence for agent fleets (agent-fleet-core).
//
// Two tables: fleets (the organization) and fleet_members (the stable posts —
// ADR-0031: a member row IS the post; the incumbent rides targetKind/targetId
// and can be swapped without touching the row's identity, tree position, or
// KPI slot declarations). Storage pattern mirrors clusters-db.js (per-cell
// sqlite file, WAL, snake_case columns, camelCase API).

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { storeDir } from "../../paths.js";
import * as dbModule from "../../db.js";
import { mergeMandatePolicies, normalizeMandatePolicy } from "../../lib/personal-mandate.js";
import { normalizeDomainMap } from "../../lib/personal-domain-map.js";
import { normalizeRuleText, ruleKey } from "../../lib/precedent-candidate.js";
import { classifyLegacyDecision, normalizeLegacyGrade } from "../../lib/precedent-grade.js";

export const FLEET_STATES = ["active", "paused", "archived"];
export const MEMBER_TARGET_KINDS = ["persona", "cluster", "a2a", "tool", "auditor"];

// 哪些岗位承载类型跑的是「一个对话 persona」。凡是按 persona 分流的判断
// （归因、解析、模型声明、编导边上下文注入）都该问这个函数，而不是各自写
// `=== "persona"`——2026-11-10 加了第五种类型 auditor，散落的比较漏了十几处，
// 表现全是静默降级（审计官被判待补岗、它的上报归因不到）。
export const PERSONA_BACKED_KINDS = Object.freeze(["persona", "auditor"]);
export function isPersonaBackedTargetKind(kind) {
  return PERSONA_BACKED_KINDS.includes(kind);
}

export function createFleetDatabase({ file } = {}) {
  const dbPath = file || path.join(storeDir("data"), "fleets.db");

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`CREATE TABLE IF NOT EXISTS fleets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS fleet_members (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    title TEXT NOT NULL,
    parent_id TEXT,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    kpi_slots TEXT NOT NULL DEFAULT '[]',
    cadence TEXT,
    sort_key INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  // Report lane (agent-fleet-report-lane): append-only status reports. One row
  // per report_status call (source=self) or per finished a2a turn (source=
  // derived — the execution summary). latest/timeline are query-time
  // aggregations; nothing is ever mutated here.
  db.exec(`CREATE TABLE IF NOT EXISTS member_reports (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    session_id TEXT,
    metrics TEXT NOT NULL DEFAULT '{}',
    resources TEXT NOT NULL DEFAULT '[]',
    blockers TEXT NOT NULL DEFAULT '[]',
    summary TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'self',
    created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_member_reports_member ON member_reports(member_id, created_at)`);

  // Decision lane (agent-fleet-decision-lane): the owner's approval queue.
  // State machine: open → approved|rejected → delivered; open → expired →
  // (owner reopens) → open. `resolution` is JSON {kind, choice?, note?, by,
  // at}; expiry is fleet-policy driven (suggestedDeadline is display-only).
  db.exec(`CREATE TABLE IF NOT EXISTS decision_items (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'normal',
    suggested_deadline TEXT,
    recommendation TEXT,
    state TEXT NOT NULL DEFAULT 'open',
    resolution TEXT,
    source_session_id TEXT,
    submitted_at INTEGER NOT NULL,
    resolved_at INTEGER,
    delivered_at INTEGER,
    delivered_session_id TEXT
  )`);
  // 判例候选 (widen-deputy-to-personal-domains 4.x)：主人推翻代理时蒸馏出的
  // 候选规则。永不直接生效——只有主人批准后才可被引用为判例。
  // `rule_key` 是归一化文本的稳定哈希：同一条规则不重复呈审，被拒过的那条
  // 再提上来时能被立刻认出来。
  db.exec(`CREATE TABLE IF NOT EXISTS precedent_candidates (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    domain TEXT,
    rule_text TEXT NOT NULL,
    rule_key TEXT NOT NULL,
    source_decision_id TEXT,
    status TEXT NOT NULL DEFAULT 'candidate',
    proposed_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT,
    reject_reason TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_precedent_candidates_fleet ON precedent_candidates(fleet_id, status)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_precedent_candidates_key ON precedent_candidates(fleet_id, rule_key)`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_items_fleet_state ON decision_items(fleet_id, state)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_items_member ON decision_items(member_id, state)`);

  // Existing fleets gain the decision policy column (fleet-level expiry; the
  // design default is 72h, 0 = off — never per-post deadlines).
  try {
    db.exec(`ALTER TABLE fleets ADD COLUMN decision_policy TEXT`);
  } catch {
    /* column already exists */
  }
  // Template provenance (agent-fleet-templates D5): the packId+version a
  // fleet was instantiated from — the dedup anchor for re-installs and the
  // "template has a newer version" notice (D7: notice only, never migrates).
  try {
    db.exec(`ALTER TABLE fleets ADD COLUMN source_template TEXT`);
  } catch {
    /* column already exists */
  }

  // 迭代回路 (fleet-owner-iteration): 提议型拍板项的类型键与附件（diff/
  // changes/callbackResult）——旧行向后兼容 (NULL='decision'，与既有语义
  // 零差异）。decision lane 是唯一审批面，这是“审批单不另建表”的落点。
  try {
    db.exec(`ALTER TABLE decision_items ADD COLUMN item_type TEXT`);
    db.exec(`ALTER TABLE decision_items ADD COLUMN detail TEXT`);
  } catch {
    /* columns already exist */
  }

  // 拍板委托 (add-deputy-decision-delegate): 路由与裁决者维度。
  //   route        — owner|deputy：这条 open 项等谁（escalate 时按委托策略
  //                  同步打上；策略只影响路由，不改变状态机）。
  //   resolved_by  — owner|deputy：谁裁的（审计的根；此前无从得知）。
  //   resolved_by_model / ruling_evidence — deputy 裁决所用模型与依据（含
  //                  引用的主人判例）。既有行 route='owner' 回填，与未启用
  //                  委托前语义逐字段一致。
  //   executed_at / executed_session_id — 送达回合完成时回填的执行事实；
  //                  delivered 且无 executed_at = 「批了没执行」。
  try {
    db.exec(`ALTER TABLE decision_items ADD COLUMN route TEXT NOT NULL DEFAULT 'owner'`);
    db.exec(`ALTER TABLE decision_items ADD COLUMN resolved_by TEXT`);
    db.exec(`ALTER TABLE decision_items ADD COLUMN resolved_by_model TEXT`);
    db.exec(`ALTER TABLE decision_items ADD COLUMN ruling_evidence TEXT`);
    db.exec(`ALTER TABLE decision_items ADD COLUMN executed_at INTEGER`);
    db.exec(`ALTER TABLE decision_items ADD COLUMN executed_session_id TEXT`);
    db.exec(`ALTER TABLE decision_items ADD COLUMN category TEXT`);
    db.exec(`ALTER TABLE decision_items ADD COLUMN topic_key TEXT`);
    db.exec(`ALTER TABLE decision_items ADD COLUMN escalations INTEGER NOT NULL DEFAULT 0`);
    db.exec(`ALTER TABLE decision_items ADD COLUMN last_escalated_at INTEGER`);
  } catch {
    /* columns already exist */
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_items_route ON decision_items(fleet_id, route, state)`);

  // 委托审计流水：每次 escalate（新建或归并）一行——防洪上限与"这条阻塞被升级
  // 过几次"都从这里读，而不是从拍板项行数推断（归并不落新行）。
  db.exec(`CREATE TABLE IF NOT EXISTS decision_escalations (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    merged INTEGER NOT NULL DEFAULT 0,
    source_session_id TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_escalations_member ON decision_escalations(member_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_escalations_decision ON decision_escalations(decision_id)`);

  // cell 级设置（委托策略等）：同库同迁移路径的最小 KV——value 为 JSON 文本。
  db.exec(`CREATE TABLE IF NOT EXISTS cell_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  // 舰队级委托覆写（add-deputy-decision-delegate）：JSON 列，NULL = 全用 cell 默认。
  try {
    db.exec(`ALTER TABLE fleets ADD COLUMN delegation_policy TEXT`);
  } catch {
    /* column already exists */
  }

  // 个人事务域 (widen-deputy-to-personal-domains)：事项从哪个域进来、判例
  // 来源等级、审计官结论。可空，凡未命中映射的条目保持 domain=NULL（即既有
  // 舰队内部车道，category 词汇原样不动）。
  //
  // 判例等级的回填刻意保守：存量一律 deputy-ruled（不可引用为判例）。今天的
  // 记录分辨不出「主人手打」还是「原样发了代理的稿」，把来历不明的行变成判断
  // 依据，比判例变少危险得多。
  try {
    db.exec("ALTER TABLE decision_items ADD COLUMN domain TEXT");
  } catch {
    /* column already exists */
  }
  try {
    db.exec("ALTER TABLE decision_items ADD COLUMN precedent_grade TEXT");
  } catch {
    /* column already exists */
  }
  try {
    db.exec("ALTER TABLE decision_items ADD COLUMN auditor_verdict TEXT");
  } catch {
    /* column already exists */
  }
  try {
    db.exec("ALTER TABLE decision_items ADD COLUMN auditor_note TEXT");
  } catch {
    /* column already exists */
  }
  // 撤销窗 (agent-decided-learning-loop 5.4)：解锁的高影响类别由代理裁决后，
  // 生效时落一个到期时刻；未到期前主人可撤销。NULL = 不可撤销（未解锁的类别
  // 本来就不该被代理裁决，这条对它无意义）。
  try {
    db.exec("ALTER TABLE decision_items ADD COLUMN revocable_until INTEGER");
  } catch {
    /* column already exists */
  }
  try {
    db.exec("ALTER TABLE decision_items ADD COLUMN revoked_at INTEGER");
  } catch {
    /* column already exists */
  }
  // 存量回填（2026-11-10 修订）：此前是一刀切 'deputy-ruled'，把主人自己的裁决
  // 也废掉了。拍板车道里主人的裁决本身就是他的判断——那条车道没有「代理起草、
  // 原件发出」的情形。改为按行内可证事实细分；分不清的仍然保守。
  // 只填 NULL，绝不覆盖已有等级（幂等，且不回头改已判定的行）。
  try {
    const ungraded = db
      .prepare("SELECT id, resolved_by, recommendation, resolution FROM decision_items WHERE precedent_grade IS NULL")
      .all();
    if (ungraded.length) {
      const upd = db.prepare("UPDATE decision_items SET precedent_grade = ? WHERE id = ? AND precedent_grade IS NULL");
      const tx = db.transaction((rows) => {
        for (const row of rows) {
          let resolution = null;
          try {
            resolution = row.resolution ? JSON.parse(row.resolution) : null;
          } catch {
            resolution = null;
          }
          upd.run(
            classifyLegacyDecision({ resolvedBy: row.resolved_by, recommendation: row.recommendation, resolution }),
            row.id,
          );
        }
      });
      tx(ungraded);
    }
  } catch (err) {
    // 回填失败不能拦住开库：列已在，等级留空 = 不可引用（保守侧）。
    console.warn(`[fleets-db] precedent backfill skipped: ${err.message}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_decision_items_domain ON decision_items(domain)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_decision_items_grade ON decision_items(precedent_grade)");

  // 迭代链状态 (fleet-owner-iteration): 现行实例白名单导出→既有发布链的
  // 编排器状态行——提出的改动链路全部事实源都在这里。
  db.exec(`CREATE TABLE IF NOT EXISTS fleet_iterations (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    pack_id TEXT NOT NULL,
    decision_id TEXT,
    state TEXT NOT NULL,
    axis TEXT,
    note TEXT NOT NULL DEFAULT '',
    notes TEXT,
    published_version INTEGER,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fleet_iterations_fleet ON fleet_iterations(fleet_id, created_at)`);

  // 报数 digest 订阅 (fleet-owner-iteration): 决定性渲染+账内 unread 语义
  // (session last-updated 派生) ，last_sent_at 为停机补跑的窗口事实源。
  db.exec(`CREATE TABLE IF NOT EXISTS fleet_digest_subscriptions (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    cadence TEXT NOT NULL,
    last_run_at INTEGER,
    last_sent_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (fleet_id, owner_email, cadence)
  )`);

  // Post-level models (add-fleet-post-model D9): nullable declarations — the
  // member's primary + fallback and the fleet default that doubles as the
  // availability fallback. Nullable by design: unset = inherit down the
  // resolution chain, so a rolled-back deployment needs no data migration.
  try {
    db.exec(`ALTER TABLE fleet_members ADD COLUMN model TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE fleet_members ADD COLUMN fallback_model TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE fleets ADD COLUMN default_model TEXT`);
  } catch {
    /* column already exists */
  }
  // Config dimensions beyond the model (add-agent-config-dims): thinking depth
  // and a per-turn context budget, declared at post AND fleet level with the
  // same inherit-down semantics as models. Nullable by design — unset = inherit
  // = byte-identical to before, and a rollback needs no data migration.
  for (const col of [
    "ALTER TABLE fleet_members ADD COLUMN effort TEXT",
    "ALTER TABLE fleet_members ADD COLUMN context_budget INTEGER",
    // Turn carrier (add-fleet-carrier): the member's placement dimension —
    // cell | worker | runner | auto (null = unset). Null reads as unset so the
    // three-layer resolution falls through to fleet/deployment/auto.
    "ALTER TABLE fleet_members ADD COLUMN carrier TEXT",
    // Runner disambiguation (add-runner-packid-disambiguation): the optional
    // pack binding for cross-pack same-key agent keys — null = the agent key
    // alone decides (unique hit) or the ambiguity fails open.
    "ALTER TABLE fleet_members ADD COLUMN pack_id TEXT",
    "ALTER TABLE fleets ADD COLUMN effort TEXT",
    "ALTER TABLE fleets ADD COLUMN context_budget INTEGER",
  ]) {
    try {
      db.exec(col);
    } catch {
      /* column already exists */
    }
  }
  // 输入策略（add-input-request-cards D8）：舰队与岗位两层声明、逐字段继承。
  // 可空 = 不声明 = 与引入前字节一致；回滚只需置空，不需要数据迁移。
  for (const col of [
    "ALTER TABLE fleets ADD COLUMN input_policy TEXT",
    "ALTER TABLE fleet_members ADD COLUMN input_policy TEXT",
  ]) {
    try {
      db.exec(col);
    } catch {
      /* column already exists */
    }
  }
  // Orchestration section (add-fleet-orchestration): the declarative edge
  // grammar — nullable, JSON, validated at the route write face. Unset =
  // schedule = byte-identical behavior.
  try {
    db.exec(`ALTER TABLE fleets ADD COLUMN orchestration TEXT`);
  } catch {
    /* column already exists */
  }

  // Team console publication (add-pack-console D5): the slug a share page is
  // addressed by, plus when it was published. Both nullable — unset means the
  // console is NOT public, which is the default and the safe state. The slug is
  // server-derived (never user-chosen) so nobody can squat or impersonate a
  // name; uniqueness is enforced by an index created alongside.
  for (const col of [
    "ALTER TABLE fleets ADD COLUMN console_slug TEXT",
    "ALTER TABLE fleets ADD COLUMN console_published_at INTEGER",
  ]) {
    try {
      db.exec(col);
    } catch {
      /* column already exists */
    }
  }
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fleets_console_slug ON fleets(console_slug) WHERE console_slug IS NOT NULL`);
  } catch {
    /* index exists */
  }

  // Fleet row audit (add-fleet-row-update-audit): the DB-layer half. An
  // AFTER UPDATE trigger catches EVERY writer — including processes outside
  // the platform: a bare sqlite UPDATE leaves no application log, which is
  // why the 2026-10-24 orchestration resets could not be attributed. The
  // trigger records WHAT changed; the application half (updateFleet's meta)
  // backfills actor/via on the row it just caused. Trigger-with-attribution =
  // an in-platform write; trigger-without = out-of-process — the
  // adjudication rule for the next recurrence. updated_at is excluded: it is
  // dirty on every write and carries no signal.
  db.exec(`CREATE TABLE IF NOT EXISTS fleet_row_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    fleet_id TEXT NOT NULL,
    changed_columns TEXT NOT NULL,
    orchestration_old TEXT,
    orchestration_new TEXT,
    actor TEXT,
    via TEXT
  )`);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS fleets_audit_after_update
    AFTER UPDATE ON fleets
    BEGIN
      INSERT INTO fleet_row_audit (ts, fleet_id, changed_columns, orchestration_old, orchestration_new)
      VALUES (
        CAST(strftime('%s','now') AS INTEGER) * 1000,
        NEW.id,
        '[' || trim(
          CASE WHEN NEW.name IS NOT OLD.name THEN '"name",' ELSE '' END ||
          CASE WHEN NEW.state IS NOT OLD.state THEN '"state",' ELSE '' END ||
          CASE WHEN NEW.decision_policy IS NOT OLD.decision_policy THEN '"decision_policy",' ELSE '' END ||
          CASE WHEN NEW.source_template IS NOT OLD.source_template THEN '"source_template",' ELSE '' END ||
          CASE WHEN NEW.default_model IS NOT OLD.default_model THEN '"default_model",' ELSE '' END ||
          CASE WHEN NEW.orchestration IS NOT OLD.orchestration THEN '"orchestration",' ELSE '' END
        , ',') || ']',
        OLD.orchestration,
        NEW.orchestration
      );
    END
  `);

  // Turn result events (add-fleet-turn-events): append-only per-turn outcome
  // records — one row per finished member turn (cron / manual / delegation),
  // written at the runCronJobTurn seam. System records, never agent-authored:
  // reports are content, these are facts. Bounded by rolling prune per member
  // (appendTurnEvent); reports and decisions never share this store.
  db.exec(`CREATE TABLE IF NOT EXISTS member_turn_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fleet_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    error_kind TEXT,
    error TEXT,
    model TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    session_id TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_events_member ON member_turn_events(member_id, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_events_fleet ON member_turn_events(fleet_id, status, id)`);

  // Run ledger (add-fleet-cockpit-v2, agent-fleet-runs D1/D2): the execution
  // instance. One header row per run; the turn rows carry run_id plus their
  // chain position (parent_turn_id × edge_kind), so an edge instance IS the
  // downstream turn row — no hops table. `turn_id` is minted when the turn
  // STARTS (dispatch happens mid-turn and needs the upstream id before the row
  // exists) and is distinct from the autoincrement `id`, which keeps the table
  // append-only. Everything is additive and nullable: pre-v2 rows read as v1
  // history (run_id null), a rollback needs no down-migration.
  db.exec(`CREATE TABLE IF NOT EXISTS fleet_runs (
    run_id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    root_source TEXT NOT NULL,
    root_member_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL DEFAULT 'open',
    turns INTEGER NOT NULL DEFAULT 0,
    ok_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    usage_input INTEGER,
    usage_output INTEGER
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fleet_runs_fleet ON fleet_runs(fleet_id, started_at)`);
  // Run stop (add-fleet-run-budget): a run stops either because the owner
  // cancelled it or because it hit its declared budget. Separate columns, NOT a
  // status value — `finalizeRun` recomputes `status` from the turn rows and
  // would overwrite a status-based flag on the next settle.
  for (const col of ["stopped_at INTEGER", "stop_reason TEXT"]) {
    try {
      db.exec(`ALTER TABLE fleet_runs ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }
  for (const col of [
    "turn_id TEXT",
    "run_id TEXT",
    "parent_turn_id TEXT",
    "edge_kind TEXT",
    "usage_input INTEGER",
    "usage_output INTEGER",
    "trace_turn_id TEXT",
    // fix-fleet-turn-attribution D1: per-turn attribution summary (timeout
    // stalled/budget shape, degradedTo, laneId) as one JSON column — it is
    // read by row, never queried, and old rows read as honest absence.
    "detail TEXT",
    // ── turn metering (add-turn-metering) ── aggregate fields become COLUMNS
    // (detail is read by row, never queried); an absent dimension or unreported
    // runtime field reads as NULL — honest absence, never a 0 impersonating an
    // observation. usage_input keeps the upstream semantic (UNCACHED input);
    // billed input = input + cached_input + cache_write summed at query time.
    "preset_id TEXT",
    "preset_source TEXT",
    "provider TEXT",
    "effort TEXT",
    "carrier TEXT",
    "carrier_instance TEXT",
    "lane_id TEXT",
    "depth INTEGER",
    "wave INTEGER",
    "usage_cached_input INTEGER",
    // Per-request high-watermark (2026-11-11): the largest single request's
    // prompt (input + cacheRead) the runtime reported for this turn. Added
    // because `usage_input` / `usage_cached_input` are TURN SUMS across steps —
    // dividing a sum by the per-request window produced ratios above 1.0
    // (measured 1.54, 1.06) that read like occupancy but are not. Nullable on
    // purpose: a turn whose runtime reported no stream usage carries NULL, and
    // an absent number must never be replaced by the sum it cannot equal.
    "usage_input_max INTEGER",
    "usage_cache_write INTEGER",
    "usage_reasoning INTEGER",
    "queue_wait_ms INTEGER",
    "spin_up_ms INTEGER",
    "ttft_ms INTEGER",
    // Turn pricing (add-turn-pricing): the price-table version stamp.
    "pricing_at INTEGER",
    // Cost read face (add-fleet-cost-read-face): the four estimate components
    // now ALSO land on the turn row. The seam already computed them for the
    // daily rollup; without them a per-run / per-edge money slice could only be
    // re-priced at TODAY's rates, which would rewrite history. Nullable on
    // purpose — an unpriced turn carries NULL, never a 0 pretending to be an
    // observation. (Supersedes add-turn-pricing D4a's "money lives only on the
    // daily row": that rule made run/edge attribution structurally impossible.)
    "cost_input_usd REAL",
    "cost_output_usd REAL",
    "cost_cache_write_usd REAL",
    "cost_cache_read_usd REAL",
    // Runtime fingerprint (harden-agent-runtime-spine, runtime-fingerprint 3.3):
    // the configuration identity of the attempt, stamped at INSERT time. It is
    // NOT mutable — an attempt runs under one configuration — so it is safe on
    // an append-only row, and having it here means the version comparison reads
    // the same table it already aggregates cost and latency from (no join to
    // the claim for the common read). NULL = "no fingerprint was computed",
    // never a guessed one.
    "runtime_fingerprint TEXT",
  ]) {
    try {
      db.exec(`ALTER TABLE member_turn_events ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_events_turn_id ON member_turn_events(turn_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_events_run ON member_turn_events(run_id, started_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_events_member_ended ON member_turn_events(member_id, ended_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_events_carrier ON member_turn_events(carrier, started_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_events_model ON member_turn_events(model, started_at)`);

  // Daily rollup (add-turn-metering): one row per
  // (fleet, member, carrier, provider, model, UTC day), upserted at the same
  // write seam as the turn event. PERMANENT retention — the明细 prune (recent
  // N + window) must never touch these rows; this is the table the carrier
  // (切片⑤) and self-iteration (切片⑥) slices read for long-term trend.
  db.exec(`CREATE TABLE IF NOT EXISTS member_turn_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fleet_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    carrier TEXT,
    provider TEXT,
    model TEXT,
    day TEXT NOT NULL,
    turns INTEGER NOT NULL DEFAULT 0,
    ok_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    usage_input INTEGER NOT NULL DEFAULT 0,
    usage_cached_input INTEGER NOT NULL DEFAULT 0,
    usage_cache_write INTEGER NOT NULL DEFAULT 0,
    usage_reasoning INTEGER NOT NULL DEFAULT 0,
    usage_output INTEGER NOT NULL DEFAULT 0,
    queue_wait_ms_sum INTEGER NOT NULL DEFAULT 0,
    queue_wait_ms_max INTEGER,
    ttft_ms_sum INTEGER NOT NULL DEFAULT 0,
    ttft_ms_max INTEGER,
    spin_up_ms_sum INTEGER NOT NULL DEFAULT 0,
    spin_up_ms_max INTEGER,
    -- Turn pricing estimates (add-turn-pricing): USD REAL, accumulated per
    -- turn at the TURN-TIME price (a same-day price change never re-prices
    -- history). Only PRICED turns contribute — the turns counter includes
    -- everything, so the priced-sample size reads from pricing_at non-null.
    cost_input_usd REAL NOT NULL DEFAULT 0,
    cost_output_usd REAL NOT NULL DEFAULT 0,
    cost_cache_write_usd REAL NOT NULL DEFAULT 0,
    cost_cache_read_usd REAL NOT NULL DEFAULT 0,
    pricing_at INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE(fleet_id, member_id, carrier, provider, model, day)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_daily_day ON member_turn_daily(day)`);
  // add-turn-pricing: the daily table predates the cost columns on cells that
  // ran slice ② — same additive ALTER discipline as the events table (a
  // CREATE TABLE IF NOT EXISTS alone would silently skip them).
  for (const col of [
    "cost_input_usd REAL NOT NULL DEFAULT 0",
    "cost_output_usd REAL NOT NULL DEFAULT 0",
    "cost_cache_write_usd REAL NOT NULL DEFAULT 0",
    "cost_cache_read_usd REAL NOT NULL DEFAULT 0",
    "pricing_at INTEGER",
  ]) {
    try {
      db.exec(`ALTER TABLE member_turn_daily ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_fleet_members_fleet ON fleet_members(fleet_id)`);
  // Unique-post check (design D8): "is this persona/cluster on duty anywhere?"
  // scans by target, so index the pair.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fleet_members_target ON fleet_members(target_kind, target_id)`);

  // Fleet credentials (fleet-scoped-bench-credentials D2): at most one row per
  // (fleet, kind). It lives in the same per-cell file as the fleet it belongs
  // to, so a credential can never outlive its fleet — the 2026-11-14 ghost
  // fleet (`fleet_1794335712751_wfa3ww`: registered on the bench side, 13
  // proposals signed to it, a row in no live fleets.db) was exactly an identity
  // that outlived its entity. Refusing the write for an unknown fleet is
  // cheaper than re-deriving the ghost on every read.
  db.exec(`CREATE TABLE IF NOT EXISTS fleet_credentials (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(fleet_id, kind)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fleet_credentials_kind ON fleet_credentials(kind)`);

  // ── 判定与角色状态（establish-agent-role-and-fitness-plane 1.1）────────────
  //
  // 四张新表全部 additive：无数据时每个读面返回「未声明」，不返回零值
  // （agent-role spec: 未取得与零必须可区分）。存量库零迁移。
  //
  // `fitness_runs` 是判定运行的账：输入（窗口/预算/判据/各臂）与产出（逐条读数/
  // 裁决/证据引用）一起落一行，使「这一版当时承诺了什么」事后可复算。
  // `verdict` 为 NULL 表示本次运行尚未判完 —— 不是 `inconclusive`，后者是判完但
  // 判不出（附缺失清单）。两者混同会让「还在跑」读成「已判」。
  db.exec(`CREATE TABLE IF NOT EXISTS fitness_runs (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    pack_id TEXT,
    mode TEXT NOT NULL DEFAULT 'three-arm',
    window_start INTEGER NOT NULL,
    window_end INTEGER NOT NULL,
    budget TEXT,
    criteria TEXT NOT NULL DEFAULT '[]',
    arms TEXT NOT NULL DEFAULT '[]',
    readings TEXT NOT NULL DEFAULT '{}',
    evidence TEXT NOT NULL DEFAULT '{}',
    missing TEXT NOT NULL DEFAULT '[]',
    verdict TEXT,
    judged_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fitness_runs_fleet ON fitness_runs(fleet_id, created_at)`);

  // 角色与基因组分离（agent-role spec 第 1 条）：一行一个角色实例，
  // `genome_pack_id`/`genome_version` 是**引用**，基因组升版不触碰这一行；
  // 采纳/回滚是显式写这两列的动作，`genome_adopted_at` 是它的时间戳。
  db.exec(`CREATE TABLE IF NOT EXISTS role_states (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    genome_pack_id TEXT,
    genome_version INTEGER,
    genome_adopted_at INTEGER,
    organs TEXT NOT NULL DEFAULT '{}',
    status TEXT,
    status_basis TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(fleet_id, member_id)
  )`);

  // 胜任力候选：与领域记忆同根（fd-memory 页面），这里只存「哪个页面、什么状态、
  // 谁在质疑」，正文不复制 —— 复制的第二真源必然漂移。
  db.exec(`CREATE TABLE IF NOT EXISTS competence_candidates (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    page_ref TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'candidate',
    disputed_by TEXT,
    dispute_basis TEXT,
    evidence TEXT NOT NULL DEFAULT '{}',
    accepted_by TEXT,
    accepted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  // 目标所有权：跨回合连续、带窗口的达成量。
  db.exec(`CREATE TABLE IF NOT EXISTS role_objectives (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    metric_key TEXT NOT NULL,
    label TEXT NOT NULL,
    window_kind TEXT NOT NULL DEFAULT 'month',
    target_value REAL,
    unit TEXT,
    source_ref TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  // ── fleets ────────────────────────────────────────────────────────────────

  function createFleet(fleet) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO fleets (id, name, owner_email, state, decision_policy, source_template, default_model, effort, context_budget, orchestration, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fleet.id,
      fleet.name,
      fleet.ownerEmail,
      fleet.state || "active",
      fleet.decisionPolicy ? JSON.stringify(fleet.decisionPolicy) : null,
      fleet.sourceTemplate ? JSON.stringify(fleet.sourceTemplate) : null,
      fleet.defaultModel ?? null,
      fleet.effort ?? null,
      Number.isFinite(fleet.contextBudget) ? fleet.contextBudget : null,
      fleet.orchestration ? JSON.stringify(fleet.orchestration) : null,
      now,
      now,
    );
    return getFleet(fleet.id);
  }

  function getFleet(id) {
    const row = db.prepare("SELECT * FROM fleets WHERE id = ?").get(id);
    return row ? deserializeFleet(row) : null;
  }

  function updateFleet(id, updates, meta = null) {
    const COLUMNS = { name: "name", state: "state", defaultModel: "default_model", effort: "effort", contextBudget: "context_budget", consoleSlug: "console_slug", consolePublishedAt: "console_published_at" };
    const setParts = [];
    const values = [];
    for (const [key, value] of Object.entries(updates)) {
      const col = COLUMNS[key];
      if (!col) continue;
      setParts.push(`${col} = ?`);
      values.push(value);
    }
    if (keyIsDecisionPolicy(updates)) {
      setParts.push("decision_policy = ?");
      values.push(JSON.stringify(updates.decisionPolicy));
    }
    if (Object.hasOwn(updates, "orchestration")) {
      setParts.push("orchestration = ?");
      values.push(updates.orchestration ? JSON.stringify(updates.orchestration) : null);
    }
    if (Object.hasOwn(updates, "sourceTemplate")) {
      setParts.push("source_template = ?");
      values.push(updates.sourceTemplate ? JSON.stringify(updates.sourceTemplate) : null);
    }
    // 输入策略（add-input-request-cards D8）：null 清空 = 恢复继承。
    if (Object.hasOwn(updates, "inputPolicy")) {
      setParts.push("input_policy = ?");
      values.push(updates.inputPolicy ? JSON.stringify(updates.inputPolicy) : null);
    }
    if (setParts.length === 0) return null;
    const before = getFleet(id);
    setParts.push("updated_at = ?");
    values.push(Date.now(), id);
    db.prepare(`UPDATE fleets SET ${setParts.join(", ")} WHERE id = ?`).run(...values);
    // Attribution half (add-fleet-row-update-audit): stamp the audit row this
    // UPDATE just caused — better-sqlite3 is synchronous on one connection,
    // so MAX(id) is this call's row. Callers without meta leave actor NULL:
    // that NULL is the out-of-process marker, never overwritten.
    if (meta && (meta.actor != null || meta.via != null)) {
      db.prepare("UPDATE fleet_row_audit SET actor = ?, via = ? WHERE id = (SELECT MAX(id) FROM fleet_row_audit)").run(
        meta.actor ?? null,
        meta.via ?? null,
      );
    }
    // A non-null → null orchestration reset outside the owner's own
    // /api/fleets session is the incident signature (2026-10-24, twice).
    if (
      before &&
      before.orchestration != null &&
      Object.hasOwn(updates, "orchestration") &&
      updates.orchestration == null
    ) {
      const owner = String(before.ownerEmail || "").trim().toLowerCase();
      const actor = meta?.actor != null ? String(meta.actor).trim().toLowerCase() : null;
      const ownerHttpSession = actor != null && actor === owner && typeof meta.via === "string" && meta.via.includes("/api/fleets");
      if (!ownerHttpSession) {
        console.warn(`[fleet-audit] orchestration reset to null: fleet=${id} actor=${meta?.actor ?? "unknown"} via=${meta?.via ?? "(no attribution)"}`);
      }
    }
    return getFleet(id);
  }

  // Template-anchor dedup (D5): a fleet instantiated from this pack by this
  // owner. Archived fleets do not block a fresh instantiation.
  function findFleetByTemplate(packId, ownerEmail) {
    const rows = db
      .prepare("SELECT * FROM fleets WHERE owner_email = ? AND source_template IS NOT NULL")
      .all(ownerEmail);
    for (const row of rows) {
      const t = JSON.parse(row.source_template || "null");
      if (t?.packId === packId && row.state !== "archived") return deserializeFleet(row);
    }
    return null;
  }

  function listFleets({ ownerEmail = null } = {}) {
    const rows = ownerEmail
      ? db.prepare("SELECT * FROM fleets WHERE owner_email = ? ORDER BY created_at DESC").all(ownerEmail)
      : db.prepare("SELECT * FROM fleets ORDER BY created_at DESC").all();
    return rows.map(deserializeFleet);
  }

  // ── members ───────────────────────────────────────────────────────────────

  function createMember(member) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO fleet_members (id, fleet_id, title, parent_id, target_kind, target_id, kpi_slots, cadence, model, fallback_model, effort, context_budget, carrier, input_policy, pack_id, sort_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      member.id,
      member.fleetId,
      member.title,
      member.parentId ?? null,
      member.targetKind,
      member.targetId,
      JSON.stringify(member.kpiSlots ?? []),
      member.cadence ? JSON.stringify(member.cadence) : null,
      member.model ?? null,
      member.fallbackModel ?? null,
      member.effort ?? null,
      Number.isFinite(member.contextBudget) ? member.contextBudget : null,
      member.carrier ?? null,
      // 建岗时也要能带输入策略（enrich-fleet-template-member-config 2.1）：这一列
      // 此前只被 updateMember 认，createMember 漏了它——模板搬过来的 inputPolicy
      // 会在这里被静默丢掉，读面显示 null 而声明是有的。
      member.inputPolicy ? JSON.stringify(member.inputPolicy) : null,
      member.packId ?? null,
      Number.isFinite(member.sortKey) ? member.sortKey : now,
      now,
      now,
    );
    return getMember(member.id);
  }

  function getMember(id) {
    const row = db.prepare("SELECT * FROM fleet_members WHERE id = ?").get(id);
    return row ? deserializeMember(row) : null;
  }

  function listMembers(fleetId) {
    return db
      .prepare("SELECT * FROM fleet_members WHERE fleet_id = ? ORDER BY sort_key, created_at")
      .all(fleetId)
      .map(deserializeMember);
  }

  // Every auditor post across every fleet (harden-auditor-runtime-face 3.2).
  // The tool-filter document needs one section per auditor preset, and that is a
  // cell-wide question — listing fleet by fleet would be N+1 for no reason.
  // Archived fleets are included on purpose: their auditor's patch may still be
  // composed for a resumed round, and a face that disappears with the fleet's
  // state is a face that forgets to narrow.
  function listAuditorMembers() {
    return db
      .prepare("SELECT * FROM fleet_members WHERE target_kind = 'auditor'")
      .all()
      .map(deserializeMember);
  }

  function updateMember(id, updates) {
    const JSON_COLUMNS = { kpiSlots: "kpi_slots", cadence: "cadence", inputPolicy: "input_policy" };
    const PLAIN_COLUMNS = {
      title: "title",
      parentId: "parent_id",
      sortKey: "sort_key",
      // Restaff (swap, ADR-0031): the incumbent ref is the one mutable
      // identity-adjacent field — everything else on the row is post history.
      targetKind: "target_kind",
      targetId: "target_id",
      model: "model",
      fallbackModel: "fallback_model",
      effort: "effort",
      contextBudget: "context_budget",
      carrier: "carrier",
      packId: "pack_id",
    };
    const setParts = [];
    const values = [];
    for (const [key, value] of Object.entries(updates)) {
      const jsonCol = JSON_COLUMNS[key];
      const plainCol = PLAIN_COLUMNS[key];
      if (jsonCol) {
        setParts.push(`${jsonCol} = ?`);
        values.push(value === null ? null : JSON.stringify(value));
      } else if (plainCol) {
        setParts.push(`${plainCol} = ?`);
        values.push(value);
      }
    }
    if (setParts.length === 0) return null;
    setParts.push("updated_at = ?");
    values.push(Date.now(), id);
    db.prepare(`UPDATE fleet_members SET ${setParts.join(", ")} WHERE id = ?`).run(...values);
    return getMember(id);
  }

  function deleteMember(id) {
    const result = db.prepare("DELETE FROM fleet_members WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ── member reports (append-only) ──────────────────────────────────────────

  function appendReport(report) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO member_reports (id, fleet_id, member_id, session_id, metrics, resources, blockers, summary, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      report.id,
      report.fleetId,
      report.memberId,
      report.sessionId ?? null,
      JSON.stringify(report.metrics ?? {}),
      JSON.stringify(report.resources ?? []),
      JSON.stringify(report.blockers ?? []),
      report.summary,
      report.source || "self",
      report.createdAt ?? now,
    );
    return deserializeReport(db.prepare("SELECT * FROM member_reports WHERE id = ?").get(report.id));
  }

  function getReport(id) {
    const row = db.prepare("SELECT * FROM member_reports WHERE id = ?").get(id);
    return row ? deserializeReport(row) : null;
  }

  // Latest report per member for a whole fleet (one query — cells are small).
  function latestReports(fleetId) {
    const rows = db
      .prepare("SELECT * FROM member_reports WHERE fleet_id = ? ORDER BY created_at DESC, id DESC")
      .all(fleetId);
    const byMember = new Map();
    for (const row of rows) {
      if (!byMember.has(row.member_id)) byMember.set(row.member_id, deserializeReport(row));
    }
    return byMember;
  }

  function latestReportFor(memberId) {
    const row = db
      .prepare("SELECT * FROM member_reports WHERE member_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(memberId);
    return row ? deserializeReport(row) : null;
  }

  // The report immediately BEFORE a given timestamp — the trend baseline.
  function previousReport(memberId, beforeMs) {
    const row = db
      .prepare("SELECT * FROM member_reports WHERE member_id = ? AND created_at < ? AND source = 'self' ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(memberId, beforeMs);
    return row ? deserializeReport(row) : null;
  }

  // Timeline page, newest first; `beforeMs` (exclusive) pages via the last
  // row's createdAt.
  function listReports(memberId, { beforeMs = null, limit = 20 } = {}) {
    const rows = beforeMs == null
      ? db.prepare("SELECT * FROM member_reports WHERE member_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(memberId, limit)
      : db.prepare("SELECT * FROM member_reports WHERE member_id = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?").all(memberId, beforeMs, limit);
    return rows.map(deserializeReport);
  }

  // Flood control: how many reports this member filed inside the window.
  function countReportsSince(memberId, sinceMs) {
    return db
      .prepare("SELECT COUNT(*) AS n FROM member_reports WHERE member_id = ? AND created_at > ? AND source = 'self'")
      .get(memberId, sinceMs).n;
  }

  // ── decision items ────────────────────────────────────────────────────────

  function appendDecision(item) {
    db.prepare(`
      INSERT INTO decision_items (id, fleet_id, member_id, question, options, severity, suggested_deadline, recommendation, state, resolution, source_session_id, submitted_at, item_type, detail, route, category, topic_key, domain)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id,
      item.fleetId,
      item.memberId,
      item.question,
      JSON.stringify(item.options ?? []),
      item.severity || "normal",
      item.suggestedDeadline ?? null,
      item.recommendation ?? null,
      item.sourceSessionId ?? null,
      item.submittedAt ?? Date.now(),
      item.itemType ?? null,
      item.detail ? JSON.stringify(item.detail) : null,
      item.route || "owner",
      item.category ?? null,
      item.topicKey ?? null,
      // Domain the item entered through the personal domain map
      // (widen-deputy-to-personal-domains). Null = the pre-existing fleet-
      // internal lane, which keeps its category vocabulary untouched.
      item.domain ?? null,
    );
    return getDecision(item.id);
  }

  // ── precedent candidates (widen-deputy-to-personal-domains 4.x) ──────────
  //
  // 三条硬纪律：候选永不直接生效、只有主人能批准/驳回、被拒的候选要能被认出来
  // 并且理由可读（否则同一候选会被反复提上来，白烧人一次审阅）。

  function listPrecedentCandidates({ fleetId, status = null } = {}) {
    const rows = status
      ? db.prepare(`SELECT * FROM precedent_candidates WHERE fleet_id = ? AND status = ? ORDER BY proposed_at DESC`).all(fleetId, status)
      : db.prepare(`SELECT * FROM precedent_candidates WHERE fleet_id = ? ORDER BY proposed_at DESC`).all(fleetId);
    return rows.map(deserializePrecedentCandidate);
  }

  function getPrecedentCandidate(id) {
    const row = db.prepare(`SELECT * FROM precedent_candidates WHERE id = ?`).get(id);
    return row ? deserializePrecedentCandidate(row) : null;
  }

  /**
   * 提议一条候选规则。同 key 已存在时不新建，而是把既有那条（含状态与拒绝
   * 理由）原样返回——调用方据此告诉代理「这条已经提过了」。
   */
  function proposePrecedentCandidate({ fleetId, domain = null, ruleText, sourceDecisionId = null, now = Date.now() }) {
    const key = ruleKey(ruleText);
    if (!key) return { ok: false, error: "rule text is required" };
    const existing = db
      .prepare(`SELECT * FROM precedent_candidates WHERE fleet_id = ? AND rule_key = ?`)
      .get(fleetId, key);
    if (existing) {
      return { ok: false, code: "duplicate", existing: deserializePrecedentCandidate(existing) };
    }
    const id = `pcn_${now}_${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`
      INSERT INTO precedent_candidates (id, fleet_id, domain, rule_text, rule_key, source_decision_id, status, proposed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?)
    `).run(id, fleetId, domain, normalizeRuleText(ruleText), key, sourceDecisionId, new Date(now).toISOString());
    return { ok: true, candidate: getPrecedentCandidate(id) };
  }

  function decidePrecedentCandidate(id, { approve, by, reason = null, now = Date.now() }) {
    const row = db.prepare(`SELECT * FROM precedent_candidates WHERE id = ?`).get(id);
    if (!row) return { ok: false, error: "not found" };
    if (row.status !== "candidate") return { ok: false, error: `candidate is '${row.status}'` };
    const status = approve ? "approved" : "rejected";
    db.prepare(`UPDATE precedent_candidates SET status = ?, decided_at = ?, decided_by = ?, reject_reason = ? WHERE id = ?`)
      .run(status, new Date(now).toISOString(), by ?? "owner", approve ? null : reason, id);
    return { ok: true, candidate: getPrecedentCandidate(id) };
  }

  /** 可引用的候选规则——只有被批准的。 */
  function listApprovedPrecedentRules({ fleetId, domain = null, limit = 10 } = {}) {
    const rows = domain
      ? db.prepare(`SELECT * FROM precedent_candidates WHERE fleet_id = ? AND status = 'approved' AND (domain = ? OR domain IS NULL) ORDER BY decided_at DESC LIMIT ?`).all(fleetId, domain, limit)
      : db.prepare(`SELECT * FROM precedent_candidates WHERE fleet_id = ? AND status = 'approved' ORDER BY decided_at DESC LIMIT ?`).all(fleetId, limit);
    return rows.map(deserializePrecedentCandidate);
  }

  /** 被拒候选与理由——审计官要读得到，否则同一候选会被反复提议。 */
  function listPrecedentRejections({ fleetId, limit = 10 } = {}) {
    const rows = db
      .prepare(`SELECT * FROM precedent_candidates WHERE fleet_id = ? AND status = 'rejected' ORDER BY decided_at DESC LIMIT ?`)
      .all(fleetId, limit);
    return rows.map(deserializePrecedentCandidate);
  }

  /**
   * 判例读取（widen-deputy-to-personal-domains 2.3；agent-decided-learning-loop
   * 3.1）：**只按等级过滤，不按主体身份过滤**。
   *
   * 旧写法写死了 `resolved_by = 'owner'`，那一条就是「agent 学不会」的实现：
   * 一个 agent 的裁决无论独立性多完整，都进不了下一次判断的依据。现在按等级取
   * 四个可引用级（两个主人级 + 两个 agent 独立级）。
   *
   * `agent-self` 永不出现——它不是「差一点的判例」，它根本不是判例。
   * 历史 `deputy-ruled` 行也不会出现：它不在可引用集合里，且读面把它规范成
   * `agent-self`（normalizeLegacyGrade）。
   */
  const CITABLE_GRADES = ["owner-authored", "owner-approved", "agent-independent", "agent-independent-unverified"];

  function listCitablePrecedents({ fleetId, memberId = null, limit = 3 } = {}) {
    const where = [
      "fleet_id = ?",
      "state = 'delivered'",
      `precedent_grade IN (${CITABLE_GRADES.map(() => "?").join(",")})`,
    ];
    const params = [fleetId, ...CITABLE_GRADES];
    if (memberId) {
      where.push("member_id = ?");
      params.push(memberId);
    }
    const rows = db
      .prepare(`SELECT * FROM decision_items WHERE ${where.join(" AND ")} ORDER BY resolved_at DESC LIMIT ?`)
      .all(...params, Math.max(1, Math.floor(limit)));
    return rows.map(deserializeDecision);
  }

  /**
   * 审计官反例集合 (3.5)：被推翻过的判断。没有反例的审计官会和专家一起
   * 走偏——两者都只看到「以前同意过什么」，于是复核退化成复述。
   *
   * 「推翻过」= 被驳回，或被改批（resolution 与推荐不一致）。宁可多给，不可
   * 只给顺例。
   *
   * 2026-11-21（agent-decided-learning-loop 3.2）：去掉了 `resolved_by = 'owner'`。
   * 反例的判据是「谁不同意这条推荐」，不是「谁签的字」——只收主人的反例会让
   * agent 裁决的反例永远进不了审计官的负样本集，正负两侧因此不对称。
   * `state IN (...)` 那一条已经排除了未决项，不需要身份兜底。
   */
  function listOverruledDecisions({ fleetId, memberId = null, limit = 5 } = {}) {
    const where = ["fleet_id = ?", "state IN ('rejected','approved')"];
    const params = [fleetId];
    if (memberId) {
      where.push("member_id = ?");
      params.push(memberId);
    }
    const rows = db
      .prepare(`SELECT * FROM decision_items WHERE ${where.join(" AND ")} ORDER BY resolved_at DESC LIMIT ?`)
      .all(...params, Math.max(1, Math.floor(limit * 4)));
    const out = [];
    for (const row of rows) {
      let choice = null;
      try {
        choice = row.resolution ? JSON.parse(row.resolution)?.choice ?? null : null;
      } catch {
        choice = null;
      }
      const overruled = row.state === "rejected" || (row.recommendation && choice !== row.recommendation);
      if (overruled) out.push(deserializeDecision(row));
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * 对外发言按披露层级的样本量 (add-principal-disclosure-gate 5.1/6.4)。
   *
   * 放量闸按层级判，所以界面必须能看到每个层级各自攒了多少——只有一个域的
   * 总一致率，主人无法知道「缺的是哪一层」，而这正是拒绝时唯一有用的信息。
   *
   * 只数真正发出去的（audience 非空）：被拦下的不算样本，否则「挡住很多次」
   * 会被算成「经验很多」。
   */
  function outboundLevelSamples() {
    // action_audit 在主库（db.js 的 migration v34/v116/v117），不在 fleets.db。
    // 早先写成 this.db 会 500：票据表根本不在这个库里。
    let mainDb = null;
    try {
      mainDb = dbModule.getDb?.() ?? null;
    } catch {
      mainDb = null;
    }
    if (!mainDb) return {};
    const rows = mainDb
      .prepare(`
        SELECT disclose_level AS level, COUNT(*) AS n
        FROM action_audit
        WHERE audience IS NOT NULL AND disclose_level IS NOT NULL
        GROUP BY disclose_level
      `)
      .all();
    const out = {};
    for (const row of rows) out[row.level] = Number(row.n) || 0;
    return out;
  }

  /**
   * 一致率（2.4）。样本只取主人亲自裁决且带推荐的条目——用代理自己的裁
   * 决去证明代理可靠是循环论证。
   *
   * 直接读 recommendation 列：deserializeDecision 的 recommendation 字段
   * 目前错误地回落到 resolution（既有缺陷，另行处理），这里不能依赖它。
   */
  function decisionConsistency({ fleetId = null, domain = null } = {}) {
    const where = ["resolved_by = 'owner'", "state IN ('approved','rejected')", "recommendation IS NOT NULL", "recommendation <> ''"];
    const params = [];
    if (fleetId) {
      where.push("fleet_id = ?");
      params.push(fleetId);
    }
    if (domain) {
      where.push("domain = ?");
      params.push(domain);
    }
    const rows = db
      .prepare(`SELECT recommendation, resolution, state FROM decision_items WHERE ${where.join(" AND ")}`)
      .all(...params);
    let samples = 0;
    let agrees = 0;
    for (const row of rows) {
      samples += 1;
      let choice = null;
      try {
        choice = row.resolution ? JSON.parse(row.resolution)?.choice ?? null : null;
      } catch {
        choice = null;
      }
      if (row.state === "approved" && choice === row.recommendation) agrees += 1;
    }
    return { samples, agrees, rate: samples === 0 ? null : agrees / samples };
  }

  function getDecision(id) {
    const row = db.prepare("SELECT * FROM decision_items WHERE id = ?").get(id);
    return row ? deserializeDecision(row) : null;
  }

  function listDecisions({ fleetId, state = null, memberId = null, pendingDeliveryFor = null, route = null } = {}) {
    const where = ["fleet_id = ?"];
    const args = [fleetId];
    if (state) {
      where.push("state = ?");
      args.push(state);
    }
    if (route) {
      // 数组形态（fix-triage-lane-has-no-consumer）：常务岗的队列要一次取回
      // 「可裁决」与「仅分诊」两档，否则分诊档没有任何读面读它——那正是它此前
      // 静默积压 24 条、最老压了三天的原因。
      if (Array.isArray(route)) {
        const routes = route.filter((r) => typeof r === "string" && r);
        if (routes.length) {
          where.push(`route IN (${routes.map(() => "?").join(", ")})`);
          args.push(...routes);
        }
      } else {
        where.push("route = ?");
        args.push(route);
      }
    }
    if (memberId) {
      where.push("member_id = ?");
      args.push(memberId);
    }
    if (pendingDeliveryFor) {
      // Approved/rejected items of ONE post still awaiting their delivery
      // turn, oldest resolution first (the injection order).
      where.push("member_id = ?", "state IN ('approved','rejected')", "delivered_at IS NULL");
      args.push(pendingDeliveryFor);
      return db
        .prepare(`SELECT * FROM decision_items WHERE ${where.join(" AND ")} ORDER BY resolved_at ASC, id ASC`)
        .all(...args)
        .map(deserializeDecision);
    }
    return db
      .prepare(`SELECT * FROM decision_items WHERE ${where.join(" AND ")} ORDER BY submitted_at DESC, id DESC`)
      .all(...args)
      .map(deserializeDecision);
  }

  // Share-page lookup (add-pack-console): resolve a published slug to its fleet.
  // Only a published fleet is addressable — the WHERE clause is the publication
  // guard, not a caller convention.
  function getFleetByConsoleSlug(slug) {
    if (typeof slug !== "string" || !slug) return null;
    const row = db.prepare("SELECT * FROM fleets WHERE console_slug = ?").get(slug);
    return row ? deserializeFleet(row) : null;
  }

  function countOpenDecisions(fleetId) {
    return db
      .prepare("SELECT COUNT(*) AS n FROM decision_items WHERE fleet_id = ? AND state = 'open'")
      .get(fleetId).n;
  }

  // 角标口径 (add-deputy-decision-delegate)：「等你 N 件」只计 route=owner 的
  // open 项——委托给常务岗的不算主人头上。
  function countOwnerOpenDecisions(fleetId) {
    return db
      .prepare("SELECT COUNT(*) AS n FROM decision_items WHERE fleet_id = ? AND state = 'open' AND route = 'owner'")
      .get(fleetId).n;
  }

  function countDeputyOpenDecisions(fleetId) {
    return db
      .prepare("SELECT COUNT(*) AS n FROM decision_items WHERE fleet_id = ? AND state = 'open' AND route = 'deputy'")
      .get(fleetId).n;
  }

  function countDecisionsByMemberSince(memberId, sinceMs) {
    return db
      .prepare("SELECT COUNT(*) AS n FROM decision_items WHERE member_id = ? AND submitted_at > ?")
      .get(memberId, sinceMs).n;
  }

  // Optimistic-concurrency transition (design D4): the UPDATE only lands when
  // the row is still in `expectedState` — the first resolution wins, a losing
  // concurrent writer reads null and reports the conflict.
  function transitionDecision(id, expectedState, patch, { expectDeliveredNull = false } = {}) {
    const setParts = [];
    const values = [];
    const JSON_COLS = { resolution: "resolution", detail: "detail" };
    // `route` 必须在白名单里（2026-11-10）：审计官「阻断并上报」要把条目转回主人，
// 走的是 transitionDecision 的 patch。它不属于白名单时那一行会被**静默丢弃**——
// 裁决记下了、route 还是 deputy，条目继续按原路由走，且没有任何报错。
const PLAIN_COLS = { state: "state", route: "route", deliveredAt: "delivered_at", deliveredSessionId: "delivered_session_id", resolvedAt: "resolved_at", submittedAt: "submitted_at", recommendation: "recommendation", resolvedBy: "resolved_by", resolvedByModel: "resolved_by_model", rulingEvidence: "ruling_evidence", domain: "domain", precedentGrade: "precedent_grade", auditorVerdict: "auditor_verdict", auditorNote: "auditor_note", executedAt: "executed_at", executedSessionId: "executed_session_id", escalations: "escalations", lastEscalatedAt: "last_escalated_at", revocableUntil: "revocable_until", revokedAt: "revoked_at" };
    for (const [key, value] of Object.entries(patch)) {
      const jsonCol = JSON_COLS[key];
      const plainCol = PLAIN_COLS[key];
      if (jsonCol) {
        setParts.push(`${jsonCol} = ?`);
        values.push(value === null ? null : JSON.stringify(value));
      } else if (plainCol) {
        setParts.push(`${plainCol} = ?`);
        values.push(value);
      }
    }
    if (setParts.length === 0) return null;
    values.push(id, expectedState);
    const result = db
      .prepare(
        `UPDATE decision_items SET ${setParts.join(", ")} WHERE id = ? AND state = ?${
          expectDeliveredNull ? " AND delivered_at IS NULL" : ""
        }`,
      )
      .run(...values);
    return result.changes > 0 ? getDecision(id) : null;
  }

  // Fleet-policy expiry sweep (lazy on read + hourly backstop): open items
  // older than the policy window flip to expired and STAY listed. Returns the
  // flipped count (0 when the policy is off).
  function expireOpenDecisions(fleetId, { now = Date.now(), expiryHours } = {}) {
    // getFleet already normalizes the policy (camelCase, defaults filled);
    // read that, never the raw column again.
    const hours = expiryHours ?? (getFleet(fleetId)?.decisionPolicy ?? DEFAULT_DECISION_POLICY).expiryHours;
    if (!hours || hours <= 0) return 0;
    const cutoff = now - hours * 3600_000;
    const result = db
      .prepare("UPDATE decision_items SET state = 'expired' WHERE fleet_id = ? AND state = 'open' AND submitted_at < ?")
      .run(fleetId, cutoff);
    return result.changes;
  }

  // Delivery bookkeeping: mark this post's awaiting items delivered, once —
  // at most `limit` per finished turn, oldest resolution first, matching the
  // injector's per-turn cap (the rest roll to the next turn). Flips state to
  // `delivered` (delivery is a fact, not a new decision).
  //
  // 执行事实同笔回填 (add-deputy-decision-delegate, design D6)：本函数只在
  // 舰队回合完成钩子上调用——送达回合的完成就是"执行"这一事实，所以
  // executed_at/executed_session_id 与 delivered 一起落（design D6 拒绝了
  // 新状态迁移，事实即字段）。
  function markDelivered(memberId, { now = Date.now(), sessionId = null, limit = 5 } = {}) {
    const ids = db
      .prepare(
        `SELECT id FROM decision_items
         WHERE member_id = ? AND state IN ('approved','rejected') AND delivered_at IS NULL
         ORDER BY resolved_at ASC, id ASC LIMIT ?`,
      )
      .all(memberId, limit)
      .map((r) => r.id);
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const result = db
      .prepare(
        `UPDATE decision_items SET state = 'delivered', delivered_at = ?, delivered_session_id = ?,
         executed_at = ?, executed_session_id = ?
         WHERE id IN (${placeholders}) AND delivered_at IS NULL`,
      )
      .run(now, sessionId, now, sessionId, ...ids);
    return result.changes;
  }

  // ── delegation (add-deputy-decision-delegate) ─────────────────────────────

  // 委托审计流水：每次 escalate 一行（merged=1 表示归并到既有项）。防洪上限
  // 与「被升级过几次」从这读，拍板项行数不再承担这两个职责。
  function recordEscalation({ id, fleetId, memberId, decisionId, merged = 0, sourceSessionId = null, now = Date.now() }) {
    db.prepare(
      `INSERT INTO decision_escalations (id, fleet_id, member_id, decision_id, merged, source_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, fleetId, memberId, decisionId, merged ? 1 : 0, sourceSessionId, now);
  }

  function countEscalationsByMemberSince(memberId, sinceMs) {
    return db
      .prepare("SELECT COUNT(*) AS n FROM decision_escalations WHERE member_id = ? AND created_at > ?")
      .get(memberId, sinceMs).n;
  }

  // 归并查找 (design D5)：同岗位近 N 天内的相似 open 项——topicKey 精确命中
  // 或问题归一化文本相同。语义相似度（embedding）留 v2，先不引进新依赖。
  function findSimilarOpenDecision({ memberId, topicKey = null, question = null, sinceMs }) {
    const norm = normalizeQuestion(question);
    if (topicKey) {
      const hit = db
        .prepare(
          `SELECT * FROM decision_items
           WHERE member_id = ? AND state = 'open' AND topic_key = ? AND submitted_at > ?
           ORDER BY submitted_at DESC LIMIT 1`,
        )
        .get(memberId, topicKey, sinceMs);
      if (hit) return deserializeDecision(hit);
    }
    if (norm) {
      const rows = db
        .prepare(
          `SELECT * FROM decision_items
           WHERE member_id = ? AND state = 'open' AND submitted_at > ? ORDER BY submitted_at DESC`,
        )
        .all(memberId, sinceMs);
      for (const row of rows) {
        if (normalizeQuestion(row.question) === norm) return deserializeDecision(row);
      }
    }
    return null;
  }

  // 归并落点：既有项升级次数 +1、最近升级时刻刷新，来源会话追加进 detail
  // （截断到 5 条，防长尾）。SHALL NOT 改写问题文本或过期基准（submitted_at）。
  function mergeDecisionEscalation(id, { now = Date.now(), sessionId = null } = {}) {
    const item = getDecision(id);
    if (!item || item.state !== "open") return null;
    const sessions = Array.isArray(item.detail?.escalationSessions) ? item.detail.escalationSessions : [];
    const detail = {
      ...(item.detail ?? {}),
      escalationSessions: [...sessions, sessionId].filter(Boolean).slice(-5),
    };
    return transitionDecision(
      id,
      "open",
      { escalations: (item.escalations ?? 0) + 1, lastEscalatedAt: now, detail },
      { },
    );
  }

  function setDecisionRoute(id, route) {
    if (route !== "owner" && route !== "deputy") return null;
    return db.prepare("UPDATE decision_items SET route = ? WHERE id = ?").run(route, id).changes > 0
      ? getDecision(id)
      : null;
  }

  // 执行事实回填 (design D6)：仅 delivered 态可回填（deliver 是既定事实）。
  function recordDecisionExecution(id, { now = Date.now(), sessionId = null } = {}) {
    const item = getDecision(id);
    if (!item || item.state !== "delivered") return null;
    const out = transitionDecision(id, "delivered", { executedAt: now, executedSessionId: sessionId });
    return out;
  }

  // ── cell 设置 KV（委托策略等）：同库同迁移路径的最小存储。 ─────────────────
  function getCellSetting(key) {
    const row = db.prepare("SELECT value FROM cell_settings WHERE key = ?").get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  function setCellSetting(key, value) {
    db.prepare(
      `INSERT INTO cell_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(value), Date.now());
  }

  // ── knowledge profile 覆写 (add-member-knowledge-profile)：与 delegation
  // policy 同款两层模式——cell 默认存 cell_settings['knowledgeProfile']，舰队
  // 覆写存 fleets.knowledge_profile 列（try/ALTER 旧行 NULL=无覆写）。归一化
  // 与默认值由纯模块 server/knowledge-profile.js 单源承载，DB 层只存取。
  try {
    db.exec(`ALTER TABLE fleets ADD COLUMN knowledge_profile TEXT`);
  } catch {
    /* column already exists */
  }

  function getFleetKnowledgeProfileRaw(fleetId) {
    const row = db.prepare("SELECT knowledge_profile FROM fleets WHERE id = ?").get(fleetId);
    if (!row || typeof row.knowledge_profile !== "string" || !row.knowledge_profile) return null;
    try {
      const parsed = JSON.parse(row.knowledge_profile);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function setFleetKnowledgeProfile(fleetId, profile) {
    db.prepare("UPDATE fleets SET knowledge_profile = ?, updated_at = ? WHERE id = ?").run(
      profile == null ? null : JSON.stringify(profile),
      Date.now(),
      fleetId,
    );
    return getFleet(fleetId);
  }

  function getCellKnowledgeProfile() {
    return getCellSetting("knowledgeProfile");
  }

  function setCellKnowledgeProfile(profile) {
    setCellSetting("knowledgeProfile", profile);
  }

  function getFleetDelegationPolicyRaw(fleetId) {
    const row = db.prepare("SELECT delegation_policy FROM fleets WHERE id = ?").get(fleetId);
    if (!row || typeof row.delegation_policy !== "string" || !row.delegation_policy) return null;
    try {
      const parsed = JSON.parse(row.delegation_policy);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function setFleetDelegationPolicy(fleetId, policy) {
    db.prepare("UPDATE fleets SET delegation_policy = ?, updated_at = ? WHERE id = ?").run(
      policy == null ? null : JSON.stringify(policy),
      Date.now(),
      fleetId,
    );
    return getFleet(fleetId);
  }

  // 生效策略 = cell 默认 + 舰队覆写 (design：两层配置)。cell 默认存
  // cell_settings['delegationPolicy']。
  function getFleetDelegationPolicy(fleetId) {
    const cellPolicy = getCellSetting("delegationPolicy");
    const override = getFleetDelegationPolicyRaw(fleetId);
    return normalizeDelegationPolicy(cellPolicy, override);
  }

  // ── mandate policy (add-personal-mandate) ────────────────────────────────
  // Same storage as delegation: cell_settings['delegationPolicy'] + fleets
  // .delegation_policy. Writes carry a `domains` key and mirror the ops legacy
  // fields on top, so the deputy reader above is unaffected.
  function getFleetMandatePolicy(fleetId) {
    return delegationToMandate(getCellSetting("delegationPolicy"), getFleetDelegationPolicyRaw(fleetId));
  }

  function setFleetMandatePolicy(fleetId, policy) {
    const blob = mandateToBlob(policy);
    if (blob === null) return null;
    // 无损往返（fix-mandate-write-preserves-deputy）：委托状只表达「每个域能自主到哪一步」，
    // 不表达「谁来裁、怎么派」。上一份 blob 里这些扁平字段必须原样带过去。
    preserveUnmentionedLegacy(blob, getFleetDelegationPolicyRaw(fleetId));
    return setFleetDelegationPolicy(fleetId, blob);
  }

  function getCellMandatePolicy() {
    return delegationToMandate(getCellSetting("delegationPolicy"), null);
  }

  function setCellMandatePolicy(policy) {
    const blob = mandateToBlob(policy);
    if (blob === null) return null;
    preserveUnmentionedLegacy(blob, getCellSetting("delegationPolicy"));
    setCellSetting("delegationPolicy", blob);
    return blob;
  }

  // ── personal domain map (widen-deputy-to-personal-domains 1.2) ───────────
  // 事项从哪个事件源进哪个域。存 cell 设置（数据不是代码）：改它不需要发版，
  // 且默认全关——升级不动任何行为。
  function getPersonalDomainMap() {
    const normalized = normalizeDomainMap(getCellSetting("personalDomainMap"));
    return normalized.ok ? normalized.map : normalizeDomainMap(null).map;
  }

  function setPersonalDomainMap(raw) {
    const normalized = normalizeDomainMap(raw);
    if (!normalized.ok) return null;
    setCellSetting("personalDomainMap", normalized.map);
    return normalized.map;
  }

  // ── mandate violations (add-personal-mandate 4.4) ────────────────────────
  // Rolling per-day counts of blocked outbound/read attempts, so a domain that
  // is "quietly failing all day" shows up instead of looking idle. Stored in
  // cell_settings (small, human-inspectable) rather than a new table; the day
  // key lets readers prune by ignoring old keys.
  function mandateViolations() {
    const raw = getCellSetting("mandateViolations");
    return raw && typeof raw === "object" ? raw : {};
  }

  function recordMandateViolation(domain, kind, day = new Date().toISOString().slice(0, 10)) {
    // 域可以为空：旁路尝试根本不属于任何域（它连门都没进）。要求必须有域会让
    // 这类记录被静默丢掉——而那正是最该被看见的一条。
    if (!kind) return null;
    const key = domain || "—";
    const all = mandateViolations();
    const forDay = all[day] && typeof all[day] === "object" ? all[day] : {};
    const forDomain = forDay[key] && typeof forDay[key] === "object" ? forDay[key] : {};
    forDomain[kind] = (Number(forDomain[kind]) || 0) + 1;
    forDay[key] = forDomain;
    // Keep a week: enough to see a trend, small enough to stay readable.
    const merged = { ...all, [day]: forDay };
    const pruned = {};
    for (const d of Object.keys(merged).sort().slice(-7)) pruned[d] = merged[d];
    setCellSetting("mandateViolations", pruned);
    return pruned[day];
  }

  function getMandateViolations(day = new Date().toISOString().slice(0, 10)) {
    return mandateViolations()[day] ?? {};
  }

  // ── turn result events (append-only, pruned) ──────────────────────────────

  // Retention is read per call (same convention as the pack policy caps): an
  // operator can tighten it without a restart, an invalid value falls back.
  function turnEventKeep() {
    const n = Number(process.env.FLEET_TURN_EVENTS_KEEP);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
  }
  // Time window of the run ledger (agent-fleet-runs D10). A turn row is pruned
  // only when it is BOTH older than this window AND past the member's newest-N
  // floor — so a quiet post keeps its last 200 forever and a busy post keeps a
  // full month, whichever is more.
  function runRetentionMs() {
    const n = Number(process.env.FLEET_RUNS_RETENTION_DAYS);
    const days = Number.isFinite(n) && n >= 0 ? n : 30;
    return days * 86_400_000;
  }

  // rotate-cron-session-on-context-pressure 4.1: the two diseases have OPPOSITE
  // cures (rotate the session vs. do less per round), so a pressure row has to
  // say which one it was. The two inputs live in different places — the
  // runtime's window rides the turn's own detail, the PREVIOUS round's cacheRead
  // rides an earlier row — so the attribution is filled here, where both are
  // reachable in one transaction. cron-runner's `attributionFor` does the same
  // judgement; it cannot see the previous row, so it only fires when a caller
  // happens to hand it one (it never does today).
  //
  // Keyed on member, not session: a fleet round mints a fresh child session id
  // every round (`cron-<id>#r<ts>`), so "the previous round" is the previous ROW
  // OF THIS POST. Looking it up by session would find nothing on every fleet post.
  //
  // Absent stays absent. No previous row, or no window, means no `cause` — a
  // guess here would name the wrong cure and the wrong cure rotates a session
  // that did not need rotating.
  const PRIOR_CACHE_RATIO_FOR_ACCUMULATION = 0.7; // must match cron-runner's attributionFor
  function fillContextCause(event) {
    const detail = event?.detail;
    if (!detail || detail.contextPressure !== true) return event;
    if (detail.cause !== undefined) return event; // caller already said why
    const window = Number(detail.contextWindow);
    if (!Number.isFinite(window) || window <= 0) return event;
    if (!event.memberId) return event;
    let row = null;
    try {
      // The current row is not inserted yet, so the latest row WITH USAGE for
      // this post is the previous round that can answer "how full was it".
      // Taking the literal latest row was useless in a failure storm: consecutive
      // pressure failures carry no usage at all (measured 2026-11-11 — 105 such
      // failures in 24h, every sampled row with usage_input/cached/output NULL),
      // so the lookup landed on another anonymous row and the cause never
      // appeared. A row without usage is not evidence of an empty round.
      row = db.prepare(
        `SELECT usage_input_max, usage_cached_input, usage_input FROM member_turn_events
          WHERE member_id = ?
            AND (usage_input_max IS NOT NULL
                 OR usage_cached_input IS NOT NULL
                 OR (usage_input IS NOT NULL AND usage_input > 0))
          ORDER BY id DESC LIMIT 1`,
      ).get(event.memberId) ?? null;
    } catch {
      return event; // a table without the column (mixed-version window) reads as absent
    }
    if (!row) return event;
    // Which number answers "how full was it last round"? `cacheRead` is the
    // accumulating part, so it wins when the runtime reported it. But it is a
    // nullable ALTER column and half of production's rows are NULL (measured
    // 2026-11-10) — so fall back to the round's own input tokens rather than
    // publishing nothing. `priorBasis` says which one was used, because "0.03 of
    // the window from cache" and "0.03 from input" are not the same claim.
    // Which number answers "how full was it last round"? The per-request
    // high-watermark wins: `usage_input` and `usage_cached_input` are TURN SUMS
    // across steps, and dividing a sum by the per-request window produced
    // ratios above 1.0 (measured 2026-11-11: 1.54 and 1.06) that read like
    // occupancy but cannot be. Only `usage_input_max` is the same dimension as
    // `contextWindow`. The two sums stay as fallbacks for rows written before
    // that column existed — `priorBasis` says which one was used, because
    // "0.47 of the window in one request" and "1.54 of the window summed over
    // steps" are different claims and one of them is not an occupancy at all.
    const maxIn = row.usage_input_max;
    const cache = row.usage_cached_input;
    const input = row.usage_input;
    let prior = null;
    let basis = null;
    if (maxIn !== null && maxIn !== undefined && Number.isFinite(Number(maxIn)) && Number(maxIn) > 0) {
      prior = Number(maxIn);
      basis = "inputMax";
    } else if (cache !== null && cache !== undefined && Number.isFinite(Number(cache))) {
      prior = Number(cache);
      basis = "cache";
    } else if (input !== null && input !== undefined && Number(input) > 0) {
      prior = Number(input);
      basis = "input";
    }
    if (prior === null || !Number.isFinite(prior) || prior < 0) return event;
    const ratio = prior / window;
    return {
      ...event,
      detail: {
        ...detail,
        cause: ratio >= PRIOR_CACHE_RATIO_FOR_ACCUMULATION ? "history_accumulation" : "single_round_too_large",
        priorCacheRatio: Math.round(ratio * 100) / 100,
        priorBasis: basis,
      },
    };
  }

  function appendTurnEvent(rawEvent) {
    const event = fillContextCause(rawEvent);
    const base = [
      event.fleetId,
      event.memberId,
      event.source,
      event.status,
      event.errorKind ?? null,
      event.error ?? null,
      event.model ?? null,
      event.startedAt,
      event.endedAt,
      event.sessionId ?? null,
      event.turnId ?? null,
      event.runId ?? null,
      event.parentTurnId ?? null,
      event.edgeKind ?? null,
      usageInt(event.usage?.input),
      usageInt(event.usage?.output),
      event.traceTurnId ?? null,
      event.detail ? JSON.stringify(event.detail) : null,
    ];
    // Turn metering (add-turn-metering): the aggregate columns ride the SAME
    // INSERT. Degrade (design D6): if the extended insert fails (a
    // pre-migration table in a mixed-version window), fall back to the legacy
    // shape so the EVENT itself never regresses — the metering columns and the
    // daily rollup skip for this row, and a throttled warn surfaces the drift.
    const m = event.metering ?? {};
    const pricing = event.pricing ?? null;
    const meteringArgs = [
      m.presetId ?? null,
      m.presetSource ?? null,
      m.provider ?? null,
      m.effort ?? null,
      m.carrier ?? null,
      m.carrierInstance ?? null,
      m.laneId ?? null,
      Number.isFinite(m.depth) ? m.depth : null,
      Number.isFinite(m.wave) ? m.wave : null,
      usageInt(m.usageCachedInput),
      usageInt(event.inputTokensMax),
      usageInt(m.usageCacheWrite),
      usageInt(m.usageReasoning),
      Number.isFinite(m.queueWaitMs) ? Math.max(0, Math.round(m.queueWaitMs)) : null,
      Number.isFinite(m.spinUpMs) ? Math.max(0, Math.round(m.spinUpMs)) : null,
      Number.isFinite(m.ttftMs) ? Math.max(0, Math.round(m.ttftMs)) : null,
    ];
    let out;
    try {
      out = db
        .prepare(`
          INSERT INTO member_turn_events (fleet_id, member_id, source, status, error_kind, error, model, started_at, ended_at, session_id,
                                          turn_id, run_id, parent_turn_id, edge_kind, usage_input, usage_output, trace_turn_id, detail,
                                          preset_id, preset_source, provider, effort, carrier, carrier_instance, lane_id, depth, wave,
                                          usage_cached_input, usage_input_max, usage_cache_write, usage_reasoning, queue_wait_ms, spin_up_ms, ttft_ms, pricing_at,
                                          cost_input_usd, cost_output_usd, cost_cache_write_usd, cost_cache_read_usd, runtime_fingerprint)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(turn_id) DO NOTHING
        `)
        .run(
          ...base,
          ...meteringArgs,
          Number.isFinite(pricing?.pricingAt) ? pricing.pricingAt : null,
          // Only a PRICED turn contributes money; unpriced stays NULL.
          Number.isFinite(pricing?.inputUsd) ? pricing.inputUsd : null,
          Number.isFinite(pricing?.outputUsd) ? pricing.outputUsd : null,
          Number.isFinite(pricing?.cacheWriteUsd) ? pricing.cacheWriteUsd : null,
          Number.isFinite(pricing?.cacheReadUsd) ? pricing.cacheReadUsd : null,
          // runtime-fingerprint 3.3: the attempt's configuration identity, or
          // NULL when none was computed. Never fabricated.
          typeof event.runtimeFingerprint === "string" && event.runtimeFingerprint ? event.runtimeFingerprint : null,
        );
    } catch (e) {
      // 别再猜原因。这句以前写死成「metering columns unavailable」，于是锁竞争、
      // 超时、绑值失败全被归因成「列不存在」——2026-11-14 追这 16 条回合的缺口时，
      // 正是这句把方向带偏过一次。现在只陈述事实：扩展插入失败、走了旧形状，附原始错误。
      meteringWarnOnce(`extended insert failed, legacy event shape (${e.message})`);
      out = db
        .prepare(`
          INSERT INTO member_turn_events (fleet_id, member_id, source, status, error_kind, error, model, started_at, ended_at, session_id,
                                          turn_id, run_id, parent_turn_id, edge_kind, usage_input, usage_output, trace_turn_id, detail)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(turn_id) DO NOTHING
        `)
        .run(...base);
      // **这里不能 return。** 早返回会把下面的日汇总整段跳过：事件行写成功、
      // 永久汇总不计数，而且除了事后对账没有任何信号。实测 cell
      // 1da519d4c1c0bf89 的 2026-11-03 有 16 行「所有计量列全 NULL」（正是从这条路
      // 写进来的），日汇总恰好少 16 个回合。旧形状缺的只是**事件行上**的计量列，
      // 而日汇总累加用的是内存里的 `m`，不读事件行；即使 member_turn_daily 本身是
      // 旧表，它自己的 try/catch 也会兜住，不会把主写入带崩。
    }
    // 记账幂等（fix-fleet-replay-dispatch-and-turn-accounting 2.3）。
    //
    // `turn_id` 上有唯一索引（`idx_turn_events_turn_id`），所以「同一回合被结算两次」
    // （worker 与串行链双记、或一次重放）**不会再落第二行**——但修复前它是**抛**
    // UNIQUE 约束错误，异常顺着 `recordTurnEvent` 传给调用方：写侧看到的是一个
    // 失败，读侧看到的是「行数刚好也对」，两种读数互相矛盾。现在改成
    // `ON CONFLICT(turn_id) DO NOTHING`（上方两处 INSERT），`changes === 0` 即
    // 「这一轮已经记过」，于是**幂等地**返回已有的那一行。
    //
    // 必须在这里 return：日汇总是**累加**（`turns + 1`），重复结算再走一遍会把
    // 金额与回合数数两遍——「只落一行」和「只算一次」是同一件事的两半，只做前一半
    // 会让账本比逐行明细更贵。
    //
    // 量词要紧：`turn_id` 为 NULL 的回合（生产实测 773/11,574 ≈ 6.7%）**不受这条
    // 保护**——SQLite 的唯一约束把 NULL 视为互不相等，`ON CONFLICT` 也不会命中。
    // 那部分回合没有身份，只能按既有的 prune/对账去看；本条不假装覆盖它们。
    if (event.turnId != null && (out?.changes ?? 1) === 0) {
      meteringWarnOnce(`duplicate turn_id ignored (already recorded): ${String(event.turnId)}`);
      const existing = db.prepare("SELECT * FROM member_turn_events WHERE turn_id = ?").get(event.turnId);
      return existing ? deserializeTurnEvent(existing) : null;
    }
    try {
      const day = new Date(event.startedAt).toISOString().slice(0, 10);
      const carrier = m.carrier ?? null;
      const provider = m.provider ?? null;
      const model = event.model ?? null;
      db.prepare(`
        INSERT INTO member_turn_daily (
          fleet_id, member_id, carrier, provider, model, day,
          turns, ok_count, failed_count, skipped_count,
          usage_input, usage_cached_input, usage_cache_write, usage_reasoning, usage_output,
          queue_wait_ms_sum, queue_wait_ms_max, ttft_ms_sum, ttft_ms_max, spin_up_ms_sum, spin_up_ms_max,
          cost_input_usd, cost_output_usd, cost_cache_write_usd, cost_cache_read_usd, pricing_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(fleet_id, member_id, carrier, provider, model, day) DO UPDATE SET
          turns = turns + 1,
          ok_count = ok_count + excluded.ok_count,
          failed_count = failed_count + excluded.failed_count,
          skipped_count = skipped_count + excluded.skipped_count,
          usage_input = usage_input + excluded.usage_input,
          usage_cached_input = usage_cached_input + excluded.usage_cached_input,
          usage_cache_write = usage_cache_write + excluded.usage_cache_write,
          usage_reasoning = usage_reasoning + excluded.usage_reasoning,
          usage_output = usage_output + excluded.usage_output,
          queue_wait_ms_sum = queue_wait_ms_sum + excluded.queue_wait_ms_sum,
          queue_wait_ms_max = CASE WHEN excluded.queue_wait_ms_max IS NOT NULL AND (queue_wait_ms_max IS NULL OR excluded.queue_wait_ms_max > queue_wait_ms_max)
            THEN excluded.queue_wait_ms_max ELSE queue_wait_ms_max END,
          ttft_ms_sum = ttft_ms_sum + excluded.ttft_ms_sum,
          ttft_ms_max = CASE WHEN excluded.ttft_ms_max IS NOT NULL AND (ttft_ms_max IS NULL OR excluded.ttft_ms_max > ttft_ms_max)
            THEN excluded.ttft_ms_max ELSE ttft_ms_max END,
          spin_up_ms_sum = spin_up_ms_sum + excluded.spin_up_ms_sum,
          spin_up_ms_max = CASE WHEN excluded.spin_up_ms_max IS NOT NULL AND (spin_up_ms_max IS NULL OR excluded.spin_up_ms_max > spin_up_ms_max)
            THEN excluded.spin_up_ms_max ELSE spin_up_ms_max END,
          cost_input_usd = cost_input_usd + excluded.cost_input_usd,
          cost_output_usd = cost_output_usd + excluded.cost_output_usd,
          cost_cache_write_usd = cost_cache_write_usd + excluded.cost_cache_write_usd,
          cost_cache_read_usd = cost_cache_read_usd + excluded.cost_cache_read_usd,
          pricing_at = COALESCE(excluded.pricing_at, pricing_at),
          updated_at = excluded.updated_at
      `).run(
        event.fleetId,
        event.memberId,
        carrier,
        provider,
        model,
        day,
        event.status === "ok" ? 1 : 0,
        event.status === "failed" || event.status === "interrupted" ? 1 : 0,
        event.status === "skipped" ? 1 : 0,
        usageInt(event.usage?.input) ?? 0,
        usageInt(m.usageCachedInput) ?? 0,
        usageInt(m.usageCacheWrite) ?? 0,
        usageInt(m.usageReasoning) ?? 0,
        usageInt(event.usage?.output) ?? 0,
        Number.isFinite(m.queueWaitMs) ? Math.max(0, Math.round(m.queueWaitMs)) : 0,
        Number.isFinite(m.queueWaitMs) ? Math.max(0, Math.round(m.queueWaitMs)) : null,
        Number.isFinite(m.ttftMs) ? Math.max(0, Math.round(m.ttftMs)) : 0,
        Number.isFinite(m.ttftMs) ? Math.max(0, Math.round(m.ttftMs)) : null,
        Number.isFinite(m.spinUpMs) ? Math.max(0, Math.round(m.spinUpMs)) : 0,
        Number.isFinite(m.spinUpMs) ? Math.max(0, Math.round(m.spinUpMs)) : null,
        // Turn pricing (add-turn-pricing): only PRICED turns contribute money —
        // an unpriced turn (pricingAt null) adds nothing and stamps nothing.
        Number.isFinite(pricing?.inputUsd) ? pricing.inputUsd : 0,
        Number.isFinite(pricing?.outputUsd) ? pricing.outputUsd : 0,
        Number.isFinite(pricing?.cacheWriteUsd) ? pricing.cacheWriteUsd : 0,
        Number.isFinite(pricing?.cacheReadUsd) ? pricing.cacheReadUsd : 0,
        Number.isFinite(pricing?.pricingAt) ? pricing.pricingAt : null,
        Date.now(),
      );
    } catch (e) {
      meteringWarnOnce(`daily rollup failed (event row intact): ${e.message}`);
    }
    // Dual-condition prune (agent-fleet-core, v2): only rows that are both
    // past the retention window AND beyond the member's newest-N floor go.
    db.prepare(`
      DELETE FROM member_turn_events
      WHERE member_id = ? AND ended_at < ? AND id NOT IN (
        SELECT id FROM member_turn_events WHERE member_id = ? ORDER BY id DESC LIMIT ?
      )
    `).run(event.memberId, Date.now() - runRetentionMs(), event.memberId, turnEventKeep());
    return deserializeTurnEvent(
      db.prepare("SELECT * FROM member_turn_events WHERE id = ?").get(out.lastInsertRowid),
    );
  }

  // Metering degrade warn, once per message per process (the seam runs every
  // turn — a broken rollup must not flood the log).
  const meteringWarned = new Set();
  function meteringWarnOnce(message) {
    if (meteringWarned.has(message)) return;
    meteringWarned.add(message);
    console.warn(`[fleets-db] turn metering: ${message}`);
  }

  function getTurnEvent(turnId) {
    if (!turnId) return null;
    const row = db.prepare("SELECT * FROM member_turn_events WHERE turn_id = ?").get(turnId);
    return row ? deserializeTurnEvent(row) : null;
  }

  // Timeline page, newest first; `beforeId` (exclusive) pages via the last
  // row's id — same cursor shape as the report timeline.
  function listTurnEvents(memberId, { beforeId = null, limit = 20 } = {}) {
    const rows = beforeId == null
      ? db.prepare("SELECT * FROM member_turn_events WHERE member_id = ? ORDER BY id DESC LIMIT ?").all(memberId, limit)
      : db.prepare("SELECT * FROM member_turn_events WHERE member_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(memberId, beforeId, limit);
    return rows.map(deserializeTurnEvent);
  }

  // Boot-sweep dedupe (fix-interrupted-turn-event-on-restart): did the
  // slot-claim path (worker-slots) already land an interrupted row for the
  // same round? The two paths write for different restart shapes (claim-time
  // refusal vs mid-flight kill) and can both fire for one round; a bounded
  // started_at window identifies the same round without a run-id join.
  function hasInterruptedTurnNear(memberId, startedAtMs, toleranceMs = 90000) {
    if (!Number.isFinite(startedAtMs)) return false;
    const row = db
      .prepare("SELECT 1 FROM member_turn_events WHERE member_id = ? AND status = 'interrupted' AND started_at BETWEEN ? AND ? LIMIT 1")
      .get(memberId, startedAtMs - toleranceMs, startedAtMs + toleranceMs);
    return Boolean(row);
  }

  // Fleet-wide filter (status/source optional, validated by the route).
  function listFleetTurnEvents(fleetId, { status = null, source = null, limit = 50 } = {}) {
    const where = ["fleet_id = ?"];
    const args = [fleetId];
    if (status) {
      where.push("status = ?");
      args.push(status);
    }
    if (source) {
      where.push("source = ?");
      args.push(source);
    }
    return db
      .prepare(`SELECT * FROM member_turn_events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
      .all(...args, limit)
      .map(deserializeTurnEvent);
  }

  // 每岗位「最新一条带上下文读数的回合」（rotate-cron-session-on-context-pressure 1.2）。
  //
  // 为什么要单开一条访问器，而不是让路由拿 `listFleetTurnEvents(fleetId, {limit:100})`
  // 自己挑：那条上限是**行数**，不是岗位数——一个 20 岗的舰队每岗 5 轮就把它挤满，
  // 后 10 个岗的读数凭空消失，而读面看起来一切正常（「人口被静默收窄」那一族）。
  //
  // 只认**带读数**的回合：一条 skipped/无 usage 的新回合不该把该岗位已知的会话占比
  // 一起抹掉（那不是「现在是 0」，是「本轮没测到」）。scan 是防御上界，不是人口定义——
  // 命中即为该岗位最新带读数的那一条。
  function latestTurnContextByFleet(fleetId, { scan = 2000 } = {}) {
    const rows = db
      .prepare("SELECT * FROM member_turn_events WHERE fleet_id = ? ORDER BY id DESC LIMIT ?")
      .all(fleetId, scan);
    const latest = new Map();
    for (const row of rows) {
      if (latest.has(row.member_id)) continue;
      const event = deserializeTurnEvent(row);
      const usage = event?.detail?.contextUsage;
      if (!usage || typeof usage !== "object") continue;
      latest.set(row.member_id, event);
    }
    return [...latest.values()];
  }

  // Presence cares about REAL rounds only (fix-fleet-turn-veracity D3): a
  // skipped row must never read as "the post just worked". Null when the
  // stream holds only skips (a presence that then rightfully goes stale).
  function latestRealTurnFor(memberId) {
    const row = db
      .prepare("SELECT * FROM member_turn_events WHERE member_id = ? AND status IN ('ok','failed','interrupted') ORDER BY id DESC LIMIT 1")
      .get(memberId);
    return row ? deserializeTurnEvent(row) : null;
  }

  // Skipped rounds inside a window — the "第 k 次" counter for the card badge
  // and the missing-reason count (same read-time aggregate, two consumers).
  function skippedCount(memberId, { sinceMs = null } = {}) {
    const row = sinceMs == null
      ? db.prepare("SELECT COUNT(*) AS n FROM member_turn_events WHERE member_id = ? AND status = 'skipped'").get(memberId)
      : db.prepare("SELECT COUNT(*) AS n FROM member_turn_events WHERE member_id = ? AND status = 'skipped' AND ended_at >= ?").get(memberId, sinceMs);
    return row?.n ?? 0;
  }

  function latestTurnFor(memberId) {
    const row = db
      .prepare("SELECT * FROM member_turn_events WHERE member_id = ? ORDER BY id DESC LIMIT 1")
      .get(memberId);
    return row ? deserializeTurnEvent(row) : null;
  }

  // Count failures walking back from the newest event; the first non-failure
  // (ok/interrupted) stops the run. Aggregated from the stream by design —
  // no counter storage (spec: 不要求独立计数).
  function consecutiveFailures(memberId) {
    return failureStreak(memberId).streak;
  }

  // The failure streak AND its attribution in ONE pass (fix-fleet-failure-
  // visibility D4): a post that has failed N rounds in a row must be able to
  // say WHY and SINCE WHEN, not just that a number is high. `since` is the
  // oldest failure still in the streak; `lastErrorKind` is the newest one's
  // category (the one an operator acts on first). Interrupted rounds are not
  // failures — they stop the streak like any other non-failed row. Skipped
  // rounds (fix-fleet-turn-veracity D2 — runtime never ready, or the lane
  // breaker open) are transparent: never counted, never breaking the chain,
  // never touching since/lastErrorKind (the platform's outage neither poisons
  // nor heals the post's own streak).
  function failureStreak(memberId) {
    const rows = db
      .prepare(
        "SELECT status, started_at, error_kind FROM member_turn_events WHERE member_id = ? ORDER BY id DESC",
      )
      .all(memberId);
    let streak = 0;
    let since = null;
    let lastErrorKind = null;
    for (const r of rows) {
      if (r.status === "skipped") continue;
      if (r.status !== "failed") break;
      if (streak === 0) lastErrorKind = r.error_kind ?? null;
      since = r.started_at ?? since;
      streak += 1;
    }
    return { streak, since: streak > 0 ? since : null, lastErrorKind };
  }

  // Fleet-level budget pressure (fix-fleet-failure-visibility D6): one post
  // failing on `budget` can be that post's narrow model chain; SEVERAL posts
  // failing on it at once is the deployment being out of quota — the failure
  // mode that produced 441 failures in one day with no signal anywhere.
  // Read-only, one query, bounded window; `since` is the oldest such failure
  // still in the window so the cockpit can say how long it has been dark.
  function budgetPressure(fleetId, { windowMs = 24 * 3600_000, now = Date.now() } = {}) {
    const sinceMs = now - windowMs;
    const rows = db
      .prepare(
        `SELECT member_id, error_kind, started_at FROM member_turn_events
         WHERE fleet_id = ? AND started_at >= ? AND status = 'failed' AND error_kind = 'budget'`,
      )
      .all(fleetId, sinceMs);
    if (!rows.length) return null;
    const members = new Set();
    let oldest = Infinity;
    for (const r of rows) {
      members.add(r.member_id);
      if (Number.isFinite(r.started_at) && r.started_at < oldest) oldest = r.started_at;
    }
    return {
      members: members.size,
      failures: rows.length,
      since: Number.isFinite(oldest) ? oldest : null,
      windowHours: Math.round(windowMs / 3_600_000),
    };
  }

  // ── run ledger (agent-fleet-runs) ─────────────────────────────────────────

  // Header row for a root turn. INSERT OR IGNORE: a run that was already
  // opened (a late downstream turn re-opening a closed one goes through
  // reopenRun) is left alone.
  function insertRun({ runId, fleetId, rootSource, rootMemberId, startedAt }) {
    db.prepare(`
      INSERT OR IGNORE INTO fleet_runs (run_id, fleet_id, root_source, root_member_id, started_at, status)
      VALUES (?, ?, ?, ?, ?, 'open')
    `).run(runId, fleetId, rootSource, rootMemberId, startedAt);
    return getRun(runId);
  }

  function getRun(runId) {
    const row = db.prepare("SELECT * FROM fleet_runs WHERE run_id = ?").get(runId);
    return row ? deserializeRun(row) : null;
  }

  // A downstream turn arriving after the header closed (a queued handoff that
  // waited behind other work) re-opens it; finalizeRun recomputes everything
  // from the turn rows, so the header is always a projection, never a counter.
  function reopenRun(runId) {
    db.prepare("UPDATE fleet_runs SET status = 'open', ended_at = NULL WHERE run_id = ?").run(runId);
    return getRun(runId);
  }

  // Close the header from its turn rows (SUM, not increment — idempotent by
  // construction: calling it twice yields the same row). Status: ok when every
  // turn succeeded, failed when none did, partial otherwise; interrupted turns
  // count as not-ok but not failed.
  function finalizeRun(runId, { endedAt = null } = {}) {
    const agg = db
      .prepare(`
        SELECT COUNT(*) AS turns,
               SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
               SUM(usage_input) AS usage_input,
               SUM(usage_output) AS usage_output,
               MAX(ended_at) AS last_ended
        FROM member_turn_events WHERE run_id = ?
      `)
      .get(runId);
    const turns = agg?.turns ?? 0;
    const okCount = agg?.ok_count ?? 0;
    const failedCount = agg?.failed_count ?? 0;
    const status = turns === 0 ? "open" : okCount === turns ? "ok" : okCount === 0 && failedCount > 0 ? "failed" : "partial";
    db.prepare(`
      UPDATE fleet_runs
      SET ended_at = ?, status = ?, turns = ?, ok_count = ?, failed_count = ?, usage_input = ?, usage_output = ?
      WHERE run_id = ?
    `).run(
      endedAt ?? agg?.last_ended ?? Date.now(),
      status,
      turns,
      okCount,
      failedCount,
      agg?.usage_input ?? null,
      agg?.usage_output ?? null,
      runId,
    );
    return getRun(runId);
  }

  // Stop a run (add-fleet-run-budget D3): idempotent, first writer wins so a
  // budget stop and an owner cancel cannot overwrite each other's reason.
  function stopRun(runId, { reason = null, at = Date.now() } = {}) {
    const row = getRun(runId);
    if (!row) return null;
    if (row.stoppedAt != null) return row;
    db.prepare("UPDATE fleet_runs SET stopped_at = ?, stop_reason = ? WHERE run_id = ? AND stopped_at IS NULL").run(
      at,
      reason,
      runId,
    );
    return getRun(runId);
  }

  // Live usage for the ignition gate: summed from the turn rows (the same
  // source finalizeRun trusts) so a mid-run read never needs a counter that may
  // drift. Timestamps ride along for the wall-clock ceiling.
  function runUsage(runId) {
    const row = getRun(runId);
    if (!row) return null;
    const agg = db
      .prepare(`
        SELECT COUNT(*) AS turns,
               SUM(COALESCE(usage_input, 0)) AS usage_input,
               SUM(COALESCE(usage_output, 0)) AS usage_output,
               SUM(CASE WHEN usage_input IS NULL AND usage_output IS NULL THEN 1 ELSE 0 END) AS unmeasured
        FROM member_turn_events WHERE run_id = ?
      `)
      .get(runId);
    return {
      turns: agg?.turns ?? 0,
      tokens: (agg?.usage_input ?? 0) + (agg?.usage_output ?? 0),
      unmeasuredTurns: agg?.unmeasured ?? 0,
      startedAt: row.startedAt,
      stoppedAt: row.stoppedAt ?? null,
      stopReason: row.stopReason ?? null,
    };
  }

  // Paged list, newest first. `since`/`until` bound started_at; `source`
  // filters root_source; `status` filters the header status.
  function listRuns(fleetId, { status = null, source = null, since = null, until = null, limit = 50, offset = 0 } = {}) {
    const where = ["fleet_id = ?"];
    const args = [fleetId];
    if (status) {
      where.push("status = ?");
      args.push(status);
    }
    if (source) {
      where.push("root_source = ?");
      args.push(source);
    }
    if (Number.isFinite(since)) {
      where.push("started_at >= ?");
      args.push(since);
    }
    if (Number.isFinite(until)) {
      where.push("started_at <= ?");
      args.push(until);
    }
    const total = db.prepare(`SELECT COUNT(*) AS n FROM fleet_runs WHERE ${where.join(" AND ")}`).get(...args).n;
    const rows = db
      .prepare(`SELECT * FROM fleet_runs WHERE ${where.join(" AND ")} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset);
    return { total, runs: rows.map(deserializeRun) };
  }

  // The run's turn rows in start order — the timeline's waterfall input. The
  // chain is reconstructed by the reader from parentTurnId × edgeKind.
  function listRunTurns(runId) {
    return db
      .prepare("SELECT * FROM member_turn_events WHERE run_id = ? ORDER BY started_at ASC, id ASC")
      .all(runId)
      .map(deserializeTurnEvent);
  }

  // Per-run money (add-fleet-cost-read-face D2): summed from the turn rows the
  // run already owns, so it is the price that was in force WHEN each turn ran —
  // not a re-price at today's rates. `pricedTurns` is the sample size (a run
  // with unpriced turns reports a smaller sample, never a smeared average).
  // Returns Map<runId, {usd, pricedTurns, turns}>; `sinceMs` bounds started_at.
  function runCosts(fleetId, { sinceMs = 0 } = {}) {
    const rows = db
      .prepare(`
        SELECT run_id,
               COUNT(*) AS turns,
               SUM(CASE WHEN pricing_at IS NOT NULL THEN 1 ELSE 0 END) AS priced_turns,
               SUM(COALESCE(cost_input_usd, 0) + COALESCE(cost_output_usd, 0)
                   + COALESCE(cost_cache_write_usd, 0) + COALESCE(cost_cache_read_usd, 0)) AS usd
        FROM member_turn_events
        WHERE fleet_id = ? AND run_id IS NOT NULL AND started_at >= ?
        GROUP BY run_id
      `)
      .all(fleetId, sinceMs);
    const out = new Map();
    for (const r of rows) {
      out.set(r.run_id, {
        usd: Number.isFinite(r.usd) ? r.usd : null,
        pricedTurns: r.priced_turns ?? 0,
        turns: r.turns ?? 0,
      });
    }
    return out;
  }

  function runCost(runId) {
    const r = db
      .prepare(`
        SELECT COUNT(*) AS turns,
               SUM(CASE WHEN pricing_at IS NOT NULL THEN 1 ELSE 0 END) AS priced_turns,
               SUM(COALESCE(cost_input_usd, 0) + COALESCE(cost_output_usd, 0)
                   + COALESCE(cost_cache_write_usd, 0) + COALESCE(cost_cache_read_usd, 0)) AS usd
        FROM member_turn_events WHERE run_id = ?
      `)
      .get(runId);
    if (!r) return null;
    return { usd: Number.isFinite(r.usd) ? r.usd : null, pricedTurns: r.priced_turns ?? 0, turns: r.turns ?? 0 };
  }

  // 花销读数(a)：回合/token 事实投影 (fleet-owner-surface)。与 fleet_runs 同
  // 纪律 —— always a projection (SUM 现算, 不落计数器), usage 缺失的行如实进
  // 缺数（NULL 合计不虚构 token）。
  function spendProjection(fleetId, { now = Date.now() } = {}) {
    const windowAgg = (sinceMs) => {
      const agg = db
        .prepare(
          `SELECT COUNT(*) AS runs,
                  COALESCE(SUM(turns), 0) AS turns,
                  SUM(usage_input) AS usage_input,
                  SUM(usage_output) AS usage_output
           FROM fleet_runs WHERE fleet_id = ? AND started_at >= ?`,
        )
        .get(fleetId, sinceMs);
      // Money for the same window, from the turn rows (the only place the
      // per-turn estimate lives). `costUsd` stays null when NOTHING in the
      // window was priced — honest absence, never a zero posing as a reading.
      const money = db
        .prepare(`
          SELECT SUM(CASE WHEN pricing_at IS NOT NULL THEN 1 ELSE 0 END) AS priced_turns,
                 -- 半截用量（fix-overflow-attribution D4）：溢出回合保留已观测 usage，
                 -- 那些 token 真扣了钱，所以计入花费；但读面必须知道其中几条是半截快照。
                 -- 这一行在 2026-11-10 的并线（968a3fc38）里被整行带走，靠
                 -- test-fleet-context-pressure 的 partialTurns 用例抓回来——别删。
                 SUM(CASE WHEN detail LIKE '%"usagePartial":true%' THEN 1 ELSE 0 END) AS partial_turns,
                 SUM(COALESCE(cost_input_usd, 0) + COALESCE(cost_output_usd, 0)
                     + COALESCE(cost_cache_write_usd, 0) + COALESCE(cost_cache_read_usd, 0)) AS usd,
                 SUM(CASE WHEN json_extract(detail, '$.usagePartial') = 1 THEN 1 ELSE 0 END) AS partial_turns
          FROM member_turn_events WHERE fleet_id = ? AND started_at >= ?
        `)
        .get(fleetId, sinceMs);
      // Delivery (enforce-report-contract): of the rounds that actually ran,
      // how many delivered what their post owes. Kept SEPARATE from the pass
      // rate on purpose — `ok` still means "the loop ended", and the delivery
      // contract deliberately does not touch status. `deliveredOk` is the count
      // of ok rounds NOT flagged missingReport; the rate divides by ALL turns so
      // it can be read next to the pass rate without rescaling.
      // Starts at the rollout of the flag: rows before it carry no detail key
      // and therefore read as "delivered", which is why the read face says so.
      const delivery = db
        .prepare(`
          SELECT COUNT(*) AS event_turns,
                 SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_turns,
                 SUM(CASE WHEN status = 'ok' AND detail LIKE '%"missingReport":true%' THEN 1 ELSE 0 END) AS flagged
          FROM member_turn_events WHERE fleet_id = ? AND started_at >= ?
        `)
        .get(fleetId, sinceMs);
      // Denominator and numerator come from the SAME table: `turns` above is the
      // fleet_runs projection, which can be absent for an ad-hoc window while
      // the turn rows exist. Mixing the two made the rate read null.
      const eventTurns = delivery?.event_turns ?? 0;
      const okTurns = delivery?.ok_turns ?? 0;
      const flagged = delivery?.flagged ?? 0;
      const deliveredOk = Math.max(0, okTurns - flagged);
      return {
        runs: agg.runs ?? 0,
        turns: agg.turns ?? 0,
        usageInput: agg.usage_input ?? null,
        usageOutput: agg.usage_output ?? null,
        costUsd: money?.priced_turns > 0 && Number.isFinite(money?.usd) ? money.usd : null,
        pricedTurns: money?.priced_turns ?? 0,
        // A context-overflow turn is still billed for what it did produce, so it
        // belongs IN costUsd — but a caller reading "what did this fleet
        // consume" must be able to see how much of that came from half-turns,
        // otherwise truncated spend reads as clean spend. The producer has
        // marked rows (`detail.usagePartial`, server/cron-runner.js) since
        // fix-overflow-attribution; nothing ever counted them, and the test
        // written to prove the counter existed was the field's only mention.
        partialTurns: money?.partial_turns ?? 0,
        // 交付率与通过率并列（设计 D4）：两个数一起看才不会被 `ok` 单独骗过。
        okTurns,
        missingReportTurns: flagged,
        deliveredOk,
        eventTurns,
        deliveryRate: eventTurns > 0 ? deliveredOk / eventTurns : null,
        deliveryBasis: "since the missingReport flag shipped (earlier rows carry no flag)",
      };
    };
    const day = 24 * 3600_000;
    return {
      baseline: "fleet_runs projection (usage 缺失如实记 null)",
      sampledAt: now,
      windows: {
        "24h": windowAgg(now - day),
        "7d": windowAgg(now - 7 * day),
        "30d": windowAgg(now - 30 * day),
      },
      allTime: windowAgg(0),
    };
  }

  // Edge traffic for the canvas (cockpit D9): hops in the window grouped by
  // (from post, to post, edge kind), with the outcome split. The parent turn
  // row supplies the from post; a parent already pruned leaves the hop out,
  // honestly (the window is shorter than retention, so this is rare).
  function edgeTraffic(fleetId, { sinceMs = Date.now() - 86_400_000 } = {}) {
    return db
      .prepare(`
        SELECT p.member_id AS from_member, c.member_id AS to_member, c.edge_kind AS edge_kind,
               COUNT(*) AS turns,
               SUM(CASE WHEN c.status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
               SUM(CASE WHEN c.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
               SUM(CASE WHEN c.pricing_at IS NOT NULL THEN 1 ELSE 0 END) AS priced_turns,
               SUM(COALESCE(c.cost_input_usd, 0) + COALESCE(c.cost_output_usd, 0)
                   + COALESCE(c.cost_cache_write_usd, 0) + COALESCE(c.cost_cache_read_usd, 0)) AS usd,
               MAX(c.ended_at) AS last_ended
        FROM member_turn_events c
        JOIN member_turn_events p ON p.turn_id = c.parent_turn_id
        WHERE c.fleet_id = ? AND c.edge_kind IS NOT NULL AND c.started_at >= ?
        GROUP BY p.member_id, c.member_id, c.edge_kind
      `)
      .all(fleetId, sinceMs)
      .map((r) => ({
        from: r.from_member,
        to: r.to_member,
        kind: r.edge_kind,
        turns: r.turns,
        ok: r.ok_count ?? 0,
        failed: r.failed_count ?? 0,
        // What this hop cost (add-fleet-cost-read-face D3): the CHILD turn's own
        // estimate — the hop is the child. Null when none of its turns were
        // priced, so the canvas never draws a $0 edge it cannot prove.
        costUsd: r.priced_turns > 0 && Number.isFinite(r.usd) ? r.usd : null,
        pricedTurns: r.priced_turns ?? 0,
        lastEndedAt: r.last_ended ?? null,
      }));
  }

  // ── runtime-fingerprint read face (harden-agent-runtime-spine 3.5) ─────────
  //
  // Group attempts by the configuration that produced them. The rules the
  // query must obey (spec runtime-fingerprint):
  //   • the success-rate DENOMINATOR is attempts whose status is a verdict
  //     (ok / failed) — `interrupted`, `cancelled`, `lease_expired` and
  //     `skipped` are outcomes that say nothing about quality, so they are
  //     counted separately and excluded;
  //   • unmetered attempts (no usage) are counted and visible, never in a rate;
  //   • attempts with NO fingerprint form their own row (fingerprint null),
  //     never folded into a real version and never dropped.
  //
  // Money and latency are sums over the rows that HAD the number, with the
  // sample size (`pricedTurns` / `timedTurns`) beside them so a "$0.00 over 1
  // turn" cannot be read as a fleet-wide average.
  function fingerprintGroups({ fleetId = null, sinceMs = null, memberId = null } = {}) {
    const where = [];
    const args = [];
    if (fleetId) { where.push("fleet_id = ?"); args.push(fleetId); }
    if (memberId) { where.push("member_id = ?"); args.push(memberId); }
    if (sinceMs != null) { where.push("started_at >= ?"); args.push(sinceMs); }
    const rows = db
      .prepare(`
        SELECT runtime_fingerprint AS fp,
               COUNT(*) AS attempts,
               SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
               SUM(CASE WHEN status IN ('interrupted','cancelled','lease_expired','skipped') THEN 1 ELSE 0 END) AS not_a_verdict,
               SUM(CASE WHEN usage_input IS NULL AND usage_output IS NULL THEN 1 ELSE 0 END) AS unmetered,
               SUM(CASE WHEN cost_input_usd IS NOT NULL THEN 1 ELSE 0 END) AS priced_turns,
               SUM(COALESCE(cost_input_usd,0) + COALESCE(cost_output_usd,0)
                   + COALESCE(cost_cache_write_usd,0) + COALESCE(cost_cache_read_usd,0)) AS cost_usd,
               SUM(CASE WHEN ended_at IS NOT NULL AND started_at IS NOT NULL THEN 1 ELSE 0 END) AS timed_turns,
               SUM(CASE WHEN ended_at IS NOT NULL AND started_at IS NOT NULL THEN ended_at - started_at ELSE 0 END) AS duration_ms
        FROM member_turn_events
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        GROUP BY runtime_fingerprint
        ORDER BY attempts DESC
      `)
      .all(...args);
    return rows.map((r) => {
      const verdicts = r.ok_count + r.failed_count;
      return {
        fingerprint: r.fp ?? null,
        // Explicit: a row with no fingerprint is "not measured", not a version.
        unnamed: r.fp == null,
        attempts: r.attempts,
        verdicts,
        ok: r.ok_count,
        failed: r.failed_count,
        notAVerdict: r.not_a_verdict,
        unmetered: r.unmetered,
        // Null (not 1, not 0) when there is no verdict to divide by: an
        // undefined rate must not read as "0 % success".
        successRate: verdicts > 0 ? r.ok_count / verdicts : null,
        unmeteredShare: r.attempts > 0 ? r.unmetered / r.attempts : null,
        cost: {
          usd: r.priced_turns > 0 ? r.cost_usd : null,
          pricedTurns: r.priced_turns,
          perAttemptUsd: r.priced_turns > 0 ? r.cost_usd / r.priced_turns : null,
        },
        duration: {
          meanMs: r.timed_turns > 0 ? Math.round(r.duration_ms / r.timed_turns) : null,
          timedTurns: r.timed_turns,
        },
      };
    });
  }

  // Hourly sweep (D10): closed headers past the window go; open ones never.
  // Turn rows are pruned on their own dual condition at append time and here
  // (a quiet cell with no new turns still ages out). Returns counts.
  function pruneRuns({ now = Date.now() } = {}) {
    const cutoff = now - runRetentionMs();
    const runs = db.prepare("DELETE FROM fleet_runs WHERE status != 'open' AND ended_at IS NOT NULL AND ended_at < ?").run(cutoff).changes;
    const members = db.prepare("SELECT DISTINCT member_id FROM member_turn_events WHERE ended_at < ?").all(cutoff);
    let turns = 0;
    const stmt = db.prepare(`
      DELETE FROM member_turn_events
      WHERE member_id = ? AND ended_at < ? AND id NOT IN (
        SELECT id FROM member_turn_events WHERE member_id = ? ORDER BY id DESC LIMIT ?
      )
    `);
    for (const { member_id } of members) {
      turns += stmt.run(member_id, cutoff, member_id, turnEventKeep()).changes;
    }
    const orphans = reclaimOrphanRuns({ now });
    return { runs, turns, orphans };
  }

  // Orphan-open sweep (add-cockpit-run-reclaim): a header opened by begin()
  // whose turn never wrote a row leaves an `open` run that NO future event can
  // close — the settle backstop fires on engine-terminal tasks, and a lost
  // turn produces none. Left alone these squat the list forever (prod
  // 2026-10-26: run_d92b41 sat open 7 hours with zero turns, from a pod roll
  // mid-turn).
  //
  // The verdict used to be `failed`, and that was wrong in exactly the case
  // this sweep mostly sees: a pod roll kills a turn that was running fine.
  // "Ran and concluded badly" and "was stopped from outside and can be re-run"
  // are different facts with different remedies (fix the code vs re-fire), and
  // counting the second as the first pollutes the failure rate it is measured
  // in. `interrupted` is the honest word, and the run has no row to contradict
  // it — the orphan case is DEFINED by the absence of a turn row.
  function reclaimOrphanRuns({ now = Date.now(), graceMs = 30 * 60_000 } = {}) {
    const cutoff = now - graceMs;
    const rows = db
      .prepare(`
        SELECT r.run_id, r.started_at FROM fleet_runs r
        WHERE r.status = 'open' AND r.started_at < ?
          AND NOT EXISTS (SELECT 1 FROM member_turn_events e WHERE e.run_id = r.run_id)
      `)
      .all(cutoff);
    for (const r of rows) {
      db.prepare("UPDATE fleet_runs SET status = 'interrupted', ended_at = ?, turns = 0 WHERE run_id = ?").run(r.started_at, r.run_id);
    }
    return rows.length;
  }

  // Still-open run headers, oldest first — the sweep's worklist. The header
  // is a projection over its turn rows, so an open header past its grace
  // window is a header nobody closed (the settle backstop is in-memory and
  // dies with the pod), not a run that is still working. Which of the two it
  // is CANNOT be decided from the rows alone: a chain whose upstream turn
  // ended and whose downstream turn has not started yet looks exactly like a
  // leaked header. That judgment lives with the ledger (it knows the in-flight
  // handles and the queued engine tasks), so this list is deliberately raw —
  // see fleet-runs.js sweepOpenRuns.
  function listOpenRuns({ before = null, limit = 200 } = {}) {
    const args = [];
    let where = "status = 'open'";
    if (before != null) { where += " AND started_at < ?"; args.push(before); }
    return db
      .prepare(`SELECT run_id, fleet_id, root_source, root_member_id, started_at, turns FROM fleet_runs WHERE ${where} ORDER BY started_at ASC LIMIT ?`)
      .all(...args, limit);
  }

  // Unique-post lookup (design D8): where is this persona/cluster on duty?
  // Cell-global across LIVE fleets; a2a targets never call this (multi-post).
  // Archived (incl. dissolved) fleets release their incumbents — their member
  // rows survive as history, but a dead organization must not squat a live
  // agent (prod 2026-10-23: a dissolved walkthrough fleet blocked restaffing).
  function findPostByTarget(targetKind, targetId, { excludeMemberId = null } = {}) {
    const rows = db
      .prepare(
        `SELECT fm.* FROM fleet_members fm JOIN fleets f ON f.id = fm.fleet_id
         WHERE fm.target_kind = ? AND fm.target_id = ? AND f.state != 'archived'`,
      )
      .all(targetKind, targetId);
    const hit = rows.find((r) => r.id !== excludeMemberId);
    if (!hit) return null;
    const fleet = getFleet(hit.fleet_id);
    return { member: deserializeMember(hit), fleet };
  }

  // ── 迭代链 (fleet-owner-iteration) ────────────────────────────────────────
  function appendIteration({ id, fleetId, packId, decisionId = null, state = "proposed", axis = null, note = "", notes = null, createdBy }) {
    const t = Date.now();
    db.prepare(
      `INSERT INTO fleet_iterations (id, fleet_id, pack_id, decision_id, state, axis, note, notes, published_version, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(id, fleetId, packId, decisionId, state, axis, note, notes, createdBy, t, t);
    return getIteration(id);
  }

  function getIteration(id) {
    const row = db.prepare(`SELECT * FROM fleet_iterations WHERE id = ?`).get(id);
    return row ? deserializeIteration(row) : null;
  }

  function listIterations(fleetId, { limit = 20 } = {}) {
    return db
      .prepare(`SELECT * FROM fleet_iterations WHERE fleet_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(fleetId, Math.min(100, Math.max(1, Number(limit) || 20)))
      .map(deserializeIteration);
  }

  function transitionIteration(id, patch) {
    const sets = [];
    const vals = [];
    for (const [col, v] of Object.entries({ state: patch.state, axis: patch.axis, note: patch.note, notes: patch.notes, published_version: patch.publishedVersion, decision_id: patch.decisionId })) {
      if (v === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return getIteration(id);
    vals.push(Date.now(), id);
    db.prepare(`UPDATE fleet_iterations SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...vals);
    return getIteration(id);
  }

  // ── Digest 订阅 (fleet-owner-iteration) ──────────────────────────────────
  function upsertDigestSub({ id, fleetId, ownerEmail, cadence }) {
    db.prepare(
      `INSERT INTO fleet_digest_subscriptions (id, fleet_id, owner_email, cadence, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (fleet_id, owner_email, cadence) DO NOTHING`,
    ).run(id, fleetId, ownerEmail, cadence, Date.now());
    return db.prepare(`SELECT * FROM fleet_digest_subscriptions WHERE fleet_id = ? AND owner_email = ? AND cadence = ?`)
      .get(fleetId, ownerEmail, cadence) ?? null;
  }

  function listDigestSubscriptions({ ownerEmail = null } = {}) {
    const where = [];
    const args = [];
    if (ownerEmail) {
      where.push("owner_email = ?");
      args.push(ownerEmail);
    }
    return db
      .prepare(`SELECT * FROM fleet_digest_subscriptions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at`)
      .all(...args)
      .map(deserializeDigestSub);
  }

  function removeDigestSub(fleetId, ownerEmail, cadence) {
    db.prepare(`DELETE FROM fleet_digest_subscriptions WHERE fleet_id = ? AND owner_email = ? AND cadence = ?`).run(fleetId, ownerEmail, cadence);
  }

  function touchDigestRun(id, { at = null, sent = false } = {}) {
    const t = at ?? Date.now();
    db.prepare(`UPDATE fleet_digest_subscriptions SET last_run_at = ?${sent ? ", last_sent_at = ?" : ""} WHERE id = ?`)
      .run(...(sent ? [t, t, id] : [t, id]));
  }

  // ── 胜任力候选（establish-agent-role-and-fitness-plane 6.1 / 6.3）──────────
  //
  // 页面正文在 fd-memory（note 页 + metadata kind=competence），这里只存「哪个
  // 页面、什么状态、谁在质疑」——正文不复制，复制的第二真源必然漂移。
  //
  // 6.3 的硬要求落在这里：**候选生效是一次显式动作**（`accept()`），且必须带
  // 验收者身份。证据不足的候选永远停在 candidate，不会因为「时间到了」自动生效。

  function upsertCompetenceCandidate({ id, fleetId, memberId, pageRef, evidence, state }) {
    const now = Date.now();
    const existing = id
      ? db.prepare("SELECT * FROM competence_candidates WHERE id = ?").get(id)
      : db
          .prepare("SELECT * FROM competence_candidates WHERE fleet_id = ? AND member_id = ? AND page_ref = ?")
          .get(fleetId, memberId, pageRef);
    if (existing) {
      db.prepare("UPDATE competence_candidates SET evidence = ?, state = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify(evidence ?? JSON.parse(existing.evidence || "{}")),
        state ?? existing.state,
        now,
        existing.id,
      );
      return getCompetenceCandidate(existing.id);
    }
    // id 缺省由 pageRef 派生：同一页面不会被记两次（幂等键就是它自己）。
    const rowId = id ?? `comp_${now}_${Math.random().toString(36).slice(2, 10)}`;
    db.prepare(`
      INSERT INTO competence_candidates (id, fleet_id, member_id, page_ref, state, evidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(rowId, fleetId, memberId, pageRef, state ?? "candidate", JSON.stringify(evidence ?? {}), now, now);
    return getCompetenceCandidate(rowId);
  }

  function getCompetenceCandidate(id) {
    const row = db.prepare("SELECT * FROM competence_candidates WHERE id = ?").get(id);
    return row ? deserializeCompetence(row) : null;
  }

  function listCompetenceCandidates(fleetId, { memberId = null, state = null } = {}) {
    const where = ["fleet_id = ?"];
    const args = [fleetId];
    if (memberId) {
      where.push("member_id = ?");
      args.push(memberId);
    }
    if (state) {
      where.push("state = ?");
      args.push(state);
    }
    return db
      .prepare(`SELECT * FROM competence_candidates WHERE ${where.join(" AND ")} ORDER BY created_at DESC`)
      .all(...args)
      .map(deserializeCompetence);
  }

  /**
   * 标记一条候选「正在被质疑」（6.2）：**读面提示，不是写面拦截**。
   * 候选页照样可读，注入面在正文里标「谁在质疑、凭什么」——
   * 拦住写面只会让 agent 反复撞墙；写在读面它才会在决定前校准。
   */
  function disputeCompetenceCandidate(id, { by, basis }) {
    const row = db.prepare("SELECT * FROM competence_candidates WHERE id = ?").get(id);
    if (!row) return null;
    if (row.state === "active") {
      // 已生效的结论可以被质疑，但不会因此消失——状态标 disputed，读面照常召回。
      db.prepare("UPDATE competence_candidates SET state = 'disputed', disputed_by = ?, dispute_basis = ?, updated_at = ? WHERE id = ?").run(
        by ?? null,
        basis ?? null,
        Date.now(),
        id,
      );
    } else {
      db.prepare("UPDATE competence_candidates SET state = 'disputed', disputed_by = ?, dispute_basis = ?, updated_at = ? WHERE id = ?").run(
        by ?? null,
        basis ?? null,
        Date.now(),
        id,
      );
    }
    return getCompetenceCandidate(id);
  }

  /**
   * 候选生效（6.3）：**必须是显式动作且带验收者**。
   * 没有 acceptedBy 就拒绝——这是「非执行者验收」这条纪律的唯一落点。
   */
  function acceptCompetenceCandidate(id, { acceptedBy }) {
    if (!acceptedBy || !String(acceptedBy).trim()) {
      return { ok: false, error: "accepted_by_required" };
    }
    const row = db.prepare("SELECT * FROM competence_candidates WHERE id = ?").get(id);
    if (!row) return { ok: false, error: "not_found" };
    db.prepare("UPDATE competence_candidates SET state = 'active', accepted_by = ?, accepted_at = ?, updated_at = ? WHERE id = ?").run(
      String(acceptedBy).trim(),
      Date.now(),
      Date.now(),
      id,
    );
    return { ok: true, candidate: getCompetenceCandidate(id) };
  }

  // ── 角色状态（establish-agent-role-and-fitness-plane 5.1 / 5.2）─────────────
  //
  // 表在 1.1 就建了，但**没有任何读写入口**——这正是本仓反复踩的那一类
  // 「表建好了不等于在记录」。这里补上 CRUD，让「批准前角色零变化」这句话
  // 可被读出来验证，而不是靠人相信。
  //
  // upsert 而不是 insert：一个岗位一行（UNIQUE(fleet_id, member_id)），
  // 采纳/回滚是改这一行，不是加一行。

  function getRoleState(fleetId, memberId) {
    const row = db.prepare("SELECT * FROM role_states WHERE fleet_id = ? AND member_id = ?").get(fleetId, memberId);
    return row ? deserializeRoleState(row) : null;
  }

  function listRoleStates(fleetId) {
    return db
      .prepare("SELECT * FROM role_states WHERE fleet_id = ? ORDER BY member_id")
      .all(fleetId)
      .map(deserializeRoleState);
  }

  function upsertRoleState({ fleetId, memberId, genome, organs, status, statusBasis }) {
    const now = Date.now();
    const existing = db.prepare("SELECT id FROM role_states WHERE fleet_id = ? AND member_id = ?").get(fleetId, memberId);
    const genomePackId = genome?.packId ?? null;
    const genomeVersion = Number.isFinite(genome?.version) ? genome.version : null;
    if (existing) {
      db.prepare(`
        UPDATE role_states
           SET genome_pack_id = ?, genome_version = ?, genome_adopted_at = ?,
               organs = ?, status = ?, status_basis = ?, updated_at = ?
         WHERE id = ?
      `).run(
        genomePackId,
        genomeVersion,
        genome === undefined ? null : now,
        JSON.stringify(organs ?? {}),
        status ?? null,
        statusBasis ?? null,
        now,
        existing.id,
      );
    } else {
      db.prepare(`
        INSERT INTO role_states (id, fleet_id, member_id, genome_pack_id, genome_version, genome_adopted_at, organs, status, status_basis, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `role_${now}_${Math.random().toString(36).slice(2, 10)}`,
        fleetId,
        memberId,
        genomePackId,
        genomeVersion,
        genome === undefined ? null : now,
        JSON.stringify(organs ?? {}),
        status ?? null,
        statusBasis ?? null,
        now,
        now,
      );
    }
    return getRoleState(fleetId, memberId);
  }

  function deleteRoleState(fleetId, memberId) {
    const info = db.prepare("DELETE FROM role_states WHERE fleet_id = ? AND member_id = ?").run(fleetId, memberId);
    return { ok: true, deleted: info.changes };
  }

  // ── fitness runs（establish-agent-role-and-fitness-plane 1.1）──────────────
  //
  // 判定运行是 append-mostly：一行在开始时可只带输入，判完再写产出。
  // `verdict` 留在 NULL 表示**还没判完**——与 `inconclusive`（判完但判不出）
  // 必须可区分，否则「还在跑」会被读成「已判」。

  function appendFitnessRun(run) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO fitness_runs (id, fleet_id, pack_id, mode, window_start, window_end, budget, criteria, arms, readings, evidence, missing, verdict, judged_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.fleetId,
      run.packId ?? null,
      run.mode ?? "three-arm",
      run.windowStart,
      run.windowEnd,
      run.budget ? JSON.stringify(run.budget) : null,
      JSON.stringify(run.criteria ?? []),
      JSON.stringify(run.arms ?? []),
      JSON.stringify(run.readings ?? {}),
      JSON.stringify(run.evidence ?? {}),
      JSON.stringify(run.missing ?? []),
      run.verdict ?? null,
      run.judgedBy ?? null,
      now,
      now,
    );
    return getFitnessRun(run.id);
  }

  function getFitnessRun(id) {
    const row = db.prepare("SELECT * FROM fitness_runs WHERE id = ?").get(id);
    return row ? deserializeFitnessRun(row) : null;
  }

  function listFitnessRuns(fleetId, { limit = 20 } = {}) {
    return db
      .prepare("SELECT * FROM fitness_runs WHERE fleet_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(fleetId, limit)
      .map(deserializeFitnessRun);
  }

  // 写产出（读数/证据/缺失/裁决）。只更新这些列：输入是不可变的——判定输入一旦
  // 落库就不许改写，否则「同一输入重算得同一裁决」这条判据失去意义。
  function finishFitnessRun(id, { readings, evidence, missing, verdict, judgedBy }) {
    const row = db.prepare("SELECT * FROM fitness_runs WHERE id = ?").get(id);
    if (!row) return null;
    db.prepare(`
      UPDATE fitness_runs
         SET readings = ?, evidence = ?, missing = ?, verdict = ?, judged_by = ?, updated_at = ?
       WHERE id = ?
    `).run(
      JSON.stringify(readings ?? {}),
      JSON.stringify(evidence ?? JSON.parse(row.evidence || "{}")),
      JSON.stringify(missing ?? []),
      verdict ?? null,
      judgedBy ?? null,
      Date.now(),
      id,
    );
    return getFitnessRun(id);
  }

  // ── fleet credentials ─────────────────────────────────────────────────────
  // One row per (fleet, kind). The token never leaves the cell except through
  // `getFleetCredential`, which the patch assembler calls; every list surface
  // returns a tail fingerprint instead (fleet-scoped-bench-credentials D2).

  function setFleetCredential({ fleetId, kind, token }) {
    const exists = db.prepare("SELECT 1 AS ok FROM fleets WHERE id = ?").get(fleetId);
    if (!exists) return { ok: false, reason: "unknown_fleet" };
    if (!token) return { ok: false, reason: "empty_token" };
    const now = Date.now();
    db.prepare(`
      INSERT INTO fleet_credentials (id, fleet_id, kind, token, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(fleet_id, kind) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at
    `).run(`fc_${fleetId}_${kind}`, fleetId, kind, token, now, now);
    return { ok: true, row: getFleetCredential(fleetId, kind) };
  }

  function getFleetCredential(fleetId, kind) {
    const row = db.prepare("SELECT * FROM fleet_credentials WHERE fleet_id = ? AND kind = ?").get(fleetId, kind);
    if (!row) return null;
    // A row whose fleet is gone must read as absent, not as a credential: the
    // whole point of the same-file placement is that "row without fleet" can
    // never become an identity anyone acts on.
    const fleet = db.prepare("SELECT 1 AS ok FROM fleets WHERE id = ?").get(row.fleet_id);
    if (!fleet) return null;
    return {
      fleetId: row.fleet_id,
      kind: row.kind,
      token: row.token,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // List surface: fingerprint only (last 4), never the token. `kind` narrows
  // to one kind; the assembler's "exactly one holder" test reads this.
  function listFleetCredentials({ kind = null } = {}) {
    const rows = kind
      ? db.prepare(`SELECT c.* FROM fleet_credentials c JOIN fleets f ON f.id = c.fleet_id WHERE c.kind = ? ORDER BY c.fleet_id`).all(kind)
      : db.prepare(`SELECT c.* FROM fleet_credentials c JOIN fleets f ON f.id = c.fleet_id ORDER BY c.fleet_id`).all();
    return rows.map((row) => ({
      fleetId: row.fleet_id,
      kind: row.kind,
      tokenTail: String(row.token || "").slice(-4),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  // Orphan rows (credential without a fleet) are reported rather than hidden:
  // they are the ghost shape, and the gate needs to be able to point at them.
  function listOrphanFleetCredentials() {
    return db.prepare(`
      SELECT c.* FROM fleet_credentials c LEFT JOIN fleets f ON f.id = c.fleet_id
      WHERE f.id IS NULL ORDER BY c.fleet_id
    `).all().map((row) => ({
      fleetId: row.fleet_id,
      kind: row.kind,
      tokenTail: String(row.token || "").slice(-4),
      updatedAt: row.updated_at,
    }));
  }

  function deleteFleetCredential(fleetId, kind) {
    const info = db.prepare("DELETE FROM fleet_credentials WHERE fleet_id = ? AND kind = ?").run(fleetId, kind);
    return { ok: true, deleted: info.changes };
  }

  function close() {
    db.close();
  }

  return {
    db,
    createFleet,
    getFleet,
    updateFleet,
    listFleets,
    createMember,
    getMember,
    listMembers,
    listAuditorMembers,
    updateMember,
    deleteMember,
    findPostByTarget,
    appendReport,
    getReport,
    latestReports,
    latestReportFor,
    previousReport,
    listReports,
    countReportsSince,
    appendTurnEvent,
    hasInterruptedTurnNear,
    getTurnEvent,
    listTurnEvents,
    listFleetTurnEvents,
    latestTurnContextByFleet,
    latestTurnFor,
    latestRealTurnFor,
    skippedCount,
    consecutiveFailures,
    failureStreak,
    budgetPressure,
    insertRun,
    getRun,
    reopenRun,
    finalizeRun,
    stopRun,
    runUsage,
    runCosts,
    runCost,
    listRuns,
    listRunTurns,
    edgeTraffic,
    fingerprintGroups,
    spendProjection,
    getFleetByConsoleSlug,
    pruneRuns,
    reclaimOrphanRuns,
    listOpenRuns,
    appendDecision,
    getDecision,
    listDecisions,
    countOpenDecisions,
    countDecisionsByMemberSince,
    appendIteration,
    getIteration,
    listIterations,
    transitionIteration,
    upsertDigestSub,
    listDigestSubscriptions,
    removeDigestSub,
    touchDigestRun,
    transitionDecision,
    findFleetByTemplate,
    expireOpenDecisions,
    markDelivered,
    recordEscalation,
    countEscalationsByMemberSince,
    findSimilarOpenDecision,
    mergeDecisionEscalation,
    setDecisionRoute,
    recordDecisionExecution,
    countOwnerOpenDecisions,
    countDeputyOpenDecisions,
    getCellSetting,
    setCellSetting,
    getCellKnowledgeProfile,
    setCellKnowledgeProfile,
    getFleetKnowledgeProfileRaw,
    setFleetKnowledgeProfile,
    getFleetDelegationPolicyRaw,
    setFleetDelegationPolicy,
    getFleetDelegationPolicy,
    getFleetMandatePolicy,
    setFleetMandatePolicy,
    listCitablePrecedents,
    listOverruledDecisions,
    outboundLevelSamples,
    listPrecedentCandidates,
    getPrecedentCandidate,
    proposePrecedentCandidate,
    decidePrecedentCandidate,
    listApprovedPrecedentRules,
    listPrecedentRejections,
    decisionConsistency,
    getCellMandatePolicy,
    setCellMandatePolicy,
    recordMandateViolation,
    getMandateViolations,
    getPersonalDomainMap,
    setPersonalDomainMap,
    routeForItem,
    setFleetCredential,
    getFleetCredential,
    listFleetCredentials,
    listOrphanFleetCredentials,
    deleteFleetCredential,
    appendFitnessRun,
    getFitnessRun,
    listFitnessRuns,
    finishFitnessRun,
    upsertCompetenceCandidate,
    getCompetenceCandidate,
    listCompetenceCandidates,
    disputeCompetenceCandidate,
    acceptCompetenceCandidate,
    getRoleState,
    listRoleStates,
    upsertRoleState,
    deleteRoleState,
    close,
  };
}

// 胜任力候选的行 → API 形状。`state` 三值：candidate / active / disputed。
function deserializeCompetence(row) {
  return {
    id: row.id,
    fleetId: row.fleet_id,
    memberId: row.member_id,
    pageRef: row.page_ref,
    state: row.state,
    disputedBy: row.disputed_by ?? null,
    disputeBasis: row.dispute_basis ?? null,
    evidence: JSON.parse(row.evidence || "{}"),
    acceptedBy: row.accepted_by ?? null,
    acceptedAt: row.accepted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 角色状态的行 → API 形状。`organs` 是 JSON；未设置时返回 {}（不是 null），
// 使「没有任何器官声明」与「声明为空对象」在调用方看来一致——真正的口径差异
// 由 `validateOrgans` 的 gaps 表达，不靠这里的 null/{}。
function deserializeRoleState(row) {
  return {
    id: row.id,
    fleetId: row.fleet_id,
    memberId: row.member_id,
    genome: row.genome_pack_id
      ? { packId: row.genome_pack_id, version: row.genome_version ?? null }
      : null,
    genomeAdoptedAt: row.genome_adopted_at ?? null,
    organs: JSON.parse(row.organs || "{}"),
    status: row.status ?? null,
    statusBasis: row.status_basis ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 判定运行的行 → API 形状。`verdict: null` 与 `verdict: "inconclusive"` 的区分
// 在这里保留：调用方靠它判断「还在跑」还是「判不出」。
function deserializeFitnessRun(row) {
  return {
    id: row.id,
    fleetId: row.fleet_id,
    packId: row.pack_id ?? null,
    mode: row.mode,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    budget: row.budget ? JSON.parse(row.budget) : null,
    criteria: JSON.parse(row.criteria || "[]"),
    arms: JSON.parse(row.arms || "[]"),
    readings: JSON.parse(row.readings || "{}"),
    evidence: JSON.parse(row.evidence || "{}"),
    missing: JSON.parse(row.missing || "[]"),
    verdict: row.verdict ?? null,
    judgedBy: row.judged_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deserializeFleet(row) {
  return {
    id: row.id,
    name: row.name,
    ownerEmail: row.owner_email,
    state: row.state,
    decisionPolicy: decisionPolicyOfRow(row),
    delegationPolicy: row.delegation_policy ? JSON.parse(row.delegation_policy) : null,
    sourceTemplate: row.source_template ? JSON.parse(row.source_template) : null,
    defaultModel: row.default_model ?? null,
    effort: row.effort ?? null,
    contextBudget: row.context_budget ?? null,
    inputPolicy: row.input_policy ? JSON.parse(row.input_policy) : null,
    orchestration: row.orchestration ? JSON.parse(row.orchestration) : null,
    // Unpublished console = both null. A share request for a fleet without a
    // slug answers 404, so this pair IS the publication switch.
    consoleSlug: row.console_slug ?? null,
    consolePublishedAt: row.console_published_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// The fleet-level decision policy: default 72h expiry, 10 escalations per
// post per day. `0` expiryHours disables expiry outright.
export const DEFAULT_DECISION_POLICY = { expiryHours: 72, dailyCapPerMember: 10 };

// ── 委托策略 (add-deputy-decision-delegate, design D/D3) ─────────────────────
//
// routes 的值: 'owner' | 'deputy' | 'deputy-triage'。
//   deputy         — 常务岗可独立裁决（approve/reject）
//   deputy-triage  — 常务岗只做归并/跟踪/上报，不算裁决（问题单类）
//   owner          — 永远主人
//
// ── 高影响类别：默认锁死，可由使用者解锁 (agent-decided-learning-loop 5.4) ──
//
// 旧写法把 config-change / hr / spend 硬编码为 owner，并在归一化里**覆盖**任何
// 写入——注释原文是「one UPDATE must never be able to unlock a destructive or
// publish action」。那条规则保护的是「一次误写/一次带外改数据不该悄悄放开高影响
// 动作」，但它的实现顺手把**使用者本人**也挡在外面：代理能替主人决定什么，是
// 用软件的人的事，不是我们的。
//
// 现在的形状把这两件事分开：
//   · 默认值不变（三类仍是 owner）——误配不会放开任何东西；
//   · 放开需要另一个显式字段 `unlocked`（逐类列出），写 route 而不写 unlocked
//     不生效。这条让「旧配置静默变宽」不可能发生，同一个语义有两个独立动作。
//   · 解锁的类别在裁决时必须带撤销窗（revokeWindowMinutes），否则拒绝解锁：
//     不可回退的动作没有撤销窗，等于把「先做后报」变成「做错了没得救」。
//   · 写入口只认真人——内部桥接身份（agent 自己）不得改这条策略。
export const DELEGATION_CATEGORIES = ["routine-ops", "infra-ticket", "config-change", "hr", "spend"];
/** 默认锁定、需使用者逐类解锁的高影响类别。 */
export const LOCKED_BY_DEFAULT_CATEGORIES = ["config-change", "hr", "spend"];
const DELEGATION_ROUTES = ["owner", "deputy", "deputy-triage"];
export const SEVERITY_RANK = { low: 0, normal: 1, high: 2 };
/** 解锁高影响类别时的撤销窗边界（分钟）。0 = 不允许解锁。 */
export const REVOKE_WINDOW_MIN = 1;
export const REVOKE_WINDOW_MAX = 7 * 24 * 60;

export const DEFAULT_DELEGATION_POLICY = {
  enabled: false,
  routes: { "routine-ops": "deputy", "infra-ticket": "deputy-triage", default: "owner" },
  maxSeverity: "normal",
  dailyBudget: 20,
  model: null,
  digest: "daily",
  deputyMemberId: null,
  // 使用者显式解锁的高影响类别（空 = 全部锁定）。
  unlocked: [],
  // 解锁类别上裁决后保留的撤销窗（分钟）。非 null 才允许解锁。
  revokeWindowMinutes: null,
};

function normalizeUnlocked(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((c) => LOCKED_BY_DEFAULT_CATEGORIES.includes(c)))];
}

function normalizeRoutes(routes, unlocked = []) {
  const out = {};
  const open = new Set(unlocked);
  if (routes && typeof routes === "object") {
    for (const [k, v] of Object.entries(routes)) {
      if (!DELEGATION_ROUTES.includes(v)) continue;
      if (k === "default") out.default = v;
      else if (DELEGATION_CATEGORIES.includes(k)) {
        // Locked categories accept a delegate route ONLY when the same policy
        // names them in `unlocked`; otherwise they are forced back to owner.
        out[k] = LOCKED_BY_DEFAULT_CATEGORIES.includes(k) && !open.has(k) ? "owner" : v;
      }
    }
  }
  // Locked-and-not-unlocked categories are pinned to owner even if absent above.
  for (const k of LOCKED_BY_DEFAULT_CATEGORIES) {
    if (!open.has(k)) out[k] = "owner";
  }
  if (!out.default) out.default = "owner";
  return out;
}

// cell 级默认 + 舰队覆写：浅合并（覆写同键生效，routes 整体替换后归一化）。
export function normalizeDelegationPolicy(cellPolicy, fleetOverride) {
  const base = {
    ...DEFAULT_DELEGATION_POLICY,
    routes: { ...DEFAULT_DELEGATION_POLICY.routes },
    ...(cellPolicy && typeof cellPolicy === "object" ? cellPolicy : {}),
  };
  base.routes = normalizeRoutes(base.routes, base.unlocked);
  base.unlocked = normalizeUnlocked(base.unlocked);
  base.revokeWindowMinutes = Number.isFinite(base.revokeWindowMinutes) && base.revokeWindowMinutes >= REVOKE_WINDOW_MIN
    ? Math.floor(base.revokeWindowMinutes)
    : null;
  base.maxSeverity = SEVERITY_RANK[base.maxSeverity] !== undefined ? base.maxSeverity : DEFAULT_DELEGATION_POLICY.maxSeverity;
  base.dailyBudget = Number.isFinite(base.dailyBudget) && base.dailyBudget > 0 ? Math.floor(base.dailyBudget) : DEFAULT_DELEGATION_POLICY.dailyBudget;
  base.digest = ["daily", "weekly", "off"].includes(base.digest) ? base.digest : DEFAULT_DELEGATION_POLICY.digest;
  base.deputyMemberId = typeof base.deputyMemberId === "string" && base.deputyMemberId ? base.deputyMemberId : null;
  if (!fleetOverride || typeof fleetOverride !== "object") return base;
  const merged = { ...base };
  if (fleetOverride.enabled !== undefined) merged.enabled = !!fleetOverride.enabled;
  // `unlocked` merges on its OWN key, not only inside the routes branch: a
  // fleet may open/close the locked set without also rewriting every route,
  // and a window may be set without touching either.
  if (fleetOverride.unlocked !== undefined) merged.unlocked = normalizeUnlocked(fleetOverride.unlocked);
  if (fleetOverride.routes && typeof fleetOverride.routes === "object") {
    merged.routes = normalizeRoutes({ ...base.routes, ...fleetOverride.routes }, merged.unlocked ?? []);
  } else if (fleetOverride.unlocked !== undefined) {
    // Routes inherited from base but the lock set changed ⇒ re-normalize, or a
    // category unlocked here would still be pinned to owner by base's routes.
    merged.routes = normalizeRoutes({ ...base.routes }, merged.unlocked);
  }
  if (Number.isFinite(fleetOverride.revokeWindowMinutes) && fleetOverride.revokeWindowMinutes >= REVOKE_WINDOW_MIN) {
    merged.revokeWindowMinutes = Math.floor(fleetOverride.revokeWindowMinutes);
  } else if (fleetOverride.revokeWindowMinutes === null) {
    merged.revokeWindowMinutes = null;
  }
  if (fleetOverride.maxSeverity && SEVERITY_RANK[fleetOverride.maxSeverity] !== undefined) merged.maxSeverity = fleetOverride.maxSeverity;
  if (Number.isFinite(fleetOverride.dailyBudget) && fleetOverride.dailyBudget > 0) merged.dailyBudget = Math.floor(fleetOverride.dailyBudget);
  if (fleetOverride.model !== undefined) merged.model = typeof fleetOverride.model === "string" && fleetOverride.model ? fleetOverride.model : null;
  if (fleetOverride.digest && ["daily", "weekly", "off"].includes(fleetOverride.digest)) merged.digest = fleetOverride.digest;
  if (fleetOverride.deputyMemberId !== undefined) {
    merged.deputyMemberId = typeof fleetOverride.deputyMemberId === "string" && fleetOverride.deputyMemberId ? fleetOverride.deputyMemberId : null;
  }
  return merged;
}

// 拍板项按策略计算路由 (design D2/D3)。escalate 落库前调用——同步、可解释。
// 顺序: 委托未启用（硬闸） → 硬闸类别 → item_type=config-change → severity 上限
//       → 类别映射 → default。
//
// 委托未启用时一律 owner（fix-mandate-write-preserves-deputy）：DEFAULT_DELEGATION_POLICY
// 是 `enabled:false` **配** `routes.routine-ops='deputy'`，本函数原先不看 `enabled`——于是
// 未启用委托的舰队（新建舰队就是这个默认）只要升级一条 routine-ops 就落 `route=deputy`，
// 而 deputyGuard 因为没有启用委托、没有常务岗，任何人来裁都 403，这条**永久没人能裁**。
// 早先加不了这一行：v2 委托状写入会把 `enabled` 丢掉，两条读路径对该字段分叉；
// `legacyFieldsFromOps` + `preserveUnmentionedLegacy` 修好无损往返之后，「派给谁」与
// 「谁能裁」才真正同源。实测（2026-11-13）：线上 18 条 deputy 路由全属已启用舰队、零死项。
export function routeForItem({ category = null, itemType = null, severity = "normal" }, policy) {
  if (!policy?.enabled) return "owner";
  const cat = category || (itemType === "config-change" ? "config-change" : null);
  if (cat && LOCKED_BY_DEFAULT_CATEGORIES.includes(cat) && !(policy.unlocked ?? []).includes(cat)) return "owner";
  if ((SEVERITY_RANK[severity] ?? 1) > (SEVERITY_RANK[policy.maxSeverity] ?? 1)) return "owner";
  if (cat && policy.routes[cat]) return policy.routes[cat];
  return policy.routes.default || "owner";
}

// 问题归一化（去重辅助）：空白折叠 + 去尾标点。语义相似度（embedding）留 v2。
export function normalizeQuestion(question) {
  if (typeof question !== "string") return null;
  const norm = question.replace(/\s+/g, " ").trim().replace(/[。.!?！？]+$/, "");
  return norm.length >= 8 ? norm : null;
}

// ── Mandate policy (add-personal-mandate 2.1/2.2) ───────────────────────────
//
// One blob, two readers. The deputy path keeps reading the flat top-level keys
// (routes/maxSeverity/dailyBudget/...) via normalizeDelegationPolicy — it is
// untouched by design, because that is the equivalence that makes the upgrade a
// no-op. The mandate reader takes the same blob, uses the `domains` key when it
// is there, and otherwise derives `ops` from the flat fields.
//
// `ops` mode stays conservative ("draft" when delegation is enabled, else
// "advise"): the deputy's autonomy is expressed by the flat delegation fields,
// and MUST NOT be re-expressed as an action mandate — otherwise enabling
// delegation would silently grant autonomous action execution.

const OPS_LEGACY_KEYS = [
  "enabled",
  "routes",
  "maxSeverity",
  "dailyBudget",
  "model",
  "digest",
  "deputyMemberId",
];

export function opsModeForEnabled(enabled) {
  return enabled === false ? "advise" : "draft";
}

// The flat view of an ops block, for mirroring onto the blob's top level so old
// readers keep working after a v2 write.
//
// `mode → enabled` 的反向映射（fix-mandate-write-preserves-deputy）：`legacyOpsBlock()`
// 把启用状态编码成 `mode`（`enabled===false → advise`，否则 `draft`），ops 块里**没有**
// `enabled` 键，所以按同名逐字取的循环永远拿不到它——写回的 blob 顶层缺 `enabled`，
// 旧读者 `normalizeDelegationPolicy` 落回 DEFAULT（enabled:false、deputyMemberId:null、
// routes 回默认）。后果不是丢个标志：`deputyGuard` 读的就是这个扁平视图，
// **每一次 v2 委托状写入都会把已启用的委托裁决整条关掉**，而症状是「常务岗从不裁决」，
// 与「模型不干活」不可区分。正向有 `opsModeForEnabled`，反向必须补齐，否则这条镜像不是往返。
export function enabledForOpsMode(mode) {
  return mode === "advise" ? false : true;
}

/**
 * 无损往返的最后一道（fix-mandate-write-preserves-deputy）。
 *
 * v2 写入是**整体替换** blob，但委托状只表达「每个域能自主到哪一步」——它**表达不了**
 * 「谁来裁」：`deputyMemberId` 是扁平层的字段，ops 域块里没有对应位置。于是每写一次
 * 委托状，常务岗标识就被抹成 null，`deputyGuard` 随之对所有人 403，那支舰队的委托裁决
 * **静默全废**（2026-11-13 复现：改一次域 → enabled 与 deputyMemberId 一起没了）。
 *
 * 因此这里只补一个字段，不做通用合并：`routes` / `maxSeverity` / `dailyBudget` 等
 * 委托状**能**表达的东西不在此列——「没提到」按既有契约就是取默认值，cell 级写入更是
 * 整体替换语义（scripts/test-personal-mandate-policy.mjs 2.3 钉着这一条）。
 * `enabled` 也不在此列：它由 `mode` 反向推导（见 legacyFieldsFromOps）。
 */
export function preserveUnmentionedLegacy(blob, prevBlob) {
  if (!blob || !prevBlob || typeof prevBlob !== "object") return blob;
  if (blob.deputyMemberId === undefined && prevBlob.deputyMemberId !== undefined) {
    blob.deputyMemberId = prevBlob.deputyMemberId;
  }
  return blob;
}

export function legacyFieldsFromOps(opsBlock) {
  const out = {};
  for (const key of OPS_LEGACY_KEYS) {
    if (opsBlock && opsBlock[key] !== undefined) out[key] = opsBlock[key];
  }
  if (opsBlock && opsBlock.mode !== undefined) {
    const derived = enabledForOpsMode(opsBlock.mode);
    // 显式 `enabled` 字段优先（历史 blob 两种形态都可能有）；缺失才用模式推。
    if (out.enabled === undefined) out.enabled = derived;
  }
  return out;
}

/**
 * Stored blob → effective mandate policy (v2).
 * Legacy equivalence is inherited from normalizeDelegationPolicy, which is the
 * same function the deputy gate calls: one source, no parallel reimplementation.
 */
export function delegationToMandate(cellRaw, fleetRaw) {
  const ops = normalizeDelegationPolicy(cellRaw, fleetRaw);
  const opsBlock = { ...legacyFieldsFromOps(ops), mode: opsModeForEnabled(ops.enabled) };

  const cellNorm = normalizeMandatePolicy(cellRaw);
  const cellDomains = cellNorm.ok ? cellNorm.policy.domains : {};
  // Explicit ops fields (limits/scopes/action rules) from the stored blob win,
  // but the legacy-derived mode/fields above are the floor.
  const baseDomains = { ...cellDomains, ops: { ...opsBlock, ...(cellDomains.ops ?? {}) } };

  const fleetNorm = normalizeMandatePolicy(fleetRaw);
  const fleetDomains = fleetNorm.ok ? fleetNorm.policy.domains : {};

  return mergeMandatePolicies({ version: 2, domains: baseDomains }, { version: 2, domains: fleetDomains });
}

/**
 * Effective mandate (v2) → the blob to persist. Mirrors the ops legacy fields on
 * the top level so `normalizeDelegationPolicy` keeps producing identical results
 * after the first v2 write (migration period double-write, design D9).
 *
 * IMPORTANT: pass the RAW declaration, never `delegationToMandate(...)`. The
 * latter bakes defaults into every absent key; writing those back would turn a
 * cell-level "replace the routes object" into a fleet-level "merge", and a key
 * the operator never mentioned would be resurrected from DEFAULT. The
 * equivalence test (scripts/test-personal-mandate-policy.mjs 2.3) pins this.
 */
export function mandateToBlob(policy) {
  const normalized = normalizeMandatePolicy(policy);
  if (!normalized.ok) return null;
  const domains = normalized.policy.domains;
  const legacy = legacyFieldsFromOps(domains.ops);
  return { ...legacy, version: 2, domains };
}

function decisionPolicyOfRow(row) {
  let parsed = null;
  if (typeof row.decision_policy === "string" && row.decision_policy) {
    try {
      parsed = JSON.parse(row.decision_policy);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_DECISION_POLICY };
  return {
    expiryHours:
      Number.isFinite(parsed.expiryHours) && parsed.expiryHours >= 0 ? parsed.expiryHours : DEFAULT_DECISION_POLICY.expiryHours,
    dailyCapPerMember:
      Number.isFinite(parsed.dailyCapPerMember) && parsed.dailyCapPerMember > 0
        ? parsed.dailyCapPerMember
        : DEFAULT_DECISION_POLICY.dailyCapPerMember,
  };
}

function keyIsDecisionPolicy(updates) {
  return Object.hasOwn(updates, "decisionPolicy");
}

function deserializeMember(row) {
  return {
    id: row.id,
    fleetId: row.fleet_id,
    title: row.title,
    parentId: row.parent_id ?? null,
    targetKind: row.target_kind,
    targetId: row.target_id,
    kpiSlots: JSON.parse(row.kpi_slots || "[]"),
    cadence: row.cadence ? JSON.parse(row.cadence) : null,
    model: row.model ?? null,
    fallbackModel: row.fallback_model ?? null,
    effort: row.effort ?? null,
    contextBudget: row.context_budget ?? null,
    carrier: row.carrier ?? null,
    packId: row.pack_id ?? null,
    inputPolicy: row.input_policy ? JSON.parse(row.input_policy) : null,
    sortKey: row.sort_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deserializeReport(row) {
  return {
    id: row.id,
    fleetId: row.fleet_id,
    memberId: row.member_id,
    sessionId: row.session_id ?? null,
    metrics: JSON.parse(row.metrics || "{}"),
    resources: JSON.parse(row.resources || "[]"),
    blockers: JSON.parse(row.blockers || "[]"),
    summary: row.summary,
    source: row.source || "self",
    createdAt: row.created_at,
  };
}

// Token counts land as integers or not at all: a provider that reports no
// usage leaves NULL, never a guessed zero (spec: 用量缺失不虚构).
function usageInt(v) {
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
}

// The four-component USD estimate carried on a turn row (nullable per row).
// Null when the turn was never priced — callers must not read null as 0.
function costOf(row) {
  const parts = [row.cost_input_usd, row.cost_output_usd, row.cost_cache_write_usd, row.cost_cache_read_usd];
  if (parts.every((v) => v == null)) return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return {
    inputUsd: n(row.cost_input_usd),
    outputUsd: n(row.cost_output_usd),
    cacheWriteUsd: n(row.cost_cache_write_usd),
    cacheReadUsd: n(row.cost_cache_read_usd),
    totalUsd:
      n(row.cost_input_usd) + n(row.cost_output_usd) + n(row.cost_cache_write_usd) + n(row.cost_cache_read_usd),
    pricingAt: row.pricing_at ?? null,
  };
}

function usageOf(row) {
  if (row.usage_input == null && row.usage_output == null) return null;
  return { input: row.usage_input ?? null, output: row.usage_output ?? null };
}

function deserializeTurnEvent(row) {
  return {
    id: row.id,
    fleetId: row.fleet_id,
    memberId: row.member_id,
    source: row.source,
    status: row.status,
    errorKind: row.error_kind ?? null,
    error: row.error ?? null,
    model: row.model ?? null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    sessionId: row.session_id ?? null,
    turnId: row.turn_id ?? null,
    runId: row.run_id ?? null,
    parentTurnId: row.parent_turn_id ?? null,
    edgeKind: row.edge_kind ?? null,
    usage: usageOf(row),
    traceTurnId: row.trace_turn_id ?? null,
    detail: parseDetail(row.detail),
    // runtime-fingerprint 3.3: the attempt's configuration identity, or null
    // when none was computed. The version-comparison read face groups on this.
    runtimeFingerprint: row.runtime_fingerprint ?? null,
    // Turn metering (add-turn-metering): read-face for the API/cockpit —
    // honest absence stays null.
    presetId: row.preset_id ?? null,
    presetSource: row.preset_source ?? null,
    provider: row.provider ?? null,
    effort: row.effort ?? null,
    carrier: row.carrier ?? null,
    carrierInstance: row.carrier_instance ?? null,
    laneId: row.lane_id ?? null,
    depth: row.depth ?? null,
    wave: row.wave ?? null,
    metering: {
      queueWaitMs: row.queue_wait_ms ?? null,
      spinUpMs: row.spin_up_ms ?? null,
      ttftMs: row.ttft_ms ?? null,
      cachedInput: row.usage_cached_input ?? null,
      cacheWrite: row.usage_cache_write ?? null,
      reasoning: row.usage_reasoning ?? null,
    },
    // Turn pricing (add-turn-pricing + add-fleet-cost-read-face): the version
    // stamp, and the four estimate components as they were computed AT TURN
    // TIME. `cost` is null for an unpriced turn (never a fabricated zero), and
    // it is an ESTIMATE — the daily row is the long-range truth, this is the
    // per-turn attribution that makes run/edge slices possible.
    pricingAt: row.pricing_at ?? null,
    cost: costOf(row),
  };
}

// fix-fleet-failure-visibility-era rows predate the detail column; a corrupt
// payload reads as honest absence rather than throwing into every reader.
function parseDetail(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function deserializeRun(row) {
  return {
    runId: row.run_id,
    fleetId: row.fleet_id,
    rootSource: row.root_source,
    rootMemberId: row.root_member_id,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    status: row.status,
    turns: row.turns ?? 0,
    okCount: row.ok_count ?? 0,
    failedCount: row.failed_count ?? 0,
    usage: usageOf(row),
    stoppedAt: row.stopped_at ?? null,
    stopReason: row.stop_reason ?? null,
  };
}

function deserializePrecedentCandidate(row) {
  if (!row) return null;
  return {
    id: row.id,
    fleetId: row.fleet_id,
    domain: row.domain ?? null,
    ruleText: row.rule_text,
    ruleKey: row.rule_key,
    sourceDecisionId: row.source_decision_id ?? null,
    status: row.status,
    proposedAt: row.proposed_at,
    decidedAt: row.decided_at ?? null,
    decidedBy: row.decided_by ?? null,
    rejectReason: row.reject_reason ?? null,
  };
}

function deserializeDecision(row) {
  return {
    id: row.id,
    fleetId: row.fleet_id,
    memberId: row.member_id,
    question: row.question,
    options: JSON.parse(row.options || "[]"),
    severity: row.severity || "normal",
    suggestedDeadline: row.suggested_deadline ?? null,
    // 2026-11-09 实测确认并修正：此前读的是 `row.resolution`——推荐值写进了
    // recommendation 列却从不读回，于是每条未决事项的「推荐」在 UI 上永远是
    // null（那行代码一直存在但永远拿不到值），已决事项则把 resolution 的 JSON
    // 串当成推荐值打印出来。字段名与列名一致，没有别的解释空间。
    recommendation: row.recommendation ?? null,
    state: row.state || "open",
    resolution: row.resolution ? JSON.parse(row.resolution) : null,
    sourceSessionId: row.source_session_id ?? null,
    submittedAt: row.submitted_at,
    resolvedAt: row.resolved_at ?? null,
    deliveredAt: row.delivered_at ?? null,
    deliveredSessionId: row.delivered_session_id ?? null,
    // 迭代回路扩展 (fleet-owner-iteration)：旧行无列值 ⇒ 'decision'/无附件，
    // 与既有语义零差异。
    itemType: row.item_type ?? "decision",
    detail: parseDetail(row.detail),
    // 委托扩展 (add-deputy-decision-delegate)：旧行 route='owner'、无裁决者
    // 身份——与未启用委托前语义一致。
    route: row.route || "owner",
    category: row.category ?? null,
    topicKey: row.topic_key ?? null,
    resolvedBy: row.resolved_by ?? null,
    resolvedByModel: row.resolved_by_model ?? null,
    // 个人事务域扩展 (widen-deputy-to-personal-domains)。旧行为 null：
    // domain=null 即既有舰队内部车道，判例等级=null 视为不可引用。
    domain: row.domain ?? null,
    // 读面规范化（agent-decided-learning-loop D4）：历史 `deputy-ruled` 行没有
    // 独立信息，诚实读法是 agent-self。不写迁移——事后为旧行编一个产生路径，
    // 等于用今天猜的理由改写历史。
    precedentGrade: row.precedent_grade ?? null,
    precedentGradeNormalized: normalizeLegacyGrade(row.precedent_grade ?? null),
    auditorVerdict: row.auditor_verdict ?? null,
    auditorNote: row.auditor_note ?? null,
    rulingEvidence: row.ruling_evidence ?? null,
    escalations: row.escalations ?? 0,
    lastEscalatedAt: row.last_escalated_at ?? null,
    executedAt: row.executed_at ?? null,
    executedSessionId: row.executed_session_id ?? null,
    // 撤销窗 (agent-decided-learning-loop 5.4)：revocableUntil = 生效时可撤销的
    // 截止时刻（null = 不可撤销）；revokedAt 非空 = 已被撤销，原裁决记录不改写。
    revocableUntil: row.revocable_until ?? null,
    revokedAt: row.revoked_at ?? null,
  };
}

// Iteration chain rows (fleet-owner-iteration): 链状态机的持久化投影。
function deserializeIteration(row) {
  return {
    id: row.id,
    fleetId: row.fleet_id,
    packId: row.pack_id,
    decisionId: row.decision_id ?? null,
    state: row.state,
    axis: row.axis ?? null,
    note: row.note || null,
    notes: row.notes ?? null,
    publishedVersion: row.published_version ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deserializeDigestSub(row) {
  return {
    id: row.id,
    fleetId: row.fleet_id,
    ownerEmail: row.owner_email,
    cadence: row.cadence,
    lastRunAt: row.last_run_at ?? null,
    lastSentAt: row.last_sent_at ?? null,
    createdAt: row.created_at,
  };
}

// Export singleton (server.js uses the default per-cell file; tests inject).
let fleetDb = null;

export function getFleetDatabase() {
  if (!fleetDb) {
    fleetDb = createFleetDatabase({});
  }
  return fleetDb;
}

export function setFleetDatabase(db) {
  fleetDb = db;
}
