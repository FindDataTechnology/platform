# site-plaza 部署配方（雷池 + Caddy，同台账 §15.59 家法）

## 拓扑

```
agent.finddatatech.cloud (A → 103.236.89.212 雷池, TTL 先 600s, 域主加)
  → safeline-tengine :443 (WAF)
    → 本机 Caddy :8080 每域一块 → file_server root=<站点目录>
```

## 站点目录与构建

```bash
# 导出（红则中止不发车；断连时 --allow-stale 从上次快照续跑，provenance 诚实保留旧日期）
node scripts/plaza-export.mjs --out site-plaza/generated

# 上传（整目录：index.html style.css script.js locales/ generated/）
rsync -av --delete site-plaza/ <host>:/srv/plaza/
```

## Caddy 块（本机 Caddyfile 追加一块）

```caddy
agent.finddatatech.cloud {
    root * /srv/plaza
    encode gzip zstd
    header {
        # 机读面给 AI 爬虫直读；人面同源
        Cache-Control "public, max-age=300"
    }
    file_server
}
```

## 部署链纪律（tasks 3.2）

1. **导出是部署的前置门**：deploy 脚本先跑 `plaza-export`，非零退出即中止（lint 红/对账红都不发车）。
2. **快照日期永远可见**：页面画廊在实时刷新不可达时展示快照并标注 `generatedAt`（counts.json 的 `stale:true` 表示本次为续跑产物）。
3. **回滚**：站点纯静态——回滚即回退 `/srv/plaza` 目录；无服务进程、无迁移。

## 外部件（本仓外）

- DNS A 记录：域主在 DNSPod 加 `plaza` → 103.236.89.212（TTL 先 600s）。
- 雷池侧：新域加防护站点（同 yongyi/memory 先例）。
- www 官网（fd-official-web，另仓）：products/facet 页加指向广场的链接。
- registry 仓 landing 品牌串同口径「壹座·智能体素材广场」（native-lexicon v5 已记）。
