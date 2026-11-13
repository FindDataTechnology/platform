# Tasks — enforce-local-feed-loopback

## 1. 代码

- [x] 1.1 `server/auth.js` 导出 `isLoopbackAddress`（`isLoopback` 的公开别名，单一实现）
- [x] 1.2 `server/local-agent-feed.js` 令牌缺失档先判回环：非回环 401，回环放行
- [x] 1.3 启动日志保留并点名「OPEN on loopback (dev posture)」

## 2. 测试

- [x] 2.1 `scripts/test-local-feed-auth.mjs`：无令牌档三种回环形态放行
- [x] 2.2 同文件：无令牌档三种非回环地址（10.x/192.168.x/100.64.x）401
- [x] 2.3 同文件：令牌档缺令牌/错令牌 401、对令牌放行（回环与非回环各一条）
- [x] 2.4 反证：摘掉回环闸后仅 2.2 那条转红，恢复后字节一致再全绿
- [x] 2.5 回归：`test-auth-bridges` / `test-auth-mode` / `test-cell-auth-paths` / `test-fleet-delegation` 46/46 绿

## 3. spec 与归档

- [x] 3.1 `specs/local-agent-registry-feed/spec.md` MODIFIED R1：两档鉴权 + 新场景
- [x] 3.2 `openspec validate enforce-local-feed-loopback --strict`
- [ ] 3.3 `openspec archive enforce-local-feed-loopback`
