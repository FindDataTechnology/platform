# 存量市场包 v4 改名实录（2026-10-30）

依据 `add-legacy-pack-rebrand` 与愿景口径：**名字只说「谁/干什么活」——结构归徽章(badge)、来源归 official 标、归属归类目线词**。
执行方式：走查 admin 身份经 pod 内 facet 内部信道逐包**发新版本**（id 不变、不可逆）；发布前全量过 `/api/packs/validate` 干跑（22/22 绿），发后 diff 复核仅 name/description/en.name 变，价格(全免费)/订阅/可见性零变化。

| 包 id | 旧名 | 新名（已发新版） |
|---|---|---|
| `v8rZ8F7E92MrssZ92ygnXQ` | 壹座产品介绍（官方种子） | 壹座产品介绍（v4→v5） |
| `C8wx14-4h7zJ0N19-J4NwQ` | 跨境电商政策盯梢集群（模板） | 跨境电商政策盯梢团队（v4→v5） |
| `8wJVZZnk369wm0oFScdecA` | 萬星机群运营集群（模板） | 萬星机群运营团队（v3→v4） |
| `ujUI1A2caCUW7TG1Z1mlEg` | 谦面运营集群（模板） | 谦面运营团队（v3→v4） |
| `LjTJZWqSr2AOX7WEFTVlpg` | 官网内容集群（模板） | 官网内容团队（v7→v8） |
| `IVCGxpg9itGnLpHxT1khWQ` | 情报舆情集群（模板） | 情报舆情团队（v7→v8） |
| `O30LA92kq1D5uuNIBGKsZQ` | 能力包·构造·蓝图构造师 | 蓝图构造师（v5→v6） |
| `_Rl8i99CS5nwuARVbp0D5Q` | 能力包·闸控·评测哨 | 评测哨（v4→v5） |
| `y2_QsuKxV8dZFr-39_0zRQ` | 能力包·归账·数据问答 | 数据问答（v3→v4） |
| `4z4dMrtNbTn2WcE-45QPfw` | 能力包·采集·情报采集 | 情报采集（v3→v4） |
| `Mo3_aWe7tF2eFVzkqFT9mA` | 能力包·产出·看板投稿 | 看板投稿（v4→v5） |
| `F8gbhNaEG6c2rDz468MwaA` | 能力包·合成·简报与报数 | 简报与报数（v3→v4） |
| `SWPvacoFTftfVngMMFotwQ` | 柏讯 · 产物构建 | 柏讯 · 产物构建（v3→v4） |
| `tkHe8IHE0BuDYYIg5LglUw` | 内容流水线（官方种子） | 内容流水线（v4→v5） |
| `NoBBXkvxZnJNHlCrAwWp-w` | 集群架构师（官方种子） | 团队架构师（v4→v5） |
| `56opYgliV9FYAmhmsDIJOw` | 晨报情报站（官方种子） | 晨报情报站（v4→v5） |
| `YMSt-hRNiNWXrlLYC8PSiA` | 投研晨会（官方种子） | 投研晨会（**未执行——同名冲突待裁**） |
| `aofNf6o2LR61lPK8IVVkJw` | AI 公司（官方种子） | AI 公司（v4→v5） |
| `EMGW14N8voa1b36LSuTxxw` | 客服班组（官方种子） | 客服班组（v4→v5） |
| `Y99VUN6RdWs98ocK0ZAN8A` | 识律营销集群（模板） | 识律营销团队（v2→v3） |
| `ZCot-b6HsnJRTTDKr_aunQ` | 法规追踪集群（模板） | 法规追踪团队（v2→v3） |
| `1HbpcL4LaB-csKpUQgN2Ew` | 识律政心监测集群（模板） | 识律政心监测团队（v2→v3） |
| `egaYyOaZVTf0FWlLvaGAQA` | 柏讯 · 投研三镜头 | 柏讯 · 投研三镜头（v2→v3） |

## 唯一遗留：两枚「投研晨会」
- `Bo2MWrbW5w_f1NGfwMWEzA` 「投研晨会」单岗 v5 cat=fleet（研究简报员）
- `YMSt-hRNiNWXrlLYC8PSiA` 「投研晨会（官方种子）」三员级联 v4 cat=cluster（首席/宏观/行业）——**starter 引导卡与公开教程指向的正是这枚**
同作者同名 → 去尾即 409。需产品裁决：区分命名（如官方种子带「·三员级联」）、退役旧枚、或双名并存。未擅动。

## 类目→线归位（读面投影，存储零迁移）
cluster/fleet/fleet-shared→壹座 · 智能体团队 · wire/research→柏讯 · 数据与情报 · legal→识律 · 法律智能 · facet/text/doc-studio/crm/operations/business→谦面 · 业务流 · wanxing→萬星 · 智能体连接 · facade→剔除（badge 承担）。
未映射类目原样呈现；`PACK_CATEGORY_LINES` 可部署侧覆写。
