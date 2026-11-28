# CI mirror：让 GitHub 的门真的判到我们的代码

## 问题（2026-11-17 查实）

GitHub Actions 挂在**公开仓** `FindDataTechnology/platform`，但开发在 **gitee**。
推 gitee 不会触发公开仓——**2026-11-13 到 17 这四天，`CI` / `miniapp-ci` /
`app-build` 一次都没执行过**，而代码天天在落。门全"绿"是因为从未运行。

```
public repo base   dabb44bd3   （11-13 的快照）
gitee/main         8a3f50a73   （落后 738 个提交）
```

## 三个命令

```bash
node scripts/check-ci-mirror.mjs      # 只读体检：公开仓的 base 是否等于 gitee/main
node scripts/make-public-snapshot.mjs --init   # 私仓 → 快照（清洗）
node scripts/publish-ci-mirror.mjs             # 快照 → 公开 CI 仓
```

`check-ci-mirror.mjs` 的退出码是判据，**别把 2 当成 0**：

| 退出码 | 含义 |
|---|---|
| 0 | 公开仓已包含 gitee/main，门在判当前代码 |
| 1 | 落后，需要发快照 |
| 2 | **判不出来**（gh 无权限 / 网络 / 无 baseCommit）——不是"没事" |

## 自动化：post-push hook（可选）

推完 gitee 自动发快照，省得靠人记得：

```bash
ln -sf ../../scripts/hooks/post-push-ci-mirror.sh .git/hooks/post-push
chmod +x .git/hooks/post-push
```

它只在**真的 land 到 main** 时动手（非 main、删除、回退一律静默），
且**永远不阻塞推送**——快照或发布失败只打警告，退出码恒为 0。
一个能让 landing 失败的钩子，比一个落后的镜像更糟。

先看它会做什么而不真推：

```bash
CI_MIRROR_DRY_RUN=1 bash scripts/hooks/post-push-ci-mirror.sh refs/heads/main $(git rev-parse gitee/main) 0000000000000000000000000000000000000000
```

**刻意不自动安装**：往公开仓发布必须是克隆所有者的显式选择。

## 三个脚本的分工

```
make-public-snapshot.mjs   私仓 → 快照（清洗、禁品扫描、gitleaks）
publish-ci-mirror.mjs      快照 → 公开 CI 仓     ← 门在这里跑
publish-image-mirror.mjs   快照 → 镜像仓
```

## 两个踩过的坑

**1. 快照目录里不能直接跑 git。** 快照若没有自己的 `.git`，任何 git 命令都会
落到外层的私仓上——2026-11-14 就是这样把 5812 个内部文件（内部 runbook、
规格目录、agent 指令文件等）force 推到了公开仓。`publish-ci-mirror.mjs` 因此
**要求**快照有自己的 `.git`，并在临时 clone 里推。

**2. 发布前的禁品表不能比 scrubber 更严。** 最初把 `agents.json` 列进禁品，
dry-run 立刻误报——scrubber 明确保留产品目录（公开 app 目录）。第二道门
比第一道严，只会让正确的快照被判失败。
