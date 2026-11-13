# Design — budget-cell-disk-usage

## Context

动机与实测数字见 proposal.md。本文件只解 2.2 那个悬着的问题——**硬阈值到底在哪一层拒写入**——
以及 2.3 会话历史归档的落点。两条都按"已核实的代码事实 → 候选落点 → 推荐与未解事实"写。

### F1. 写入路径：cell 自己在写，网关不写（读码）

spawner 给每个 cell 一个裸目录根，workspace 只是其中一个子目录：

```js
// gateway/spawner.js:291-309
const root = path.join(dataRoot, userId);         // dataRoot = FACET_DATA_ROOT
const runtimeDir  = path.join(root, "runtime");
const workspaceDir = path.join(root, "workspace");
env.AGENT_WORKSPACE = workspaceDir;               // :369
```

| 事实 | 依据 | 含义 |
|---|---|---|
| workspace 是宿主机普通目录 | spawner.js:307-309 | 没有 PV、没有 fs quota、没有挂载上限 |
| 网关自身不写 workspace | gateway/ 全目录无 `writeFile*` 指向 cell 根（只有 fleet-machines-store / mp-bindings 写自己的状态） | 在网关加拦截只能挡住网关自己的路由 |
| cell 的 cwd 在 root 内 | spawner.js:300-306 注释与实现 | agent 的相对路径写入不会越界到别的 cell |
| facet 数据根是 hostPath | `fd-infra-deploy/.../facet.yaml:279`（`/opt/platform/facet`） | 加配额是在宿主目录上做，不需要 PV/PVC |

**结论**：能挡住"agent 自己产出 1051 MiB"的那一层，必须在 cell 之下或之内，不在网关。

### F2. 已有的事实面：只读上报已完备（2.1 已落）

- `gateway/cell-disk.js` 采集每 cell 的 workspace 与 `dsh/sessions`（`lstat` 走查，符号链接不计），
  5 分钟 TTL 缓存；`ok / near / over` 三态（软、硬阈值均含边界；负数读数不当 over）。
- 读数经 `spawner.statusWithDisk()` 并入 `GET /api/gateway/status`。
- 阈值 `CELL_DISK_SOFT_MB` / `CELL_DISK_HARD_MB`（默认 512 / 2048 MiB，hard 被钳制不低于 soft）。
  已于本次登记进 `.env.example` 与 `DEPLOY.md`（此前只有源码注释）。
- **它不做删除**，也不做拒绝——`over` 今天只是一个状态字符串。

所以 2.2 不是"从零建采集"，是"给已有的 `over` 接一个强制点"。

### F3. 三个候选落点，覆盖面对比

写入者有三类：① 前端上传路由；② agent 的写文件工具调用；③ agent 起的子进程（shell 重定向、导出脚本）。
只看 ① 会被本例直接证伪——1051 MiB 是内容生产产物（2400 章全文、导出、读者版），不是上传。

| 落点 | ① 上传 | ② 工具写 | ③ 子进程写 | 依赖 | 成本 | 失效模式 |
|---|---|---|---|---|---|---|
| **A. 网关上传路由拒绝** | 挡 | 不挡 | 不挡 | 无 | 半天 | 用户以为有配额，agent 照样把盘写满 |
| **B. dsh 工具层（写前查用量）** | 不挡 | 挡 | 不挡 | 改 dsh + 每写一次查一次 | 2–3 天 | 绕过即失效；查用量本身有 TTL，边界处会放行 |
| **C. 宿主机目录配额（project quota）** | 挡 | 挡 | 挡 | 节点 fs 支持 `prjquota`；每 cell 一个 project id | **一次节点重启窗口**（见 F3b） | 写入返回 `EDQUOT`——最诚实的一种失败：内容不被删，新写被拒 |

三者不互斥，但**只有 C 覆盖 ③**，而 ③ 正是本例的主要写入者。

### F3b. 实测（2026-11-09，只读 exec）：xfs，但挂载是 `noquota`

在节点 `liuliangjkiimypbdzxa` 上，facet 的 hostPath 挂载点读出来是：

```
FSTYPE : xfs
SOURCE : /dev/vda1[/opt/platform/facet]
OPTIONS: rw,attr2,inode64,logbufs=8,logbsize=32k,**noquota**
```

两个结论，一好一坏：

- **好**：xfs 本身支持 project quota，不需要换文件系统、不需要引入 PV。
- **坏**：挂载参数是 `noquota`，quota 在这个挂载点上**完全不可用**。要启用必须把 `/etc/fstab` 的这一项改成 `prjquota`（或 `uquota`/`gquota`），然后**重挂或重启**。

关键约束：`/dev/vda1` 是**根文件系统**（容器内看到的 `/` 只是它上面的 overlay）。根分区无法在线重挂，所以这一步的实际形态是**一次节点重启窗口**，而不是我初稿写的"半天～1 天"。

另：该节点同时托管 facet（hostPath 钉死），facet 停机约等于市场面停机——所以这个窗口要和 3.1（kubelet 预留，同样需要 `systemctl restart k3s`）**合并进同一次停机**，不要分两次做。

### F4. 推荐：C 是目标态，A+B 是过渡态

初稿写的是"只要 C、不做 B"。实测之后这个推荐要修正——因为 C 的代价从"半天"变成了"一次节点重启"：

| 阶段 | 做什么 | 为什么 |
|---|---|---|
| 过渡（不等节点窗口） | **A**（`over` 时上传路由 507 + 导出指引）+ **B**（dsh 写前查用量，至少挡住最主要的那条写路径） | 不需要节点重启，先把"用户能感知到"和"主路径被拦"拿到手；覆盖率不全，但比现在完全没有强制点强 |
| 目标（与 3.1 同一窗口） | **C**（project quota + 每 cell 一个 project id） | 唯一能兜住子进程写入的内核级方案；满足 proposal 的硬约束：拒绝新写、不删旧内容 |

初稿对 B 的否决理由是"覆盖率不完整却要加每次写入的检查，性价比最差"。这个理由在"C 只花半天"时成立；在"C 要一次重启"时不再成立——**过渡期里 B 是唯一能在 dsh 侧提前拦住写入的手段**。

C 仍不是"不做 B 也行"的替代：两者覆盖率不同（B 挡工具调用，C 挡一切），最终态必须是 C。

### F5. 风险：配额打满会让回合空转（需一个刹车，未决）

`EDQUOT` 是**永久失败**，不是瞬时失败——队列侧不会自动重试（2026-11-09 的
"只有 502/429/timeout/runtime not ready 才重试"已经把这类归为不重试）。但**回合内**模型可能
反复尝试写同一个文件，用工具错误喂自己，直到预算烧完、还占着 cell 唯一串行槽。

这与 `add-fleet-early-stop` 治的是同一个病（注定失败的回合占着串行槽），建议同一形态处置：

| 方案 | 做法 |
|---|---|
| 首选 | 超预算时由平台向会话注入一条**系统提示**（"该工作区已达 2 GiB 上限，请导出或清理"），并附一个回合内的写失败计数；连续 N 次写失败即按 `context pressure` 同款口径收口 |
| 备选 | 只注入提示，不做早停（简单，但空转风险留着） |

此条**未定**，需与 `add-fleet-early-stop` 的收口车道合并考虑，不要各写一套。

### F6. 2.3 会话历史归档的落点

sessions 合计 1.4 GiB，是唯一"可归档而不损失用户产出"的部分（proposal 已确认 workspace 不可删）。

- 归档目标**不能是同一块盘上的另一个目录**——那只改路径不改总量，节点照样被驱逐。
- 同机的 rustfs 也不行：它与 PG 同盘、且 219 GB 无备份（既定约束），把 cell 会话再堆上去只是加风险。
- 因此 2.3 的形态应是**滚动删除 + 导出选项**：配置保留近 N 天，超期会话先让用户可下载，
  再移出运行盘；落点需在实现前定（本 design 不定）。
- 该决策依赖"谁承担归档存储"，属产品/成本决定，**留给 owner 裁决**。

### F7. 实测（2026-11-09，只读 exec）：平台自身不是主因，但有一笔手工残留

在 facet 容器里读到的：

```
df /data/facet   /dev/vda1  30G  27G  3.6G  89%
du /data/facet   151M
du /data/*       facet 151M, workspace 0
```

- 27 GiB 已用是真的（与"74%–90% 振荡"吻合），但 **facet 自己只占 151 MiB**，`/data/workspace` 为空。
- 这说明主因在容器的挂载视图之外（宿主侧的 containerd 镜像与 cell 数据），**"清理 facet 数据"不是一条可行的缓解路径**。
  同理，3.1（kubelet 预留）的价值随之上升：能动的是宿主层的配额与驱逐参数，不是删平台数据。
- 151 MiB 里有 112 MiB 是 6 个 `packs.db.bak-*`：`bak-batch6-keys`(Nov 6)、`bak-metashape-…`(Nov 7 07:24)、
  `bak-nestedextra-…`(Nov 7 11:13)、`bak-skillskey-…`(Nov 7 07:18)、`bak-dup-20261028`、`bak-unpublish-20261027`。

**这批 .bak 不是代码产生的**：`gateway/`、`lib/`、`server/` 全目录没有任何写 `.bak-` 的路径——它们是历次修
manifest 形状时**人手工 `cp` 的安全副本**，靠命名自带原因与时间。因此：

- 不存在"备份轮转策略缺失"这个代码缺陷，也就不需要实现轮转（初稿若这么写会是误判）。
- 112 MiB 相对 27 GiB 无意义，删除不是缓解手段；留着反而能追溯那几次形状变更。
- 唯一值得留下的约定是**给副本命名带原因与时间戳**（现有 6 个都做到了），下次照此办理即可。

### 范围

- 本 design 只覆盖 2.2 与 2.3 的取舍，不改 proposal 的对外口径。
- 节点侧（3.1/3.2/3.3）是止血与预算两件事，不可互替：**先加 kubelet 预留**（终止 74%–90% 振荡），
  再加租户配额（防止再次增长）。两条都要，顺序是 3.1 → C。

### 未解事实（原为"决定 C 的成本"，已于 2026-11-09 实测结清）

原计划用一条命令定案，实测已给出答案（见 F3b）：

```
FSTYPE  xfs
OPTIONS rw,attr2,inode64,logbufs=8,logbsize=32k,noquota
```

- xfs → 支持 project quota，不需要换文件系统。
- `noquota` → 当前不可用；`/dev/vda1` 是根分区，**无法在线重挂**，实际形态是一次节点重启窗口。
- 该窗口必须与 3.1（kubelet 预留，`systemctl restart k3s`）合并，避免两次停机。

仍然未定的一条（不是技术事实，是产品决定）：2.3 的归档落点由谁承担（见 F6）。
