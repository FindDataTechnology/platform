# fd-health-config MCP shim

finddata 中央库健康巡检配置（总闸/限流）的**只读 MCP 面**——spider-heal Agent 经
registry 代理调用它做 gate_change 巡检（`health_config_get` 工具）。

- 数据源：`fd_open_data.public.health_config`（postgres，只读账号 `fd_health_ro`，
  mesh `100.64.0.3:30432`；DSN 由使用方经安全渠道交付，**不进 git**）。
- 形态：单文件 Node 服务（无框架）+ `pg`；Streamable HTTP MCP（stateless），
  仅 `POST /mcp`（`initialize` / `tools/list` / `tools/call` / `ping`），附带 `/healthz`。
- 注册：registry 条目 `fd-health-config`（proxy_pass_url = 部署机 tailnet IP:8090），
  runner 侧 descriptor 里以 `mcpServers: ["fd-health-config"]` 引用（见
  `scripts/spider-heal-pack.mjs` v3）。

## 部署位置（现役）

- cheap1 `/opt/fd-health-mcp/`（代码 + `.dsn` chmod 600；`node_modules` 随包分发，
  镜像构建离线可做）。
- 容器 `fd-health-mcp`：`--restart unless-stopped`，`--network mcp-gateway-registry_default`
  （供 registry 同网络直连）+ `-p 100.64.0.11:8090:8090`（供注册条目按 tailnet IP 访问）。
  - 双通道都通：registry 容器实测 `http://fd-health-mcp:8090/healthz` 与
    `http://100.64.0.11:8090/healthz` 均 `{ok:true}`。

## 变更/重建配方

```sh
# 代码变更后（在部署机）
cd /opt/fd-health-mcp
# 将本目录 4 个文件同步过来（node_modules 需含 pg，可从任一已装的机器 rsync）
docker build -t fd-health-mcp:1.0.0 .
docker rm -f fd-health-mcp && docker run -d --name fd-health-mcp --restart unless-stopped \
  --network mcp-gateway-registry_default -p 100.64.0.11:8090:8090 \
  -e FD_HEALTH_DSN="$(cat /opt/fd-health-mcp/.dsn)" -e PORT=8090 fd-health-mcp:1.0.0
# 轮换只读口令：更新 .dsn → 同一命令重建容器
```

## 已知坑（注册侧）

- `POST /api/servers/register` 新建条目**默认 disabled** —— 必须再
  `POST /api/servers/toggle {path, new_state:true}`；健康检查随 toggle 触发。
- 公网 `/{path}/mcp` 的 nginx location 只为 **enabled+healthy** 的服务生成：
  disable/不健康时 POST 会 405（`{"detail":"Method Not Allowed"}`）。
- registry 的 SSRF 白名单 = `SSRF_ALLOWED_CIDRS=100.64.0.0/10`（整个 tailnet），
  所以上游用 tailnet IP 注册可直接通过；compose 容器名（192.168.x）不一定在白名单内。
- 健康探针节奏 ≈30s（`initialize`+`ping` 对）；子进程（dsh-mcp-client）的握手形态是
  `initialize`→`notifications/initialized`→`tools/list`——排障时用这个区分两者。