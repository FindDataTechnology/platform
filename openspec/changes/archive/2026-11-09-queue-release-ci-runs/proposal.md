## Why

镜像仓 `scs001/platform-image-verify` 是**出片车间**：`main` 每被 force-push 一次就起一套 CI + image。两个 workflow 都设了

```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
```

含义是"后推的顶掉前一个"。但这条 CI 的**单测要真跑 26 分钟**，而多个会话（内部维护、无外部客户，多个 agent 并行开发）会各自出片——于是先推的那片几乎必定在单测中途被 cancel：

2026-11-09 实测四次，全部同一形态：

```
06:38 我的 CI 开跑 → lint ✅ lint(range) ✅ dsh ✅ typecheck ✅
      单测进行到 26 分钟…
07:04:20 另一会话推新快照 → cancel-in-progress 触发
07:04:33 我的 CI 被 cancel（单测步 cancelled）
```

后果不是"某一次失败"，而是**出片实际上不可用**：谁先开始谁被拍掉，最后一片只是因为没人再推才侥幸跑完。而且每次都烧掉一整轮 CI 额度。

## What Changes

- 镜像仓两个 workflow 的并发策略由「取消进行中」改为**排队**：
  - `ci.yml`：`cancel-in-progress: false`（同一 ref 串行；后来的排队等前面跑完）。
  - `image.yml`：同样改排队——镜像构建被中途掐断会留下半完成的 push，比排队更糟。
- 保留 concurrency 组本身（不同 ref 之间仍可并行）。
- 在 workflow 注释里写明**为什么**不能取消（26 分钟的单测 + 多人并行出片），避免下次有人"优化"回去。

## Capabilities

### Modified Capabilities

- `release-line-hygiene`：新增一条——出片车间的 CI 必须串行排队而非互相取消；被取消的运行 SHALL NOT 被当作失败，但也不得成为常态。

## Impact

- `.github/workflows/ci.yml`、`.github/workflows/image.yml`（各一行 + 注释）
- 镜像仓（`scs001/platform-image-verify`）的快照内容由 `make-public-snapshot.mjs` 从本仓 `.github/` 复制，故改本仓即改镜像仓
- 代价：一次推送最长等一轮 CI（约 30–40 分钟）；收益：任何一次推送都能跑完
