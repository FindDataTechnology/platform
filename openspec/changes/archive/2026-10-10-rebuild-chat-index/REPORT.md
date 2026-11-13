# rebuild-chat-index — 实施报告（2026-10-10）

## 交付物

| 文件 | 作用 |
|---|---|
| `scripts/rebuild-chat-index.mjs` | 从 dsh 转录重建会话索引；默认 dry-run，`--apply` 才写；写前自动备份；幂等 |
| `scripts/check-rebuild-parity.mjs` | 活标本对拍：用转录重建后与现存索引逐行比对（只读，不改任何东西） |
| `scripts/test-rebuild-chat-index.mjs` | 18 条单测：镜像语义、合并规则、归一、CLI 形态、dry-run/apply/幂等 |

## 验证证据

### 1. 活标本逐字节对拍（生产数据，只读）

在 cheap-3 的 platform 容器内对 **platform-test cell（`3fdc7b8e8ac03b68`）** 运行
`check-rebuild-parity.mjs`——该 cell 的索引仍完好，是天然的"标准答案"：

```
[parity] PARITY OK 14/14 sessions
```

即：仅凭转录重建出的 role / content / blocks（含工具 `args`/`result`/`state`）与平台
实时写入的库**逐行一致**。这是设计 D1 的"复制而非共享代码"能被接受的依据——差异由对拍兜住。

### 2. 小说 cell 生产 dry-run（只读，未写库）

```
[rebuild] cell: /data/cells/2b043ce050ca134c
[rebuild] mode: dry-run
[rebuild] owner: 3106241601@qq.com
[rebuild] sessions: 125 (transcript 108, legacy 1, legacy-only 16)
[rebuild] messages: 5104
[rebuild] content bytes: 233178.5 KiB
[rebuild] skipped foreign-owner sessions: 4
[rebuild] warning: index sidecar files present (-wal, -shm) — a live cell may hold this database; stop the cell before --apply
```

逐项核对（与设计预期一致）：

- **125 会话** = 109 个有转录（108 取转录 + 1 取老库）+ 16 个仅老库；
- **5,104 条消息 / ~228 MiB 正文**；
- 重叠的 109 个里 108 个转录侧更全、1 个老库更全（pi 时代 `019fef5f`）——逐会话取更全一侧的规则按预期工作；
- **他人 4 行按 owner 跳过**（aloadtree 的测试会话，物理遗留在该 cell）；
- **活库警告正确触发**（该 cell 正在运行，`-wal`/`-shm` 非空）——这正是"apply 前必须停 cell"的护栏。

> 注：早前估算的 121 会话是转录侧计数误差（105 vs 实际 109）；dry-run 的实测值已回填进
> proposal/design/tasks。

### 3. 本地回归

- `npm run test:unit`：**979/979 通过**（含本 change 的 18 条、以及被本次改动触及的既有套件）；
- `npx biome check`（9 个改动文件）：零告警；
- `npm --prefix web run typecheck`：通过。

## 实施中的两处修正（均已回填工件）

1. **CLI 入口判定**：初版用 `process.argv[1].endsWith("rebuild-chat-index.mjs")` 判断"是否作为 CLI 运行"，
   但测试文件名 `test-rebuild-chat-index.mjs` 也以该串结尾 → 测试 import 时误触发 CLI。改为
   `path.resolve(argv[1]) === fileURLToPath(import.meta.url)` 精确比较。
2. **legacy 临时副本落点**：初版把老库副本放在源文件旁，在只读挂载目录（生产实况）下 EACCES。
   改为 `mkdtemp` 到系统临时目录——这正是生产 dry-run 首次执行时暴露并当场修掉的。

## 尚未完成（生产窗口，需人工）

- 4.1 前置：`fix-cell-spawn-inflight-dedup` 上线 + 确认目标 cell 单进程；
- 4.2 停 cell → dry-run 复跑（本次已在未停 cell 状态下验证，报告一致）；
- 4.3 `--apply`（工具自动备份 `app.db.bak-<ISO>`）；
- 4.4/4.5 抽查与用户点名验收（侧边栏 125 行）；
- 5.1 归档前 `openspec validate --strict` 复跑。

## 已知保真度边界（design D6，已显式声明）

- `normalizeFunctionalRefs` 重跑可复原链接改写（有单测钉死）；
- UNKNOWN_TOOL 候选附注不可复原（保留原始错误文本）；
- 子代理会话不入索引（与实时镜像一致）。

---

## 生产执行记录（2026-10-10 22:38–22:47 CST）

**发布链**：GHA 被 billing 阻断（`gh run view` 明确报 "recent account payments have failed"）、
Jenkins 已于 10-10 退役 → 走 **cheap-3 docker 直建**（该机有 docker + TCR 凭据 + 双区网络）：
`git archive HEAD` → scp → `docker build`（46/46）→ 冒烟 → push hkccr → tcr-relay 自动同步 ccr
（digest 双侧一致 `sha256:643b31d4…`）→ fd-infra-deploy 提 tag `sha-61e44f7` → ArgoCD 同步。

**生产 dry-run**（cell 已停，单写者）：

```
[rebuild] owner: 3106241601@qq.com
[rebuild] sessions: 125 (transcript 108, legacy 1, legacy-only 16)
[rebuild] messages: 5104
[rebuild] content bytes: 233178.5 KiB
[rebuild] skipped foreign-owner sessions: 4
```

**apply**：

```
[rebuild] mode: apply (backup: /data/cells/2b043ce050ca134c/data/data/app.db.bak-2026-10-10T14-43-50-315Z)
[rebuild] wrote 125 sessions / 5104 messages
```

**写后核对**（直读库）：sessions=125（owner 全部为 3106241601@qq.com）、messages=5104、
其中 **4,717 条带 blocks**（抽样 tool 块字段 `kind,id,name,args,result,state` 完整、`state=done`、
`result` 非空）、13 条空 "New chat"（恢复原状）。最大会话 364 条消息（《加密朋克史 前传》细纲）。

**用户面验收**（以 spawner 的 per-user env 起临时 cell，用网关注入的同款身份头查其 API）：

- `GET /api/chat-history/sessions` → **126 条**（125 重建 + 1 当前活动会话），标题与消息数真实；
- 打开最大会话 → title 正确、364 条消息、role 分布 user 4 / assistant 360；
- 临时 cell 已停，临时文件已清。

**体积**：索引 8GB（被删前）→ **349MB**（重建后），其中 trace 部分已分离到 `trace.db`。
