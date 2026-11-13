// 从各线的 `line-manifest.json` 读出"这条线走哪几扇门"（5.3）。
//
// 为什么要这一层：4.2 的门分组先前靠 `credential-doors.js` 里一张手写表，
// 那张表在新增一条线时必须有人记得回来改——这正是本 change 要消掉的东西。
// 5.3 的判据是「新增一条线只需改 manifest，平台侧 grep 不到新的硬编码 ref 名」，
// 所以归类必须来自各线自己的声明。
//
// 字段形状以**真实 manifest** 为准（不按设计稿猜）：
//   auth_tracks: [
//     {kind:"line-native",  name:"lex-pat",  accepts:"line-native-key", fallback:true},
//     {kind:"customer-key", accepts:"ciyuan-sk", fallback:false,
//      enforced:false, migration_task:"converge-line-identity-and-keys#8.2"},
//   ]
//   identity.jit_policy: "off" | "first-use" | "consent"
//
// 两条纪律：
//  1. **声明 ≠ 生效**。`enforced:false` 的轨只算"已声明、未生效"，不许当可用。
//  2. **读不到 ≠ 没有**。缺文件/坏 JSON 的线进 `unreadable`，不静默当作"没有门"。

import fs from "node:fs";
import path from "node:path";

//: `auth_tracks[].kind` → 门。未知 kind 不归类（进 unknownKinds，被看见）。
const DOOR_BY_KIND = {
  "customer-key": "customer-key",
  "line-native": "third-party",
  "member-assertion": "member-assertion",
};

export const SIDECAR_NAME = "line-manifest.json";

function isEnforced(track) {
  return track?.enforced !== false;
}

//: 单份 manifest → 该线的门声明。只做映射，不判断连通性（那要看凭据）。
export function doorsForManifest(doc) {
  const line = typeof doc?.line === "string" ? doc.line : null;
  if (!line) return null;

  const tracks = Array.isArray(doc.auth_tracks) ? doc.auth_tracks : [];
  const customerKey = [];
  const ownTracks = [];
  const memberTracks = [];
  const unknownKinds = [];

  for (const track of tracks) {
    const kind = typeof track?.kind === "string" ? track.kind : null;
    const door = kind ? DOOR_BY_KIND[kind] : null;
    if (!door) {
      if (kind) unknownKinds.push(kind);
      continue;
    }
    const row = {
      name: typeof track.name === "string" ? track.name : null,
      accepts: typeof track.accepts === "string" ? track.accepts : null,
      fallback: track?.fallback === true,
      enforced: isEnforced(track),
      migrationTask: typeof track.migration_task === "string" ? track.migration_task : null,
    };
    if (door === "customer-key") customerKey.push(row);
    else if (door === "third-party") ownTracks.push(row);
    else memberTracks.push(row);
  }

  // 门 A 的口径由身份块表态：jit_policy 非 off 才算这条线接受平台代做。
  const jitPolicy = typeof doc.identity?.jit_policy === "string" ? doc.identity.jit_policy : "off";
  const assertionDeclared = jitPolicy !== "off" || memberTracks.length > 0;

  return {
    line,
    publicBaseUrl: typeof doc.public_base_url === "string" ? doc.public_base_url : null,
    customerKey,
    ownTracks,
    assertion: assertionDeclared
      ? { jitPolicy, tracks: memberTracks, enforced: memberTracks.some(isEnforced) }
      : null,
    // 这条线是否"能被单独消费而不绑平台"：有 fallback 且 enforced 的轨即可。
    standalone: customerKey.concat(ownTracks).some((t) => t.fallback && t.enforced),
    unknownKinds,
  };
}

//: 扫一个目录下的 `*/line-manifest.json`。返回 {lines, unreadable}——坏文件
//: 进 unreadable 而不是被跳过，否则"某条线消失了"会被读成"它没有门"。
export function loadManifests(rootDir, fsImpl = fs) {
  const lines = new Map();
  const unreadable = [];
  if (!rootDir) return { lines, unreadable };
  let entries = [];
  try {
    entries = fsImpl.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    // 目录不存在 = 还没人投放 manifest。这是"空"，不是"读失败"。
    return { lines, unreadable };
  }
  for (const entry of entries) {
    // 符号链接目录也要认：ConfigMap 挂载出来的就是 `..data/` 符号链接，
    // 只认 isDirectory() 会让"部署了却读不到"看起来像"没部署"。
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = fsImpl.statSync(path.join(rootDir, entry.name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    const file = path.join(rootDir, entry.name, SIDECAR_NAME);
    try {
      const doc = JSON.parse(fsImpl.readFileSync(file, "utf8"));
      const resolved = doorsForManifest(doc);
      if (resolved) lines.set(resolved.line, resolved);
      else unreadable.push({ dir: entry.name, reason: "no line field" });
    } catch {
      // 该目录没有 manifest 是常态（每个仓只有根上一个），不算读失败；
      // 文件在手但解析不了才算。
      if (fsImpl.existsSync(file)) unreadable.push({ dir: entry.name, reason: "unreadable" });
    }
  }
  return { lines, unreadable };
}

//: 把多份 manifest 归成"哪扇门有哪些线"。这是 4.2 分组里"线"的那一半。
export function groupLinesByDoor(lines = new Map()) {
  const customerKey = [];
  const ownTracks = [];
  const memberAssertion = [];
  const notStandalone = [];
  for (const info of lines.values()) {
    if (info.customerKey.length) {
      customerKey.push({
        line: info.line,
        tracks: info.customerKey,
        // 只有 enforced 的轨才算"现在真能用这把钥"。
        effective: info.customerKey.some((t) => t.enforced),
      });
    }
    if (info.ownTracks.length) {
      ownTracks.push({ line: info.line, tracks: info.ownTracks });
    }
    if (info.assertion) {
      memberAssertion.push({ line: info.line, ...info.assertion });
    }
    if (!info.standalone) notStandalone.push(info.line);
  }
  return {
    customerKey,
    ownTracks,
    memberAssertion,
    // 「不能独立使用」的线要点名：它们的子线承诺还没做到。
    notStandalone,
  };
}
