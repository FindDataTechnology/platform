## 1. 先让截断可见（不改行为）

- [x] 1.1 在服务端按 sidecar 回传的 `llm_calls[]` 判定「可能截断」：存在 `stage=coding_extract`、`ok!=false`、`completion_tokens >= 阈值`（默认 `max_tokens*0.98`，可配 `FD_MEMORY_EXTRACT_CEILING_RATIO`）。verify：单测构造三条 llm_calls（未触顶 / 恰好触顶 / 超触顶），断言判定分别为 false/true/true，且 `ok:false` 的调用不参与判定
  - 2026-11-10 完成：`extractHitCeiling()`（`src/metrics.ts`）。判定只看 `stage=coding_extract` + `ok!=false` + `completion_tokens >= max_tokens*ratio`（默认 0.98，`FD_MEMORY_EXTRACT_CEILING_RATIO` 可配）。单测覆盖：远低/恰好/容差内/容差外/失败调用不计/其他 stage 混淆/畸形输入/null。
- [x] 1.2 指标面新增 `distill.truncated`：`{runs_with_truncation, runs, ratio, threshold}`。verify：单测喂 2 次触顶 + 3 次正常，断言 ratio=0.4；`threshold` 反映当前配置
  - 2026-11-10 完成：`/admin/metrics` 的 `distill.truncated` = `{runs, truncated, ratio, ceiling_ratio}`；无运行样本时 `ratio` 为 **null 而非 0**。单测：3 次运行 1 次触顶 → ratio 0.333。
- [x] 1.3 每次运行的 log 行追加 `trunc=yes/no`，仅此一处改动、不改任何控制流。verify：跑既有蒸馏夹具，断言日志行含 `trunc=` 且既有断言（页数、游标、budget）全部不变
  - 2026-11-10 完成：触顶时打一条 `trunc=yes` 级 warn（含触顶分片数），**不动任何控制流**。单测专门断言「这一步只观察」：页照落、游标照前进、budget 照记账，若将来 step 1 开始改行为这条测试就会红。

## 2. 截断时退避而不是沉默

- [x] 2.1 检测到截断时对半拆批重发（最多一次）；两半都触顶则记 `last_error="extract_truncated"`、`gaps+=1`。verify：单测构造「一次调用即触顶」的 sidecar，断言该批次被拆成两次调用、第二次不再触顶时产出正常落库
  - 2026-11-10 完成：`callWithSplit()`——触顶后对半拆批重试一次；任一半仍触顶则该批「未解决」。开关 `FD_MEMORY_EXTRACT_RETRY_ON_TRUNCATION`（默认开）。测试断言一个 2 条分片被拆成多次调用。
- [x] 2.2 截断失败时**不写 cursor**。verify：单测断言拆批后仍触顶的运行结束后 `note_cursor`/`handoff_cursor` 未前进；同一批材料在下一轮被重新提交（第二次 distillNow 的 items 与第一次相同）
  - 2026-11-10 完成：未解决的批次**不写游标**，`last_error="extract_truncated"`、`gaps+=1`、15 分钟后重试；材料下一轮原样重提（测试断言 notes 集合前后一致）。
- [x] 2.3 未触顶的空产出仍推进游标且不记 gap。verify：单测构造「返回空数组且未触顶」，断言游标前进、`gaps` 不变
  - 2026-11-10 完成：未触顶的空产出照常推进游标、不记 gap、`truncated_runs` 为 0（专门一条测试，防止「一律不推进」的过度修正）。
- [x] 2.4 卡死保护：同一批次连续 `gaps >= FD_MEMORY_EXTRACT_TRUNCATED_MAX_GAPS`（默认 3）时，游标越过该批并记 `last_error="extract_truncated_skipped"`。verify：单测连跑 3 轮，断言第 3 轮后游标越过该批且错误码为 skipped 而非 truncated
  - 2026-11-10 完成：连续 `FD_MEMORY_EXTRACT_TRUNCATED_MAX_GAPS`（默认 3）次仍未解决时置 `last_error="extract_truncated_skipped"`——**跳过有自己的错误码**，与静默丢弃区分。测试用 2 轮 + 上限 2 触发。

> **生产验证未完成（2026-11-10 记，待明日执行）**：2.1–2.4 只有单测证据，**线上尚未观测到一次真实的 d-根「扣游标」**。
>
> 为什么必须留档：今天两次观测都白跑了，且都是**可预判的死胡同**，不是运气问题——
> `wx-alpha`（obs=33921）与 `spider-heal`（obs=7387）当日都因 owner 撞 60 万上限被退避到 UTC 次日零点，
> `next_attempt_at` 分别指向 +710 / +709 分钟。轮询窗口再长也只会得到「没跑」，而**「没跑」不能当作「游标被扣住」的证据**。
>
> **选观测目标的四条判据**（缺一即不可替代）：
> 1. `obs_cursor > 0` —— 否则「游标没动」是恒真，扣没扣住看不出来；
> 2. `pending = max(observations.id) − obs_cursor > 0` —— 无材料则不会跑；
> 3. `headroom = FD_MEMORY_DISTILL_DAILY_TOKENS − 当日 tokens ≥ 35,000` —— 一次截断运行约花 2.5–3.8 万，余量更薄会在走到退避前被预算截停；
> 4. `next_attempt_at <= now` —— 退避中的项目今天不会跑。
>
> **观测程序**（必须 before/after 配对，事后再读一次无法区分「扣住」与「没跑」）：
> 1. 读基线：`distill_state(obs_cursor,next_attempt_at)` + `observations.max(id)` + `distill_budget(tokens,runs,truncated_runs)`；
> 2. 等 `truncated_runs` 加 1（进程内计数器每次滚动清零，跨滚动只看账本这两列）；
> 3. 再读一次 `obs_cursor`：未动 = 扣住；动了 = 该路径未生效。
> 调度节拍：兜底扫描 10 分钟一次、drain 60 秒一次、兜底要求余量 >10 万，故窗口需覆盖 ≥10 分钟。
>
> **判据本身的含义**：`truncated_runs` 不动时不要下任何结论——先分清是「未触顶」还是「根本没跑」。

### 一条命令列出合格观测目标（2026-11-10 实测通过）

四条判据落成一条只读命令，直接给出 `eligible` 列表与逐条判据位。**只读两个库、不触发任何蒸馏**：

```bash
kubectl --context <CTX> -n <NS> exec deploy/fd-memory -c fd-memory -- node -e '
const {DatabaseSync}=require("node:sqlite"),fs=require("fs");
const CAP=+(process.env.FD_MEMORY_DISTILL_DAILY_TOKENS??600000),COST=35000,NOW=Date.now();
const day=new Date().toISOString().slice(0,10);
const tb=new DatabaseSync("/data/tokens.db",{readOnly:true});
const used=new Map(tb.prepare("select owner_key,tokens from distill_budget where day=?").all(day).map(r=>[r.owner_key,r.tokens]));
tb.close();
const out=[];
for(const root of fs.readdirSync("/data/owners").filter(r=>r.startsWith("d-"))){
  const p=`/data/owners/${root}/db/memory.sqlite`; if(!fs.existsSync(p))continue;
  const hr=CAP-(used.get(root)??0);
  let db; try{db=new DatabaseSync(p,{readOnly:true})}catch{continue}
  for(const s of db.prepare("select project,obs_cursor,next_attempt_at from distill_state").all()){
    const m=(db.prepare("select max(id) m from observations where project=?").get(s.project)||{}).m??0;
    const pending=m-(s.obs_cursor??0);
    if(pending<=0)continue;
    const c=[(s.obs_cursor??0)>0,true,hr>=COST,(s.next_attempt_at??0)<=NOW];
    out.push({root,project:s.project,obs:s.obs_cursor,pending,hr,ok:c.every(Boolean),c});
  }
  db.close();
}
out.sort((a,b)=>(b.ok-a.ok)||(b.pending-a.pending));
for(const r of out.slice(0,10))console.log(`${r.ok?"OK":"--"} ${r.root.slice(0,24)}/${r.project.slice(0,16)} obs=${r.obs} pending=${r.pending} headroom=${r.hr} [obs:${r.c[0]?1:0} pend:${r.c[1]?1:0} hr:${r.c[2]?1:0} nobackoff:${r.c[3]?1:0}]`);
console.log(`total=${out.length} eligible=${out.filter(r=>r.ok).length}`);
'
```

为什么不是一条纯 SQL：`distill_state` / `observations` 在每个 owner 根自己的
`db/memory.sqlite` 里，而日账本在 `/data/tokens.db`——跨库要 `ATTACH`，且 SQLite CLI
不在镜像内（只有 `node:sqlite`）。上面的命令等价于「每个根 `ATTACH` 账本库后跑一次 SQL」，
但可直接执行。若某环境有 `sqlite3`，单个根的等价 SQL 是：

```sql
ATTACH '/data/tokens.db' AS t;
SELECT s.project, s.obs_cursor, MAX(o.id) - s.obs_cursor AS pending
FROM distill_state s LEFT JOIN observations o ON o.project = s.project
WHERE s.obs_cursor > 0
  AND s.next_attempt_at <= strftime('%s','now') * 1000
GROUP BY s.project
HAVING pending > 0;
-- 余量判据单独查：SELECT tokens FROM t.distill_budget WHERE owner_key='<root>' AND day=date('now');
```

**输出怎么读**：`OK` = 四条全过、可作观测目标；`--` = 至少一条不过，方括号里是哪一条。
`pending` 越大，一次性送进 extract 的批越大，越可能撞 6,000 天花板——越可能真正走到「扣游标」。

## 3. 摊薄的依据（不改参数，只出结论）

- [ ] 3.1 用 1.2 的指标与 7.1 的 stage 分布，产出「每条材料成本」的实测表（当前 CHUNK=2 vs 假设 chunk=8/20）。verify：表格里每个数字都能指到具体的 stage 累计值与 items 总数
- [ ] 3.2 若触顶比例 < 5%，写出可否加大 `CHUNK` 的结论与目标值；若 ≥5%，结论必须是「先降低触顶，不加分片」。verify：结论引用 1.2 的真实比例数字，而不是阈值假设

## 4. 收尾

- [x] 4.1 全量测试与 `npm run leak-check` 通过。verify：`npm test` 全绿、leak-check 退出码 0
  - 2026-11-10 自查复跑：`npm test` 204 passed / 0 failed；`node scripts/leak-check.mjs` exit=0（138 files, 0 hits，未接管道以免吃掉退出码）。
- [ ] 4.2 更新 `docs/distill-cost-tuning.md`：把「假设的杠杆」与「实测的杠杆」并列保留，结论以实测为准。verify：文档中出现的数字与 3.1 的表一致
- [x] 4.3 `openspec validate fix-distill-extract-truncation --strict` 通过。verify：退出码 0
  - 2026-11-10 自查复跑：valid，exit=0。
