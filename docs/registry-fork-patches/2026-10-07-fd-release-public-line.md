# fd 谱系发布记录：公开仓免费构建线（2026-10-07）

**背景**：GitHub 组织私库 Actions 被计费阻断（payments failed / spending limit），全部镜像构建停摆。用户拍板：fd-wire 本地构建、fork+paas 走开源。

## 新格局

| 线 | 构建通道 | 状态 |
|---|---|---|
| **fork registry** | 公开仓 [FindDataTechnology/fd-mcp-registry](https://github.com/FindDataTechnology/fd-mcp-registry)（**孤儿分支单提交**，上游 Apache-2.0 保留；两套测试+frontend 套公开 CI 免费跑）→ hkccr → cheap-3 relay → ccr | `sha-5f816cd` 已上 cheap-1（registry+auth-server 双容器换版，mcpgw 不动） |
| **paas platform** | 公开仓 [FindDataTechnology/platform](https://github.com/FindDataTechnology/platform)（快照管线 `make-public-snapshot.mjs` + 公开版 image.yml，secrets=TCR_USERNAME/PASSWORD 已配）| `sha-fc636d9` 三清单已滚（platform/platform-demo/facet） |
| **fd-wire** | cheap-3 本地构建（pip 走清华源；TCR 凭据从 cheap-1 docker config 直通）→ ccr 直推 | `sha-4bd707c` api+web 已滚 |

## 本次上线内容

- fork：ecosystem-bridge 3.3/3.4（每属主月度调用池 CALL_GRANT_*、IDP_USER_GROUP_DEFAULTS 默认组、CALL_GRANT_TIER_SERVERS 档位门）——cheap-1 `.env` 五项已开闸（auth-server compose 显式 environment 清单已补五项；registry 服务 env_file 直读）
- platform/facet：出向腿（marketplace.json 端点/五 target CLI/connect）——生产探针全绿（`scripts/probe-ecosystem-bridge.mjs`）
- fd-wire：计量入账驱动（闭月结算 + 周期轮询，REGISTRY_MONGO_URI 未接时 poll 段自动跳过）

## 教训与坑（本次实锤）

1. **快照管线删 image.yml**：每次快照发布后必须重放公开版 image.yml（本次已形成肌肉记忆，五连发）。
2. **Dockerfile facet 显式 COPY 清单**再咬人：新文件 marketplace-json.js 忘加 → facet CrashLoop → 先回滚保服务再修（sha-a00a073 作废，fc636d9 修复）。
3. **cheap-1 盘满换版法**：30G 盘 97% 时序=清演练残留→拉小镜像→滚→rm 容器（stop 不够！镜像仍被引用）→rmi 旧→拉大镜像；torch 层 extract 失败的残留靠重启 containerd 回收（零中断，与 2026-10-05 同验）。
4. **pip 裸连 pypi 在国内构建机必死**：Dockerfile 无镜像源参数时 sed 加 `-i tuna`（构建期改，不影响镜像语义）。
5. compose 外部网络缺失（tokenvault-idp_default）会卡 `up --no-deps`：`docker network create` 补空网即过。
6. auth-server 服务是**显式 environment 清单**（非 env_file）——新 env 必须同时补 compose 清单，registry 服务才是 env_file 直读。

## 余项

- fork `/api/version` 仍是 fd-1.1.2（孤儿发布未 bump 版本号——下次发布批一并 bump fd-1.2.0）
- npm `@finddatatechnology/facet`：0.2.0 私仓 facet-cli-publish 被计费阻断（billing），**2026-10-08 改由公开仓 `platform` 打 tag `facet-cli-v0.2.0` 发布成功**（带 SLSA provenance，公开仓 Actions 免费额度不受 billing 影响）。⚠️ 但 0.2.0 带一个 CLI 回归：`isMain` 守卫比较符号链接路径，`npx` 调用下整条 CLI 静默退出（--version 无输出）——已修并随 **0.2.1** 补发（tag `facet-cli-v0.2.1`，含符号链接形态回归测试）。
- v1.3.0 tag 的 release 工作流（桌面安装器）被 main force-push 误触发失败——Yizuo 线处理
- 回滚锚：registry/auth=旧 compose 备份 `.env.bak-eco-bridge-20261007-2228` + `docker-compose.prebuilt.yml.bak-eco-*`；镜像层 sha-5f816cd 前的 tag 已删（ccr 侧永远可拉）
