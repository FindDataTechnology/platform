// 舰队级凭据包（change converge-line-identity-and-keys 4.1）。
//
// 要解决的问题是一句话：**钥匙的切分轴和产品的切分轴反了**。产品按业务切
// （识律 / 柏讯 / 客服台），钥匙按供给域切（词元一把、第三方各一把），
// 于是装一个跨三条线的舰队，属主要填三套身份。
//
// 本模块只做**规划**：给定若干 pack 声明的 MCP server，算出这个舰队一共要
// 属主填几次、每次填哪扇门、填完的入口在哪。它不算凭据状态——状态由传入的
// `resolveServer()` 带进来（线上那条是装包时用的同一个解析器，见
// `credentialRefs.credentialConnected`），因此不存在"第二个状态读面"。
//
// 计次的口径（这是本文件唯一的实质判断，别改成"按线数"）：
//
//   门 K  一把词元钥喂所有线  → 无论几条线，**最多算一次**。
//   门 A  代做按 (人, 线) 授权 → **每条线各一次**（consent 行是按线的）。
//   第三方 各家自己的凭据      → **每个 ref 各一次**（chatwoot 的 token 不会
//                              顺手喂通 registry）。
//
// 所以"每门一次"只在门 K 上成立；把第三方也并成一门，就会在装配时告诉属主
// "填一次就够"，然后他填完 chatwoot 仍然装不上 registry——这正是要消掉的那种
// 假承诺。

//: 门的显示名。门 id 与 `credential-doors.js` 的 DOOR_ORDER 一致。
export const DOOR_LABEL = {
  "customer-key": "门 K · 客户级钥匙",
  "member-assertion": "门 A · 成员级代做",
  "third-party": "第三方凭据",
};

function unitKeyFor({ door, refName }) {
  // 门 K 是共享的：所有线共用一把钥，故单位键只按门算。
  if (door === "customer-key") return "door:customer-key";
  return `ref:${refName}`;
}

/**
 * 规划一个舰队要属主填哪些凭据。
 *
 * @param {object} input
 * @param {Array<{packId?: string, servers: string[]}>} input.packs
 *        每个成员 pack 声明的 MCP server 名（`mcpServers[].registryName`）。
 * @param {(server: string) => ({refName?: string|null, door?: string|null,
 *         connected?: boolean, missingReason?: string|null,
 *         connectPath?: string|null}|null)} input.resolveServer
 *        解析一个 server 名：返回 null = 注册表里查不到；`refName` 为空 =
 *        该 server 本来就不需要凭据（公开服务）。
 * @returns {{
 *   doors: Array<{door: string, label: string, units: Array<object>}>,
 *   fillsRequired: number,
 *   fills: Array<object>,
 *   satisfied: boolean,
 *   unknown: Array<{server: string, packId: string|null}>,
 *   noCredential: Array<{server: string, packId: string|null}>,
 *   unclassified: string[]
 * }}
 *        未知与无需凭据两类分开列出：前者是"查不到"，后者是"本来就不用"，
 *        把它们并成一类会让真正的配置错误看起来像正常情况。
 */
export function planFleetCredentials({ packs = [], resolveServer } = {}) {
  const units = new Map();
  const unknown = [];
  const noCredential = [];
  const unclassified = [];

  for (const pack of Array.isArray(packs) ? packs : []) {
    const packId = typeof pack?.packId === "string" ? pack.packId : null;
    const servers = Array.isArray(pack?.servers) ? pack.servers : [];
    for (const name of servers) {
      if (typeof name !== "string" || !name) continue;
      const resolved = typeof resolveServer === "function" ? resolveServer(name) : null;
      if (!resolved) {
        // 注册表查不到：不能当作"不需要凭据"放过，那样装配才会在装包时炸。
        unknown.push({ server: name, packId });
        continue;
      }
      const refName = typeof resolved.refName === "string" && resolved.refName ? resolved.refName : null;
      if (!refName) {
        noCredential.push({ server: name, packId });
        continue;
      }
      const door = typeof resolved.door === "string" && resolved.door ? resolved.door : null;
      if (!door) {
        // 归类表里没有它：单独点名，且**自成一次填写**（不知道它和谁共享，
        // 就不能替属主假设共享）。
        if (!unclassified.includes(refName)) unclassified.push(refName);
      }
      const key = door ? unitKeyFor({ door, refName }) : `ref:${refName}`;
      let unit = units.get(key);
      if (!unit) {
        unit = {
          key,
          door,
          refName,
          panels: new Set(),
          servers: new Set(),
          packs: new Set(),
          // 只要有一处说法是"没连"，这一份凭据就当作未满足——宁可多要一次，
          // 也不要让属主以为填完了、装包时才发现还差。
          connected: true,
          missingReason: null,
          connectPath: null,
        };
        units.set(key, unit);
      }
      unit.servers.add(name);
      if (packId) unit.packs.add(packId);
      if (resolved.connected !== true) unit.connected = false;
      if (resolved.connectPath && !unit.connectPath) unit.connectPath = resolved.connectPath;
      if (resolved.missingReason && !unit.missingReason) unit.missingReason = resolved.missingReason;
    }
  }

  const all = [...units.values()].map((unit) => ({
    key: unit.key,
    door: unit.door,
    refName: unit.refName,
    connected: unit.connected,
    missingReason: unit.missingReason,
    connectPath: unit.connectPath,
    servers: [...unit.servers].sort(),
    packs: [...unit.packs].sort(),
  }));

  // 门的固定顺序：最省事的一把钥在前。
  const order = ["customer-key", "member-assertion", "third-party"];
  const rank = (d) => {
    const i = order.indexOf(d);
    return i === -1 ? order.length : i;
  };
  const doors = order
    .map((door) => ({
      door,
      label: DOOR_LABEL[door] ?? door,
      units: all.filter((u) => u.door === door),
    }))
    .concat(
      all.some((u) => !u.door)
        ? [{ door: null, label: "未归类", units: all.filter((u) => !u.door) }]
        : [],
    )
    .filter((d) => d.units.length > 0);

  const fills = all
    .filter((u) => !u.connected)
    .sort((a, b) => rank(a.door) - rank(b.door) || a.key.localeCompare(b.key));

  return {
    doors,
    fillsRequired: fills.length,
    fills,
    satisfied: fills.length === 0,
    unknown,
    noCredential,
    unclassified,
  };
}
