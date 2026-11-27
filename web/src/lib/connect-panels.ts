// connect-panels.ts — 连接页卡片锚点的**唯一名单**
// (converge-line-identity-and-keys 4.4「全站无死链」).
//
// 为什么需要它：门总览（`CredentialDoors`）会为每条连接、每一行成员线渲染一个
// 「去连接」深链 `?panel=<id>`，而**锚点只存在于** `ConnectionsSection` 里那几张
// 卡上。拼出来的 id 一旦没有对应卡片，用户点进去看到的是「连接页，什么都没高亮」
// ——这与「这条线本来就没有可填的卡」完全同形，不报错、不红、也没人会发现。
//
// 2026-11-17 实测出的那一处：门 A 的成员行按 `line-${line}` 拼 panel，而锚点只有
// `line-lex` / `line-wire-customer`；线上已声明成员轨的 `finddata-business` 于是
// 今天就渲染出 `?panel=line-finddata-business`（空跳）。`line-wire` 同理落空，
// 真锚点是 `line-wire-customer`（连接条目 id 与凭据 ref 名不是同一套命名）。
//
// 结论：**给不给链接，由这份名单决定，而不是由「有没有 id」决定**。
// 宁可不给链接（并让那一行只报状态），也不要给一个空跳。
//
// 名单与两侧的对齐由 `scripts/test-connect-panels.mjs` 逐项盯着：
//   ① `ConnectionsSection` 的 `ids={[...]}` 并集 == 本名单；
//   ② 服务端 `DOOR_OF` 的每个连接条目 id ∈ 本名单。
// 任一侧改动而另一侧没跟上，那条用例就红——这是「两份东西之间必须有人比」。

export const CONNECT_PANEL_IDS = [
  "connector-bindings-ledger",
  "ciyuan-account",
  "line-wanxing-caller",
  "registry",
  "facet-market",
  "connector",
  "connector-bindings",
  "line-wire-customer",
  "line-lex",
  "paper-trading",
  "chatwoot",
  "search",
] as const;

const PANEL_SET = new Set<string>(CONNECT_PANEL_IDS);

/** 这个 panel id 真的有卡片吗？没有就别渲染引导链接（宁可不给，也别空跳）。 */
export function hasConnectPanel(panel: string | null | undefined): boolean {
  return typeof panel === "string" && panel.length > 0 && PANEL_SET.has(panel);
}
