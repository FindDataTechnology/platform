// 按门的凭据分组（change converge-line-identity-and-keys 4.2）。
//
// 这一层只做**归类**，不读任何凭据、不算任何状态：状态由 `/api/connections`
// 的统一投影给出（那里是唯一读面）。为什么坚持只读一个面——同一批事实若有两个
// 形状，它们一定会漂移，而漂移的那一侧永远是没人看的那一侧。
//
// 两扇门 + 第三方（design D1）：
//   门 K  客户级一把钥匙（词元）：一把钥喂多条线，按客户计费。
//   门 A  成员级代做：平台以"这个人"的名义在该线做事，不持有其登录态。默认关。
//   第三方 别的系统自己的凭据——市场登录、连接器、Chatwoot、搜索、线的自有轨。
//
// 归类表是 manifest 投影之前的形态；任务 5.3 把它换成各线 `auth_tracks` 的并集后，
// 本文件应当读那份投影，而不是继续点名 ref。

//: `/api/connections` 的条目 id → 门。新增一条连接时必须在这里表态，
//: 否则 `doorOf` 返回 null，测试会点名（宁可漏报也不许乱归类）。
export const DOOR_OF = {
  "ciyuan-account": "customer-key",

  registry: "third-party",
  "facet-market": "third-party",
  connector: "third-party",
  "connector-bindings": "third-party",
  chatwoot: "third-party",
  search: "third-party",
  "paper-trading": "third-party",
  "line-wire-customer": "third-party",
  "line-lex": "third-party",
};

//: 门的固定顺序：从"最省事的一把钥"到"各家自己的"。
export const DOOR_ORDER = ["customer-key", "member-assertion", "third-party"];

export function doorOf(connectionId) {
  return DOOR_OF[connectionId] ?? null;
}

//: **连接页条目 id 与凭据 ref 名不是同一套命名**：线自有轨在 ref 表里叫
//: `wire-customer` / `lex`，而 `/api/connections` 的条目是 `line-wire-customer`
//: / `line-lex`。只拿 ref 名去查 `DOOR_OF` 会全落到"未归类"——这条缝是 4.1 把
//: 舰队凭据包接到 ref 上时暴露的（三条线本该合一门，却各报一次未归类）。
//: 归类的**唯一实现**仍在上面的表里，这里只负责把两套命名对齐。
export function doorOfRef(refName) {
  if (typeof refName !== "string" || !refName) return null;
  return doorOf(refName) ?? doorOf(`line-${refName}`);
}

//: 把统一投影的条目 + 各线的联邦配置归成三扇门。
//: 返回结构只含 id 与引用，不含状态——状态留在条目自己身上，避免两处各说一套。
export function groupDoors(connections = [], lines = {}, lineTracks = null) {
  const byDoor = new Map(DOOR_ORDER.map((id) => [id, []]));
  const unclassified = [];
  for (const item of connections) {
    const door = doorOf(item.id);
    if (!door) {
      unclassified.push(item.id);
      continue;
    }
    byDoor.get(door).push(item.id);
  }

  // 门 A 的现状来自配置事实，不是推断：`jitPolicy !== "off"` 才算允许代做，
  // `exchangeUrl` 为空则连兑换端点都没接。默认关就必须报关。
  const lineCfgs = Object.values(lines || {});
  const memberLines = lineCfgs
    .filter((cfg) => cfg && ((cfg.jitPolicy && cfg.jitPolicy !== "off") || cfg.exchangeUrl))
    .map((cfg) => ({
      line: cfg.line,
      enabled: Boolean(cfg.enabled),
      jitPolicy: cfg.jitPolicy || "off",
      exchangeUrl: cfg.exchangeUrl || null,
      ownTrack: cfg.ownTrack || null,
    }));

  // 各线自己的 manifest 声明优先：5.3 之后"新增一条线"只发生在 manifest 里，
  // 平台侧不该再有人回来改表。没有 manifest 时退回联邦配置（当前部署形态）。
  const fromManifests = lineTracks && lineTracks.lines && lineTracks.lines.size > 0;

  return {
    order: DOOR_ORDER,
    doors: DOOR_ORDER.map((id) => ({ id, connections: byDoor.get(id) })),
    memberAssertion: fromManifests
      ? {
          declared: lineTracks.memberAssertion.length > 0,
          enabled: lineTracks.memberAssertion.some((l) => l.enforced),
          lines: lineTracks.memberAssertion.map((l) => ({
            line: l.line,
            enabled: l.enforced,
            jitPolicy: l.jitPolicy,
            exchangeUrl: null,
            ownTrack: null,
          })),
        }
      : {
          // 声明了代做才算"有门 A"；没有就如实说没有，别画一个空门。
          declared: memberLines.length > 0,
          enabled: memberLines.some((l) => l.enabled),
          lines: memberLines,
        },
    // 线的另一半（来自 manifest）：谁吃客户钥匙、谁有自有轨、谁还不能独立用。
    lines: fromManifests
      ? {
          source: "manifest",
          customerKey: lineTracks.customerKey,
          ownTracks: lineTracks.ownTracks,
          notStandalone: lineTracks.notStandalone,
        }
      : { source: "federated-config", customerKey: [], ownTracks: [], notStandalone: [] },
    // manifest 层面的读失败要能被看见（缺目录是"空"，坏文件才是失败）。
    unreadableManifests: lineTracks?.unreadable ?? [],
    // 归类不了的条目要能被看见——静默丢进"第三方"就是在撒谎。
    unclassified,
  };
}
