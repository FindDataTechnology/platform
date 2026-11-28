# 恢复某个 cell 的数据（平台租户库）

> 适用：`fd-prod/platform-state-backup` 的夜间产物。谁执行：平台值班（有集群
> kubeconfig 与 platform Deployment 权限）。目标：把单个 cell 恢复到某个时间点，
> 不连带重启其它租户。
>
> 备份的权威清单与产生逻辑在部署仓的 `platform-state-backup` 清单
> （每晚 01:55 CST，与 platform 同节点，写 `platform-state-dump` PVC）。它已经：
> 逐 cell 对 `data/data/app.db` 做 `sqlite3 .backup` + `PRAGMA integrity_check`，
> 清空审计列 `chat_messages.blocks`，镜像成 `cells/<id>/data/app.db` 布局后打成
> 一个 tgz；某个 cell 备成 0 个即判任务失败（不许把空 cells 当成功）。

## 产物长什么样

- PVC `platform-state-dump`（namespace `fd-prod`）里的 `platform-state-<stamp>.tgz`
  与同名 `.sha256`；保留最近若干份（见清单里的 `KEEP`）。
- tgz 内：`data/cells/<cellId>/data/app.db`（每 cell 一个库）、`data/<小表导出>`、
  `cfg/`、`uploads/` 等。
- 同一台节点随后被整机包 `pvc-snap-cheap7` 带走（离机副本）。

## 步骤

1. **找到并校验备份**

   ```bash
   kubectl --context cheap -n fd-prod get cronjob platform-state-backup
   kubectl --context cheap -n fd-prod get jobs | grep platform-state | tail -3
   # 读某次 job 日志里的 "ok <路径> <字节> 通读通过 sha256=… 保留 N 份"
   kubectl --context cheap -n fd-prod logs job/platform-state-backup-<id> --tail=50
   ```

2. **取出 tgz**（PVC 是 RWO；与 job 不同时跑即可）

   ```bash
   kubectl --context cheap -n fd-prod run backup-shell --rm -it --image=alpine:3.20 \
     --overrides='{"spec":{"containers":[{"name":"s","image":"alpine:3.20","command":["sh"],
       "volumeMounts":[{"name":"b","mountPath":"/backup"}]}],
       "volumes":[{"name":"b","persistentVolumeClaim":{"claimName":"platform-state-dump"}}]}}'
   # 在里面：sha256sum -c platform-state-<stamp>.tgz.sha256 && tar -tzf … | head
   # 退出前把 tgz 拷到能取出的位置，或直接在 hostPath 可见处操作
   ```

3. **只停目标 cell**（不动网关）

   ```bash
   kubectl --context cheap -n fd-prod exec deploy/platform -- \
     pkill -f 'PLATFORM_DATA_DIR=/data/cells/<cellId>' || true
   ```

4. **解出该 cell 的库并替换**（platform 与数据在同一节点的 hostPath）

   ```bash
   NODE=<平台节点>   # 取 platform Deployment 的 nodeSelector 值，必须一致
   ssh $NODE 'set -e'
   ssh $NODE 'cp -a /opt/platform/cells/<cellId>/data/data/app.db \
                    /opt/platform/cells/<cellId>/data/data/app.db.bak-$(date +%s)'
   tar -xzf platform-state-<stamp>.tgz -C /tmp/restore data/cells/<cellId>/data/app.db
   ssh $NODE 'mkdir -p /opt/platform/cells/<cellId>/data/data && \
     install -m 600 /tmp/restore/data/cells/<cellId>/data/app.db \
                    /opt/platform/cells/<cellId>/data/data/app.db'
   # 清掉旧 WAL 侧车，避免旧日志回放覆盖恢复点
   ssh $NODE 'rm -f /opt/platform/cells/<cellId>/data/data/app.db-wal \
                     /opt/platform/cells/<cellId>/data/data/app.db-shm'
   # 属主交给该 cell 的 uid（有了 per-cell uid 后这一步必须做）
   ssh $NODE 'chown -R $(stat -c%u /opt/platform/cells/<cellId>) /opt/platform/cells/<cellId>/data/data'
   ```

5. **校验**

   ```bash
   ssh $NODE 'sqlite3 /opt/platform/cells/<cellId>/data/data/app.db "PRAGMA integrity_check;"'
   # 期望 ok；再抽查 chat_sessions 行数与备份一致
   ```

6. **放它回来**：以该用户身份发一次请求（或等下一次流量），网关重新拉起 cell；
   `GET /api/ready` 返回 200 且 `dbReady=true` 即完成。

## 失败回退

- 第 5 步不通过：把第 4 步的 `app.db.bak-*` 换回原位，保留故障库供分析，再换更早的备份。
- 全节点丢失：在新节点按原路径重建 `/opt/platform/cells/<cellId>/`（属主为该 cell 的 uid、
  根目录模式 700），放入恢复的 `app.db`，再拉起。uid 取自
  `/opt/platform/cells/cells-registry.db` 的 `cell_uid` 表（缺则网关下次启动重新分配，
  但请先恢复注册表以保持归属映射）。

## 注意

- 备份是明文库：PVC 访问权 = 全租户数据访问权。
- 备份产物与源同盘、靠整机包出远门；**不要**把恢复用的 shell pod 与夜间 job 同时挂 PVC。
- 本仓曾在 `k8s/` 下放过一份 cell 备份 CronJob，已删除：生产已有的 `platform-state-backup` 覆盖更强，
  不再造第二份备份。
