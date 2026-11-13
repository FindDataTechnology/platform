# 上产记录 · 个人代理（2026-11-10）

> 一次性记录：这次上产把「委托状第二三批 + 审计官 + 披露闸 + 就绪检查」推到了生产。
> 链路与判据都写在这里，下次照做即可。

## 一、链路（实测走通的全路径）

```
paas 本地线 ──merge──▶ gitee release/cell-session-persona
                                  │
                   node scripts/make-public-snapshot.mjs --ref <release ref>
                                  ▼
                    dist-opensource/platform（BUILD-INFO 写进真出处）
                                  │  补回 .github/workflows/image-publish.yml（快照会洗掉它）
                                  ▼
            git push --force origin main → github.com/scs001/platform-image-verify
                                  │  GitHub Actions「image」工作流
                                  ▼
              hkccr.ccs.tencentyun.com/law-bench/platform:sha-<快照 commit 7 位>
                                  │  tcr-relay 首见 tag 自动携带（≤5 分钟）
                                  ▼
                    ccr.ccs.tencentyun.com/law-bench/platform:sha-<同上>
                                  │  fd-infra-deploy/all-services/prod/platform.yaml 换 tag
                                  ▼
                        ArgoCD all-services-prod 自动同步 → 重建 pod
```

本次每一段的实测值：

| 环节 | 值 |
| --- | --- |
| 并线提交 | `968a3fc38`（主合并）+ `9811d3622`（并入当时 tip） |
| 并线基线 | release tip `5cce6841c` → 合并后被别人推进到 `2cbc3d42a` |
| 快照来源 | `gitee/release/cell-session-persona` @ `2cbc3d42a` |
| 快照 commit | `a141946` |
| 出片 tag | `sha-a141946`，digest `sha256:e7ee98ab…`，2.47GB |
| gitops 提交 | `c8b6072`（`fd-infra-deploy` 的 `gitee/main`） |
| 生产 pod | `platform-78789dd76f-56wrd`，2/2 Running，0 重启 |
| 回滚点 | `sha-f7138fd` |

## 二、出片前必须过的四道判据（都真的挡过人）

1. **分叉守卫** `node scripts/check-release-lines.mjs --strict` —— exit 0 才继续。
   它按 patch-id 比两条 release 线，镜像提交不会被误判成分叉。
2. **快照泄漏门** —— 本次真拦下一次：`docs/handoff-last-four-steps.md` 里有私有仓名
   与内部 PR 链接。处置是加进 `make-public-snapshot.mjs` 的排除表（同类已有先例），
   不是删文档。
3. **内容闸门** —— 工作流先推 `main`，比对 digest，**只在内容变了时**才铸不可变
   `sha-<commit>`。日志里会打印「已铸 sha-a141946 → sha256:…」。
4. **镜像内探针** —— 起一个一次性 pod 直接查 `/app`：`BUILD-INFO.json` 的 `baseCommit`
   必须等于你打快照的那个 ref 的 sha，且新代码的符号必须真在里面。

## 三、一个会导致「看起来成功了其实没有」的坑

`git push gitee HEAD:refs/heads/main` 时，`gitee` 这个 remote **配了两个 push URL**
（gitee + github）。gitee 侧成功、github 侧被拒（non-fast-forward），命令整体报错，
但**生产读的是 gitee 那条线，所以这次是成功的**。判断依据只能看
`git ls-remote gitee refs/heads/main`，不能看命令退出码。

## 四、生产实测（上产后）

- `healthz` 200，`cells:3, cellsInError:0`，浏览器车道可达。
- 新端点 `/api/fleets/personal-agent/readiness` 与 `/api/fleets/auditor/verdict`
  返回 **401 而不是 404** —— 路由挂上了（未鉴权才是 401）。
- `[db] applied migration v119` 出现在启动日志；实测 head=119 的 cell 都拿到了
  `mandate_domain / principal / audience` 三列。
- 14 个 cell 里委托策略 0、事项来源 0 —— **功能已上线但完全未启用**（预期）。

## 五、没做、也不该顺手做的事

**没有启用 deputy**。`docs/minimal-activation-plan-2026-11-10.md` 的顺序是：先观察
1–2 天新条目的 `category` 非空比例 ≥ 90%，再开 `enabled: true`。在那之前开启，
98% 的存量条目依旧没有类别、依旧落到主人，等于什么都没变。

启用的最小动作（等观察够了再做）：

```bash
curl -s -X PUT http://<cell>/api/fleets/delegation-policy \
  -H 'content-type: application/json' \
  -d '{"scope":"fleet","fleetId":"fleet_1792719144128_qap1vx","policy":{
        "enabled":true,"deputyMemberId":"<常务岗 id>",
        "maxSeverity":"normal","dailyBudget":5,"digest":"daily"}}'
```

一键收回：同一个端点把 `enabled` 置 `false`（已裁决的不追溯）。
