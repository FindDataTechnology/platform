# guide 迁移盘点（tasks 1.1 交付）

来源：`web/src/lib/packGuides.ts`（6 市场包 + 5 starter 团队卡，各 3 步）×
生产市场匿名读面（facet.finddatatech.cloud，2026-10-31 实测）。

## 第一批（本 change 可发布，已 staging + 过发布门校验）

| packId | 市场名 | 作者 | 版本 | 官方 | 现状 |
|---|---|---|---|---|---|
| EMGW14N8voa1b36LSuTxxw | 客服班组 | aloadtree@gmail.com | v5 | ✓ | 无 guide |
| aofNf6o2LR61lPK8IVVkJw | AI 公司 | aloadtree@gmail.com | v5 | ✓ | 无 guide |
| tkHe8IHE0BuDYYIg5LglUw | 内容流水线 | aloadtree@gmail.com | v5 | ✓ | 无 guide |
| YMSt-hRNiNWXrlLYC8PSiA | 投研晨会 | aloadtree@gmail.com | v5 | ✓ | 无 guide（已有 i18n.en 块，并入） |
| 56opYgliV9FYAmhmsDIJOw | 晨报情报站 | aloadtree@gmail.com | v5 | ✓ | 无 guide |

- 文案：`staging/guides.json`（zh 与 packGuides.ts **逐字对齐**，en 副轨新撰，
  全部 ≤2.8×zh 满足 3:1 比率门——门的方向是 **en ≤ 3×zh**，防贴错内容）。
- 每支发布 v6，`notes = "guide 迁移：使用指南改为随 manifest 下发（无功能变更）。"`。
- 合并后 manifest 已过 `validatePackManifest`（发布门同函数）5/5 绿。

## 第二批（本 change 内不可发布，挂协调）

| packId | 市场名 | 阻因 |
|---|---|---|
| qnhd7B3J1-HKDDKzZQ_fUQ | 文档工坊 | 作者 `doc-studio@finddatatech.cloud` ≠ 发布账号——发布门「仅原作者可发新版本」（gateway/packs.js:608,1425） |
| Aqag8Mky4ksoPmwRDMCVYw | 数据研究 · 生态版 | 作者为社区账号 `3106241601@qq.com`——需原作者发布或运营协调 |
| J9sO_wRCgUVjbYVEqD4Pog | 法律-合同 | 匿名 404（unlisted/退役），需登录读面核实 |
| _r1lL81mBSMTtvjraEwkJA | 法律-案件 | 同上 |
| Y5uR57UBAXi7_xruKQBsfg | 数据-股票 | 同上 |
| hKvTCaWfSIAAJhZSseoE9w | 数据-中国经济 | 同上 |

## 已核清的语义（防事故）

- **同 id 重发布不改行作者**（`UPDATE packs` 只动 unlisted/category）→ 官方判定
  （读行作者）不会被重发布剥掉；但也意味着必须以原作者账号发布。
- **匿名 detail 即存储 manifest**（top-keys 与 pack 形状吻合；skill-md 与 manifest
  正文差 153B 为渲染头）——但发布脚本仍走**登录读面**取全量再合并（纵深防御）。
- 发布限流 10/h：5 支一批安全。
- **欢迎态 prompt 建议卡不迁**（chrome，非包内容）——第二批完成后 packGuides.ts
  仅存 prompts。

## 发布通道

壹座代理（同源 `/api/packs`）+ `paas_session` cookie（aloadtree@gmail.com）。
铸造配方见 `yizuo-prod-ops-recipes`：真 platform pod（先 `/api/auth/me` 验身份）
`cat /data/auth/session-secret` + `server/session.js` signSession。
脚本：`staging/publish-guides.mjs`（默认 dry-run，`--fire` 才发布）。
