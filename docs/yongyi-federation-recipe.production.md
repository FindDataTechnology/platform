# 本地节点接入舰队记忆（配方，30 分钟）

前置：装好 stock ai-memory（`brew tap akitaonrails/tap && brew trust akitaonrails/tap && brew install ai-memory`）；在 tailnet 内（舰队 NodePort `100.64.0.8:31899` 仅内网可达）。

## 1. 领一枚人令牌

管理员在 fd-memory 侧以 platform 令牌代铸（v1 管理员手工发；自助铸币在产品化阶段）：

```bash
kubectl --context cheap -n fd-prod exec deploy/fd-memory -- node -e "
const body = JSON.stringify({ namespace: 'u/<你的用户名>', label: 'local:<机器名>' });
fetch('http://127.0.0.1:49375/admin/mint', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.PLAT, 'content-type': 'application/json' }, body }).then(r => r.json()).then(j => console.log(j.token));
"   # PLAT=platform 令牌（集群 secret fd-memory-platform）
```

## 2. 注册 fleet profile 并标记工作区

```bash
ai-memory server add fleet --url http://100.64.0.8:31899 --auth-token-stdin --root ~/你的工作区根
# 粘贴令牌后回车
cd ~/你的项目 && printf 'server = "fleet"\n' > .ai-memory.toml
```

## 3. 定时排空（hook 恒先落本地 spool，recover 负责投递）

```bash
# 手动一发：
ai-memory recover
# 常驻（launchd，每小时）：
cat > ~/Library/LaunchAgents/com.finddata.ai-memory-recover.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
  <key>Label</key><string>com.finddata.ai-memory-recover</string>
  <key>ProgramArguments</key><array><string>/opt/homebrew/bin/ai-memory</string><string>recover</string></array>
  <key>StartInterval</key><integer>3600</integer><key>RunAtLoad</key><true/>
</dict></plist>
PLIST
launchctl load ~/Library/LaunchAgents/com.finddata.ai-memory-recover.plist
```

## 4. 验证与回退

验证：跑一个 harness 会话 → `ai-memory recover` → 舰队 MCP query（用同一人令牌 initialize 后 `memory_query "你刚说过的话"`）应命中。
回退（回纯本地模式）：`ai-memory server remove fleet` + 删项目内 `.ai-memory.toml`——spool 自动回落本地 server 投递，零数据损失。

## 语义要点

- namespace=`u/<owner>/p/<cwd basename>`（项目目录名即项目名）；
- 幂等：spool 重投不会双计（ingest_key+session+event 去重）；
- 本地与舰队**同时**可见：本地 ai-memory server 照常跑自己的库，fleet profile 只是把 hook 投递路由到舰队——两边独立，互不迁移（存量迁移=可选的 backup 导入，后续工具）。
