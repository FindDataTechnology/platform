# 生产验收记录（9.1，2026-10-19）

判据①（跨会话 handoff 接力）✓：生产 runner-serving（cheap-4）上 dsh 部署 spider-heal
（pack KkCie7NlrHluo4LiKPnn0w）真实回合内经 `mcp__fd-memory__memory_handoff_begin` 写出
handoff `98381ad2-bec0-4902-ab4a-06c7e5012f0f`（state=open）；验收方以独立部署令牌另起
MCP 会话 `memory_handoff_accept` 认领成功（accepted_by=acceptance-zcode），重复认领被拒
（already_claimed，归属不变）。**ACP 侧**：挂载注入与 CLAUDE.md 纪律已在生产镜像
（compose-acp 路径+单测 8/8），现网无 ACP 部署可驱动——补验留待首个真实 ACP 服务上线
（spec 场景在测试层已覆盖）。

判据②（停机降级开放）✓：fd-memory scale 0 期间 spider-heal 回合照常执行并回答
（TURN-DURING-OUTAGE: "降级正常"），恢复后观测续投；实施期曾实测连续 500 时
`memory capture gap #N; turns unaffected`（fail-open 日志在案）。

判据③（manager 代采观测落库）✓：spider-heal namespace（d/KkCie7NlrHluo4LiKPnn0w/爬虫自愈
修复 Agent）下 memory_recent 可见：handoff 页 + 会话页 + srv-packs-…-spider-heal 会话的
observations（回合/工具事件）。capture gap 计数=0（git 可选化修复后）。

## 实施期三起旁发现（非本变更引入，均已处置或登记）

1. **runner 数据根 LLM key 死钥**（10-18 轮换漏 /data/llm-providers.json）：serving 车道
   LLM 回合自轮换起全 401/403。已用本地活钥修 in-pod 文件并滚 pod；**源头（cheap-1 卷
   rsync 源）未同步，登记待办**。
2. **wx-alpha 部署者计费键死**（sk-a4…c7c 401）：该部署专属，需部署者重绑（登记待办）。
3. **fd-health-proxy 的 NO_PROXY 不含集群 DNS 域**：dsh child 的 fd-memory MCP 请求被
   mihomo 劫走（server disconnected）。已修 secret（追加 .svc.cluster.local,.svc）并滚
   runner——集群域走出口代理本就是普适错误，该修复惠及全部消费方。

## 凭据暴露登记（本会话 transcript）

- mihomo 代理凭据（fd-health-proxy secret 值，读 NO_PROXY 时带出）
- ai-memory 根 token（切片 1，已轮换）；fd-memory runner token 全程未落 transcript（管道传递）

## as-built 偏差与 v1.1 待办

- namespace 推导用 entry.name（显示名，含中文/空格）而非 agentId slug——显示名改名=换
  namespace。v1.1 改优先 metadata.agentId。
- pod 共宿成员无 agent 侧挂载（v1 已知边界，design D3 修订在案）。
- 7.2 B 向互读（stock ai-memory 冷导入）留独立 spike。
