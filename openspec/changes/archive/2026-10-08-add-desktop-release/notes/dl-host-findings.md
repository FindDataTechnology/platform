# dl.finddatatech.cloud 主机勘定（task 3.1 前置调查，2026-10-07 实测）

结论先行：**现有 cheap 舰队没有一台能直接做 dl 平面**，需要用户拍板（买/换/控制台三选一）。DNS 侧同时需要 DNSPod 控制台动作（zone 由 francis/zara.dnspod.net 托管，仓内无 API 凭据）。

## 实测矩阵（2026-10-07，nc/curl/ss 直探）

| 机器 | 公网 80/443 | 判定 |
|---|---|---|
| cheap-4/5/6/7（103.236.97.114，LXC 母机+容器） | 80 由**运营商 NAT 错误页**应答（"站点无法访问"页，非本机）；443 filtered | NAT VPS，公网 80/443 不可用 → **出局** |
| cheap-3（103.236.89.174:40925） | ssh 走非标端口 = 同类 NAT VPS | 同上出局 |
| cheap-2（103.236.94.58） | 80 被 docker-proxy 占用（hfish/regcache 之一）；443 filtered（安全组未放行？） | 真公网 IP 但 80 已占 + 蜜罐混布 + 满载（wanxing relay + 4×regcache + hfish）→ **不合适** |
| cheap-1（103.236.89.212） | Safeline + fd-prod k8s 入口（platform/token 域名解析处） | 生产入口，下载大文件走 WAF/ingress = 设计明确回避的路线 → **不推荐** |
| xinru/zihan/chengsi 等 Tencent 云机（124.220.x/134.175.x/…） | 真云主机可开 80/443（安全组控制台） | 个人/业务在用（xinru-master 刚出过 OOM 事故）→ 不往别人机器上塞官方下载站 |

## 三个待用户拍板的选项

1. **新开一台轻量服务器专做 dl**（推荐）：腾讯轻量 2C2G-带宽按量/峰值带宽档，~¥40-90/月；300MB×3 产物×保留 2 版 ≈ 2GB 盘。DNSPod 加 A 记录 dl → 新机 IP；Caddy + ACME 一次到位。最干净，零混布风险。
2. **EdgeOne CDN 前置**：www.finddatatech.cloud 已在 EdgeOne（eo.dnse1.com）；dl 加速域名 + origin 回源到任意高位端口（如 cheap-2:8443 起 Caddy）。控制台动作（EdgeOne + DNSPod 两处）；国内下载体验最好（CDN 大文件加速），有流量费用。
3. **fd-prod 入口挂路径**（不推荐）：dl.finddatatech.cloud 解析到 cheap-1，Safeline 加站点反代到 k8s/主机上的静态目录。零新成本，但下载流量压生产入口 + 又回到 ingress 线（设计 D1 回避的路线）。

## DNS 侧（所有选项共需）

- zone：finddatatech.cloud @ DNSPod（NS: francis/zara.dnspod.net）
- 动作：加 `dl` A 记录（选项 1/3）或 CNAME 到 EdgeOne（选项 2）
- 仓内未找到 DNSPod API Token；属控制台动作，与上面选项一并做

## 对主链的影响

无。首条目按 GitHub-only 过渡态发布（release-sync 不带 `--dl-live`），官网下载带渲染 GitHub 直链 + "官方直链即将上线"注记（download-center spec 已覆盖该态）。dl 平面就绪后 `release-sync <tag> --dl-live` 重写 snapshot 即完成 promotion——页面零改动。
