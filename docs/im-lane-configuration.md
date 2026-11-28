# IM 通道数据层配置（改文案不出片）

**一句话**：IM 平台的文案、事件白名单、超时、收件人分流规则都在一份 JSON 里，
改完**下一次回合生效**——不出镜像、不重启 pod。

判据：`node scripts/check-im-lanes-mount.mjs --manifest <platform.yaml>`（或设
`IM_LANES_MANIFEST`）。它吃一份清单文件——部署清单，或
`kubectl -n <ns> get deploy platform -o yaml` 的输出——所以 CI 里没有集群也能跑。
挂载形态不对就红。

---

## 两层，各有各的职责

| 层 | 位置 | 谁改 | 生效方式 |
|---|---|---|---|
| 随包默认值 | `gateway/zhiyu/im-lanes.json`（**打进镜像**） | 开发者 | 出片 |
| 运行时覆盖 | ConfigMap `im-lanes-config` → `/etc/im-lanes/im-lanes.json` | 运维 | **下一次回合** |

为什么要两层：只有一层时必须二选一——打进镜像就永远改不了；纯外部则环境没配就跑不起来。
两层让「没配置 = 用默认」成为结构保证，而不是靠谁记得配。

## 怎么改一句话

```bash
kubectl -n fd-prod edit configmap im-lanes-config
```

写入一个**只含差异**的 JSON（不是整份替换，缺的字段自动用默认值）：

```json
{"copy": {"events": {"all_passed": "本轮无人作答（已通知负责人）"}}}
```

保存后下一条群消息就用新文案。`kubectl get pod` 的 AGE 不该变——变了说明你触发了重启，
那不叫热更。

## ⚠️ 为什么不能挂 subPath

这是这份文档存在的**唯一理由**，也是最容易踩的一脚：

```yaml
# 错的
- name: im-lanes
  mountPath: /etc/im-lanes/im-lanes.json
  subPath: im-lanes.json      # ← k8s 用它做单文件挂载
```

单文件 `subPath` 挂载下，kubelet 更新 ConfigMap 时替换的是**符号链接**，而**已经运行的进程
不会重新解析它**——文件在磁盘上变了，进程继续读旧 inode，**而且不报任何错**。

后果：你以为改了、以为热更生效了、实际上什么都没变。下一步必然是「这个功能有 bug」的
误判。所以挂载必须是**整目录**：

```yaml
# 对的
- name: im-lanes
  mountPath: /etc/im-lanes     # 整个目录，没有 subPath
```

`scripts/check-im-lanes-mount.mjs` 就是为这条存在的。它读 Deployment/清单，看到 `subPath`
就红——**承诺靠判据守，不靠记性**。

（同仓已有三个 ConfigMap 踩在这个形态上：`registry-groups-config`、`platform-mcp-config`、
`erp-identity-bindings` 都是 `subPath`。它们改了必须重启，一直是这个状态。）

## 配置坏了会怎样

不会挂。三种情况都降级为随包默认并**只记一次日志**（每次回合都刷是另一种故障）：

| 情况 | 行为 |
|---|---|
| 非法 JSON | 全量用默认，日志指出文件名 |
| 某字段类型不对 | **仅该字段**回退，其余合法字段照常生效，日志点名该字段 |
| 字段缺失 | 该字段用默认 |

永不因配置错误拒绝启动——通道必须一直在。

## 加一个新平台要改什么

**协议代码（必须写）**：一个新的适配器模块，实现
`credentialFields / verifyWebhook / parseMessage / sendText / qr`（见
`server/bots/adapter.js` 头注释）。验签与加解密无法配置化——硬做成 DSL 只会比代码更难维护。

**业务数据（不必改代码）**：往 `im-lanes.json` 的 `dispatch` 与 `copy.events` 加该平台的条目。

这条边界是刻意的：**首次接一个平台仍要出片一次**，之后改它的文案、超时、分流规则都不用。
