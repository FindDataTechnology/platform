# README — 这个目录里的 app.db 是什么（以及**不要**拿它做什么）

> 本文件由 openspec change `retire-orphan-platform-state` 2.3 旁置，**放在库旁边**
> （pod 内 `/data/data/README-platform-db.md`，宿主 `hostPath: /opt/platform` ⇒
> `/opt/platform/data/README-platform-db.md`），仓内副本见
> `paas/docs/platform-db-readme.md`。**内容含实测读数，读数后面注了采集时刻**；
> 数字会随世界变化，两者不一致时以"重新测一次"为准，别照抄。

## 1. 它是什么

平台自己的 SQLite 库：`PLATFORM_DATA_DIR=/data`（镜像 `ENV` 就带着）⇒
`paths.js: storeDir("data")` = `/data/data` ⇒ `db.js: DEFAULT_DB_PATH` = `/data/data/app.db`。
**它不是孤儿、不是遗留物、不是"另一个平台的库"**——它就是平台进程按设计要用的那份。
共用同一目录的还有 `fleets.db` / `packs.db` / `blueprints.db`（各自独立文件，别提错）。

## 2. 谁写到最后（实测 2026-11-17）

| 事实 | 读数 |
|---|---|
| 文件大小 | 917,626,880 B（875.1 MiB）= `page_count 224030 × page_size 4096` |
| 文件 mtime | `2026-11-09T07:46:38.726Z` |
| **那次写入是什么** | `schema_migrations.applied_at` max = `2026-11-09T07:46:38.726Z`（52 条）⇒ **迁移器跑过一轮**，不是业务写 |
| 业务内容最后写入 | `chat_messages` `2026-10-01T12:12:25Z`（1,747 行）、`chat_sessions` `2026-10-01T11:26:08Z`（79 行）、`user_preferences` `2026-10-01T06:43:01Z` |
| `trace_events` | 1,558,154 行，`ts` 跨 `2026-09-17T17:01:55Z … 2026-10-01T12:15:39Z`，payload 410.2 MiB |
| 表数 | 50 |

**读法**：mtime 停在 11-09 不等于"11-09 还在干活"，它是迁移；业务内容实际停在 **10-01**。
反过来也别把"mtime 新"读成"有人在用"——见下面第 4 节。

## 3. 为什么现在没人用它（根因是进程，不是配置）

托管形态把 chat / trace 搬进了**每个 cell 自己的库**（`/data/cells/<cellId>/data/data/app.db`），
platform 自己那份就只剩账目与配置类表在慢慢变。

更要紧的一条：**`trace_events` 这 155 万行永远不会被任何代码再裁一次**，因为
`server/trace.js` 的 `prune()` 与 `migrateLegacyTraceRows()` **都在 `initTrace()` 后面**，
而 `initTrace()` 在生产只有一个调用方 `server.js:1405`；platform 容器跑的是
`node gateway/index.js`，它既 `import` 不了 `server.js` 也 `import` 不了 `db.js`
（`server.js` 只是 cell 子进程的入口）。旁证：pod 里**没有 `trace.db`**——platform 进程
从不 `openTraceDb()`。所以 `TRACE_RETENTION_DAYS` 对这张表**不可能生效**，
这不是策略没配好，是进程不对。

处置在做，不在等：`paas/scripts/reclaim-platform-trace-events.mjs`（默认干跑；
`--execute` 必须带 `--backup`；有进程持有就拒删）。**只清 `trace_events` 一张表，
不删文件、不改名**——另外 49 张表是活的。

## 4. **不要用它判断凭据状态**

这是 E13 那次错结论的来源：`user_registry_credentials` 在这份库里只有 2 行，
`expires_at` 停在 `2026-09-29T12:10:20Z`，而**续期后的凭据落在 cell 自己的库**。
拿这份库去读"凭据过期了吗"，会得到一个**看着很确定、实际指向一个月前**的答案。

同类错法：`trace_events` 停在 10-01、`chat_messages` 停在 10-01 —— 都不代表功能坏了，
只代表"这份库不再是那条链的写入方"。**判断某个能力是否正常，去读活的那份，别读这里。**

## 5. 怎么判断"我手上的库是活的还是死的"（可复算）

```sh
# ① 看是不是同一个文件（inode）——注意对 fd 本身 stat，不要走 /proc/<pid>/root
stat -L -c 'ino=%i size=%s mtime=%y' /data/data/app.db
# ② 看现在有没有进程持有它（pod 内；无 /proc 的环境是「判不出」，不是「无人持有」）
node -e 'const fs=require("fs");let n=0,h=0;
for(const p of fs.readdirSync("/proc").filter(d=>/^[0-9]+$/.test(d))){
 for(const f of (()=>{try{return fs.readdirSync("/proc/"+p+"/fd")}catch{return []}})()){n++;
  let t="";try{t=fs.readlinkSync("/proc/"+p+"/fd/"+f)}catch{}
  if(t==="/data/data/app.db"){h++;console.log("holder pid="+p)}}}
console.log("fd_links="+n+" holders="+h)'
```

实测参考（2026-11-17，`deploy/platform`）：`fd_links=1898 holders=0`，另有 33 条指向
4 个 cell 的库。**"当前没被持有" ≠ "没人在用"**：偶发打开、用完关闭是常态
（`-wal` 可能 0 字节、`-shm` 却很新），所以"没人持有"只能推出"此刻没有写者在里面"，
推不出"这个库没用"。

## 6. 别做的事

- **别改名、别删除这个文件。** 49 张活表在里面（含 `schema_migrations`、`installed_packs`、
  `user_registry_credentials`、`resources`）。
- **别为了"省空间"只跑 `VACUUM`。** 实测 `freelist_count = 0`、`auto_vacuum = 0` ⇒
  没有空闲页可还，`VACUUM` 回收不到 1 字节；必须先删行再 `VACUUM`。
- **别把它当成"平台的唯一库"。** 同名不同物的另一份在
  `/data/cells/<cellId>/data/data/app.db`，那是每个 cell 自己的。
