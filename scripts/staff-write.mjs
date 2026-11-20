// 用**主人 person 令牌**把进度页写进主人根（u/ 下），验证交互会话的书记能读到。
// 交互会话走共享 patch = owner person 令牌（成员私有 patch 只挂 worker slot），
// 所以要让"网页/微信里问进度"成立，页必须落在会话读者真实能看到的那条根上。
//
// 用法：node /data/staff/write-person-progress.mjs <bodyFile> <asOf> <ownerEmail> [project] [sourceHead]
//
// `sourceHead` 是「仓@sha,仓@sha」那串，由本机 `progress-feed.mjs` 的 `sourceHeadOf(blocks)`
// 算好传进来（同一件事只在一处定义）。**它必须进 metadata**：书记的 persona 要求进度页带
// `source_head` 才能核到具体提交；2026-11-12 实测，这条腿漏了它，书记只能如实答
// 「该页缺 source_head，只能用 as_of 与 authored_by 定位」——不是服务丢字段，
// 是两个写者（成员令牌那条腿 / person 令牌这条腿）口径不一致。现在两边都发。
import { readFileSync } from "node:fs";
import { cellMemoryConfig, personTokenFor } from "@finddatatechnology/yongyi-client";

const [bodyPath, asOf, ownerEmail, project = "progress", sourceHead = ""] = process.argv.slice(2);
const cfg = cellMemoryConfig(process.env);
const token = await personTokenFor(cfg, ownerEmail);
if (!token) {
  console.error("person 令牌铸造失败");
  process.exit(2);
}
const body = readFileSync(bodyPath, "utf8");
const metadata = {
  kind: "progress",
  as_of: asOf,
  authored_by: "agent:progress-feed",
  feed_status: "ok",
  // 没传就别假装有：缺这个键本身是可观测的事实（书记会如实报缺），比写个空串诚实。
  ...(sourceHead ? { source_head: sourceHead } : {}),
};
const res = await fetch(`${cfg.url}/pages`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({
    project,
    title: `项目进度 · ${asOf.slice(0, 10)}`,
    body,
    metadata,
  }),
});
const text = await res.text();
console.log(
  "POST /pages (person token, project=" + project + ", source_head=" + (sourceHead ? "yes" : "NO") + ")",
  res.status,
  text.slice(0, 300),
);
if (!res.ok) process.exit(1);
